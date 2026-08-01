// ModelHub — Claude Code 多模型本地代理 (Anthropic <-> OpenAI 协议转换)
// 支持 DeepSeek / SiliconFlow / OpenRouter / 智谱 / Kimi / Gemini / Qwen / Groq 等任意 OpenAI 格式上游
// 完整支持 tool use 双向转换 (Claude Code 执行命令/读写文件依赖此功能)
// 内置 Web 管理界面 (http://localhost:4000)，支持模型选择 / 密钥配置 / 运行时热切换 / 中英文
// 内置自检 (echo 模型 + /api/selftest)，无需任何外部密钥即可验证整条链路
//
// 用法:
//   直接运行:  node lib/proxy.js
//   CLI 调用:  require('./proxy.js').start(port)
// 数据目录: ~/.modelhub/ (config.json / keys.json / state.json / modelhub.pid)

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const crypto = require('crypto');
const license = require('./license');

// ---------- 日志：stdout 自轮转（防止 proxy_stdout.log 无界膨胀，审计 B3 修复）----------
// 覆盖 console.* 写入 proxy_stdout.log；单文件超过 STDOUT_MAX(20MB) 自动滚到 .1（保留一代）。
// 这样 7x24 常驻代理即便不崩溃也能持续轮转，无需重启进程（旧方案只在 cmd 启动时轮转一次，对稳定服务无效）。
const STDOUT_LOG = path.join(__dirname, '..', 'proxy_stdout.log');
const STDOUT_MAX = 20 * 1024 * 1024; // 20MB / 代
let _stdoutBytes = 0;
try { if (fs.existsSync(STDOUT_LOG)) _stdoutBytes = fs.statSync(STDOUT_LOG).size; } catch (e) {}
function stdLog(...args) {
  const line = '[' + new Date().toISOString() + '] ' +
    args.map(a => typeof a === 'string' ? a : (a && a.stack ? a.stack : JSON.stringify(a))).join(' ') + '\n';
  try { process.stdout.write(line); } catch (e) {}
  try {
    // 每次写入前 re-stat 文件大小，防外部写入导致计数偏移
    if (fs.existsSync(STDOUT_LOG)) _stdoutBytes = fs.statSync(STDOUT_LOG).size;
  } catch (e) {}
  try {
    if (_stdoutBytes > STDOUT_MAX) {
      try { fs.renameSync(STDOUT_LOG, STDOUT_LOG + '.1'); } catch (e) {}
      _stdoutBytes = 0;
    }
    fs.appendFileSync(STDOUT_LOG, line);
    _stdoutBytes += Buffer.byteLength(line);
  } catch (e) {}
}
console.log = (...a) => stdLog(...a);
console.error = (...a) => stdLog('[error]', ...a);
console.warn = (...a) => stdLog('[warn]', ...a);
console.info = (...a) => stdLog(...a);

// 简单固定窗口速率限制：每客户端 IP 每窗口最多 RATE_MAX 请求，防本地滥用 / 上游额度耗尽（审计 B2）
const RATE_WINDOW = 1000, RATE_MAX = 6000;
const _rateBuckets = new Map();
// License tier resolved at startup / on activation. Module-scoped on purpose (was an
// implicit global before — Bug #7 — which breaks under pkg strict mode).
let _licenseTier = 'trial';
// Periodically prune expired buckets so the map cannot grow unbounded (Bug #12).
function _pruneRateBuckets() {
  const now = Date.now();
  for (const [ip, b] of _rateBuckets) if (now >= b.resetAt) _rateBuckets.delete(ip);
}
function _rateLimited(ip) {
  const now = Date.now();
  let b = _rateBuckets.get(ip);
  if (!b || now >= b.resetAt) {
    if (_rateBuckets.size > 1024) _pruneRateBuckets(); // cap memory; drop only expired entries
    b = { n: 0, resetAt: now + RATE_WINDOW };
    _rateBuckets.set(ip, b);
  }
  b.n++;
  return b.n > RATE_MAX;
}

const PORT = process.env.MODELHUB_PORT || process.env.PORT || 4000;
const DATA_DIR = path.join(os.homedir(), '.modelhub');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const KEYS_PATH = path.join(DATA_DIR, 'keys.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const PID_PATH = path.join(DATA_DIR, 'modelhub.pid');
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'assets', 'config.json');

// 资源文件定位：开发态读项目 assets/；pkg 打包后读 exe 同目录的 assets/（保证单文件分发也能加载页面）
function assetPath(name) {
  if (process.pkg) {
    const p = path.join(path.dirname(process.execPath), 'assets', name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(__dirname, '..', 'assets', name);
}

// 客户端配置文件（写入目标，跨平台；写盘逻辑见「客户端配置写入」段）
const CC_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const CX_PATH = path.join(os.homedir(), '.codex', 'config.toml');
const CC_BAK  = CC_PATH + '.bak';
const CX_BAK  = CX_PATH + '.bak';
let PROXY_URL  = 'http://127.0.0.1:' + PORT;
let AUTH_TOKEN = 'sk-local-proxy';

// ---------- 初始化数据目录 ----------
function initDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // 安全(B5): 数据目录创建时立即设置 0700 权限，缩小首次运行的时间窗口
    try { fs.chmodSync(DATA_DIR, 0o700); } catch (_) {}
  }
  if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(DEFAULT_CONFIG_PATH)) {
    fs.copyFileSync(DEFAULT_CONFIG_PATH, CONFIG_PATH);
    console.log('[ModelHub] 首次运行，已创建默认配置: ' + CONFIG_PATH);
  }
}

function resolveEnv(val) {
  if (typeof val !== 'string') return val;
  return val.replace(/\$\{([^}]+)\}/g, (m, k) => process.env[k] || '');
}

// ---------- 加载配置 ----------
function loadConfig() {
  const config = { providers: {} };
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      if (raw.auth_token) config.auth_token = String(raw.auth_token);
      for (const [name, p] of Object.entries(raw.providers || {})) {
        config.providers[name] = {
          base_url: resolveEnv(p.base_url),
          api_key: resolveEnv(p.api_key),
          models: p.models || {},
          display: p.display || name,
          region: p.region || '',
          icon: p.icon || '🔌',
          internal: false
        };
      }
    } catch (e) { console.error('[配置错误]', e.message); }
  }
  // 兜底：若环境变量里有 DEEPSEEK_KEY 则至少启用 DeepSeek
  if (Object.keys(config.providers).length === 0 && process.env.DEEPSEEK_KEY) {
    config.providers.deepseek = {
      base_url: 'https://api.deepseek.com/chat/completions', api_key: process.env.DEEPSEEK_KEY,
      models: { 'deepseek-chat': 'deepseek-chat', 'deepseek-reasoner': 'deepseek-reasoner' },
      display: 'DeepSeek', region: 'cn', icon: '🐋', internal: false
    };
  }
  // 内置自检 provider
  config.providers.echo = {
    base_url: '', api_key: '', models: { 'echo': 'echo' },
    display: 'Echo 自检', region: '', icon: '🔁', internal: true
  };
  return config;
}

let config = {};
let modelMap = {};
let state = { current: 'echo' };
let keysFile = {};
let logs = [];
let server = null;
let ACTIVE_PORT = PORT; // 实际监听端口，供 /api/selftest 自环调用使用（start(port) 可能覆盖 PORT）
const START_TIME = Date.now();

function rebuildMaps() {
  modelMap = {};
  for (const [name, p] of Object.entries(config.providers)) {
    for (const [alias, real] of Object.entries(p.models || {})) modelMap[alias] = { provider: name, upstream: real };
  }
  state.current = modelMap['deepseek-chat'] ? 'deepseek-chat' : (Object.keys(modelMap)[0] || 'echo');
}

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    if (saved && saved.current && modelMap[saved.current]) state.current = saved.current;
  } catch (e) { /* 无持久化文件，用默认 */ }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify({ current: state.current }, null, 2));
  } catch (e) { /* 忽略持久化失败 */ }
}

function loadKeys() {
  keysFile = {};
  if (fs.existsSync(KEYS_PATH)) {
    try { keysFile = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8')) || {}; } catch (e) { keysFile = {}; }
  }
}

// 安全写密钥文件：0600 权限 + 目录 0700
function saveKeysFile(keys) {
  try {
    fs.mkdirSync(path.dirname(KEYS_PATH), { recursive: true });
    // 安全(B2): 数据目录 0700 权限，密钥文件 0600，防止同一机器的其他用户读取
    try { fs.chmodSync(DATA_DIR, 0o700); } catch (_) {}
    fs.writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2));
    try { fs.chmodSync(KEYS_PATH, 0o600); } catch (_) {}
  } catch (e) { console.error('[密钥存储] 写入失败:', e.message); }
}

function effectiveKey(name) {
  if (config.providers[name] && config.providers[name].internal) return 'internal';
  if (keysFile[name]) return keysFile[name];
  const p = config.providers[name];
  return p ? p.api_key : '';
}

// 试用的 license 只允许使用 deepseek 供应商（Trial Gate）
function _trialAllowed(provider) {
  return provider === 'deepseek' || provider === 'echo';
}
function resolveProvider(model, noFallback) {
  if (model === 'default' || model === 'auto') return resolveProvider(state.current || '');
  if (modelMap[model]) {
    // Trial Gate: 试用版只能使用 deepseek/echo
    if (_licenseTier === 'trial' && !_trialAllowed(modelMap[model].provider)) {
      console.warn('[Trial Gate] 模型 ' + model + ' 需要付费许可证，当前为试用版');
      return null;
    }
    return modelMap[model];
  }
  for (const [name] of Object.entries(config.providers)) {
    if (_licenseTier === 'trial' && !_trialAllowed(name)) continue;
    if (model.startsWith(name + '-') || model.startsWith(name + '/')) return { provider: name, upstream: model.slice(name.length + 1) };
  }
  // 安全(P2): noFallback=true 时未知模型不静默回退，让调用方返回 400
  if (noFallback) return null;
  // 未知模型名 fallback 到当前激活模型
  if (state.current && modelMap[state.current]) return modelMap[state.current];
  const first = Object.keys(config.providers).find(n => !config.providers[n].internal);
  if (!first) return null;
  return { provider: first, upstream: model };
}

// ---------- 视觉模型路由（方案 B）：含图片的请求转发到支持视觉的模型 ----------
// 配置（环境变量，与 DEEPSEEK_KEY 同样的注入方式）：
//   MODELHUB_VISION_PROVIDER : 视觉模型所在 provider 名（必须已在 config.json 配置且有 key）。缺省=当前 provider。
//   MODELHUB_VISION_MODEL    : 视觉模型的上游真实名（如 deepseek-v4-flash / deepseek-ai/deepseek-vl2 / gemini-2.5-flash / qwen-vl-max）。
//                             缺省（空）= 不启用视觉路由，原样用当前模型。
// 行为：请求体含 image/image_url/input_image 且配置了视觉模型时，把该请求改发到视觉模型；
//       若视觉 provider 无 key 或不存在，则回退原模型并写日志（绝不阻断正常请求）。
const VISION_MODEL = process.env.MODELHUB_VISION_MODEL || '';
const VISION_PROVIDER = process.env.MODELHUB_VISION_PROVIDER || '';
debugLog('STARTUP', 'VISION_PROVIDER=' + JSON.stringify(VISION_PROVIDER) + ' VISION_MODEL=' + JSON.stringify(VISION_MODEL));
// 文本模型 provider（其 chat 接口不接受 image_url）绝不能作为视觉路由目标，
// 否则会把图片转发给它并触发「unknown variant image_url」导致整轮请求崩溃。
// 命中时回退为剔除图片（走原文本模型），保证请求不中断。
const VISION_INCAPABLE = new Set(['deepseek']);
function visionTarget(origProvider) {
  if (!VISION_MODEL) return null;
  const prov = VISION_PROVIDER || origProvider;
  if (!prov || !config.providers[prov]) {
    debugLog('VISION_ROUTE', 'vision provider "' + prov + '" 未在 config 中找到，回退原模型');
    return null;
  }
  if (VISION_INCAPABLE.has(prov)) {
    debugLog('VISION_ROUTE', 'vision provider "' + prov + '" 为纯文本模型、不支持图片，已剔除图片以兼容');
    return null;
  }
  const p = config.providers[prov];
  if (!p.internal && !effectiveKey(prov)) {
    debugLog('VISION_ROUTE', 'vision provider "' + prov + '" 无 key，回退原模型');
    return null;
  }
  return { provider: prov, upstream: VISION_MODEL };
}
// 取当前视觉模型配置（provider + 上游模型名），未配置/不可用时返回 null
function getVisionConfig() {
  if (!VISION_MODEL) return null;
  const prov = VISION_PROVIDER || '';
  if (!prov || !config.providers[prov] || VISION_INCAPABLE.has(prov) || (!config.providers[prov].internal && !effectiveKey(prov))) return null;
  return { provider: prov, model: VISION_MODEL };
}
// 用视觉模型把一张图描述成文字（非流式、带超时与兜底）
async function describeImage(dataUri) {
  const vc = getVisionConfig();
  if (!vc || !dataUri) return '';
  const provider = config.providers[vc.provider];
  const u = new URL(provider.base_url);
  const mod = u.protocol === 'https:' ? https : http;
  const payload = JSON.stringify({
    model: vc.model, stream: false, max_tokens: 1024,
    messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: dataUri } },
      { type: 'text', text: '请描述这张图片。先说明整体颜色与背景、主要形状与布局；再列出任何可见的文字、UI 元素、代码、报错信息或图表内容。即使是纯色或简单图形，也必须说明其颜色。若确实没有任何内容请说明。' }
    ] }]
  });
  return await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST', timeout: 120000,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + effectiveKey(vc.provider), 'Accept': 'application/json' }
    }, (up) => {
      let d = ''; up.on('data', c => d += c); up.on('end', () => {
        try {
          const j = JSON.parse(d);
          const m = j.choices && j.choices[0] && j.choices[0].message;
          const t = m ? (m.content || m.reasoning_content || '') : '';
          done((t && String(t).trim()) ? String(t).trim() : '[图片，视觉模型未返回描述]');
        } catch (e) { done('[图片，视觉模型返回无法解析]'); }
      });
    });
    req.on('error', () => done('[图片，视觉模型调用失败]'));
    req.setTimeout(120000, () => { try { req.destroy(); } catch (e) {} done('[图片，视觉模型超时]'); });
    req.write(payload); req.end();
  });
}
// 递归把 Responses API body 里的 input_image 替换为 input_text(描述)
async function describeRespImages(node) {
  if (Array.isArray(node)) { const out = []; for (const x of node) out.push(await describeRespImages(x)); return out; }
  if (node && typeof node === 'object') {
    if (node.type === 'input_image') {
      const uri = node.image_data ? ('data:' + (node.media_type || 'image/png') + ';base64,' + node.image_data) : (node.image_url || '');
      const desc = uri ? await describeImage(uri) : '';
      return { type: 'input_text', text: desc ? ('[图片内容] ' + desc) : '[图片，无法读取]' };
    }
    const out = {}; for (const k of Object.keys(node)) out[k] = await describeRespImages(node[k]); return out;
  }
  return node;
}
// 递归把 Anthropic messages 里的 image 块替换为 text(描述)
async function describeAnthropicImages(node) {
  if (Array.isArray(node)) { const out = []; for (const x of node) out.push(await describeAnthropicImages(x)); return out; }
  if (node && typeof node === 'object') {
    if (node.type === 'image') {
      const src = node.source || {};
      const uri = src.type === 'base64' && src.data ? ('data:' + (src.media_type || 'image/png') + ';base64,' + src.data)
                 : (src.type === 'url' && src.url ? src.url : '');
      const desc = uri ? await describeImage(uri) : '';
      return { type: 'text', text: desc ? ('[图片内容] ' + desc) : '[图片，无法读取]' };
    }
    const out = {}; for (const k of Object.keys(node)) out[k] = await describeAnthropicImages(node[k]); return out;
  }
  return node;
}
// 递归把 OpenAI Chat messages 里的 image_url 块替换为 text(描述)
async function describeOpenAIImages(node) {
  if (Array.isArray(node)) { const out = []; for (const x of node) out.push(await describeOpenAIImages(x)); return out; }
  if (node && typeof node === 'object') {
    if (node.type === 'image_url') {
      const uri = (node.image_url && node.image_url.url) || '';
      const desc = uri ? await describeImage(uri) : '';
      return { type: 'text', text: desc ? ('[图片内容] ' + desc) : '[图片，无法读取]' };
    }
    const out = {}; for (const k of Object.keys(node)) out[k] = await describeOpenAIImages(node[k]); return out;
  }
  return node;
}
// 递归检测请求体是否含图片（兼容 Anthropic image / OpenAI image_url / Responses input_image）
function containsImage(v) {
  if (v == null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some(containsImage);
  if (v.type === 'image' || v.type === 'image_url' || v.type === 'input_image') return true;
  return Object.values(v).some(containsImage);
}
// 剔除请求体中的图片内容块，使文本模型（如 DeepSeek）也能安全处理含图请求：
// 默认 vision 未配置时，绝不能把 image/image_url/input_image 直接发给文本模型（会 400），
// 而是删除这些块；若某条消息内容因此变空，则补一个文本占位，保证上游 body 合法、绝不阻断。
function isImagePart(x) {
  return x && typeof x === 'object' && (x.type === 'image' || x.type === 'image_url' || x.type === 'input_image');
}
function stripImages(node) {
  if (Array.isArray(node)) {
    if (node.some(isImagePart)) {
      const kept = node.filter(x => !isImagePart(x)).map(stripImages);
      return kept.length ? kept : [{ type: 'text', text: '[image omitted: no vision backend configured]' }];
    }
    return node.map(stripImages);
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node)) out[k] = stripImages(node[k]);
    return out;
  }
  return node;
}

// ---------- 活动日志 (内存环形缓冲) ----------
const MAX_LOGS = 300;
function logReq(entry) {
  logs.push(Object.assign({ t: Date.now() }, entry));
  if (logs.length > MAX_LOGS) logs.shift();
}
// 最近请求环形缓冲：进程退出/崩溃时写入 crash.log，用于定位 exit -1 前的最后流量
const MAX_RECENT = 25;
const recentReqs = [];
function noteReq(entry) { recentReqs.push(Object.assign({ t: Date.now() }, entry)); if (recentReqs.length > MAX_RECENT) recentReqs.shift(); }
// 调试日志：记录每次请求的工具集与上游真实报错，便于定位 Codex 空响应问题
const DEBUG_LOG = path.join(__dirname, '..', 'proxy_debug.log');
const DEBUG_LOG_MAX = 20 * 1024 * 1024; // 20MB 上限，超出则截断，防磁盘炸弹
const UP_DUMP = path.join(__dirname, '..', 'upstream_dump.log');
function upDump(s) { if (!process.env.MODELHUB_DEBUG_UPSTREAM) return; try { fs.appendFileSync(UP_DUMP, s); } catch (e) {} }
function debugLog(...args) {
  try {
    const line = '[' + new Date().toISOString() + '] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n';
    try { if (fs.existsSync(DEBUG_LOG) && fs.statSync(DEBUG_LOG).size > DEBUG_LOG_MAX) fs.writeFileSync(DEBUG_LOG, ''); } catch (e) {}
    fs.appendFileSync(DEBUG_LOG, line);
  } catch (e) {}
}
// 全局兜底：任何未捕获的异步异常都记录到调试日志，避免进程崩溃导致所有连接被掐断
process.on('unhandledRejection', (reason) => { debugLog('UNHANDLED_REJECTION', String(reason && reason.stack || reason)); });
process.on('uncaughtException', (err) => { debugLog('UNCAUGHT_EXCEPTION', String(err && err.stack || err)); });
// 全局崩溃捕获：任何未捕获异常/拒绝都写入调试日志再退出，避免「静默退出、GUI 无响应」难以诊断
process.on('uncaughtException', (e) => {
  try {
    const line = '[' + new Date().toISOString() + '] UNCAUGHT ' + (e && e.stack ? e.stack : e) + '\n';
    fs.appendFileSync(DEBUG_LOG, line);
  } catch (_) {}
  try { server && server.close(); } catch (_) {}
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  try {
    const line = '[' + new Date().toISOString() + '] UNHANDLED_REJECTION ' + (e && e.stack ? e.stack : e) + '\n';
    fs.appendFileSync(DEBUG_LOG, line);
  } catch (_) {}
});

// 防御性清洗工具参数 schema：DeepSeek 函数调用对 schema 较严格，
// 若 parameters 不是合法的 {type:object, properties:{}} 形态会导致上游 400，
// 这里兜底成一个合法空对象 schema，避免整轮请求被吞成空响应。
function sanitizeToolParams(p) {
  if (!p || typeof p !== 'object') return { type: 'object', properties: {} };
  const out = { type: 'object', properties: (p.properties && typeof p.properties === 'object') ? p.properties : {} };
  if (typeof p.description === 'string') out.description = p.description;
  return out;
}

// ---------- 协议转换 (Anthropic <-> OpenAI) ----------
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
  return '';
}
// Anthropic image 块 -> OpenAI image_url（支持 base64 与 url 两种 source）
function imgFromAnthropic(b) {
  if (b && b.source && b.source.type === 'base64' && b.source.data) {
    return { type: 'image_url', image_url: { url: 'data:' + (b.source.media_type || 'image/png') + ';base64,' + b.source.data } };
  }
  if (b && b.source && b.source.type === 'url' && b.source.url) {
    return { type: 'image_url', image_url: { url: b.source.url } };
  }
  return { type: 'text', text: '[image]' };
}

function convertRequest(a) {
  const messages = [];
  let system = '';
  for (const m of a.messages || []) {
    if (m.role === 'system') { system += (system ? '\n' : '') + extractText(m.content); continue; }
    if (m.role === 'user') {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
      let text = '';
      const toolMsgs = [];
      const imgParts = [];
      for (const b of blocks) {
        if (b.type === 'text') text += (text ? '\n' : '') + b.text;
        else if (b.type === 'image') imgParts.push(imgFromAnthropic(b));
        else if (b.type === 'tool_result') {
          // tool_result 内容可能含图片（如截图读回），需一并转发
          const trContent = Array.isArray(b.content) ? b.content : [{ type: 'text', text: typeof b.content === 'string' ? b.content : '' }];
          let trText = '', trImgs = [];
          for (const c of trContent) {
            if (c.type === 'text') trText += c.text;
            else if (c.type === 'image') trImgs.push(imgFromAnthropic(c));
          }
          const trParts = [...trImgs, ...(trText ? [{ type: 'text', text: trText }] : [])];
          toolMsgs.push({ role: 'tool', tool_call_id: b.tool_use_id, content: trImgs.length ? trParts : (trText || '') });
        }
      }
      // tool_result 必须紧跟在产生对应 tool_calls 的 assistant 消息之后：先发 tool 消息，再发本段文本
      for (const tm of toolMsgs) messages.push(tm);
      if (imgParts.length || text) {
        const content = [...imgParts, ...(text ? [{ type: 'text', text }] : [])];
        // 仅含纯文本时保持字符串形式，兼容更多上游；混合/纯图片用数组
        messages.push({ role: 'user', content: (content.length === 1 && content[0].type === 'text') ? text : content });
      }
    } else if (m.role === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
      let text = '';
      let reasoning = '';
      const tool_calls = [];
      for (const b of blocks) {
        if (b.type === 'text') text += (text ? '\n' : '') + b.text;
        else if (b.type === 'thinking') reasoning += (reasoning ? '\n' : '') + (b.thinking || '');
        else if (b.type === 'tool_use') tool_calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
      }
      if (!text && !reasoning && !tool_calls.length) continue; // 跳过空 assistant，避免上游 400
      const msg = { role: 'assistant' };
      if (text) msg.content = text;
      else if (!tool_calls.length) msg.content = ''; // 无文本时给空 content，满足上游对 assistant 消息的要求
      // DeepSeek 思考模式要求：多轮/工具对话必须把上一轮的 reasoning_content 原样回传，否则 400:
      // "The reasoning_content in the thinking mode must be passed back to the API"
      if (reasoning && a._provider === 'deepseek') msg.reasoning_content = reasoning;
      if (tool_calls.length) msg.tool_calls = tool_calls;
      messages.push(msg);
    }
  }
  if (a.system) {
    const s = typeof a.system === 'string' ? a.system : extractText(a.system);
    system = system ? system + '\n' + s : s;
  }
  const o = { model: a.model || 'deepseek-chat', messages: [], stream: true, max_tokens: a.max_tokens || 4096 };
  if (system) o.messages.push({ role: 'system', content: system });
  o.messages.push(...messages);
  if (a.temperature != null) o.temperature = a.temperature;
  if (a.stop) o.stop = a.stop;
  if (a.tools) o.tools = a.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } } }));
  if (a.tool_choice) {
    if (a.tool_choice.type === 'any') o.tool_choice = { type: 'required' };
    else if (a.tool_choice.type === 'none') o.tool_choice = { type: 'none' };
    else if (a.tool_choice.type === 'tool') o.tool_choice = { type: 'function', function: { name: a.tool_choice.name } };
    // 'auto' 是默认行为，不需要显式设置
  }
  return o;
}

const _sseSeqMap = new WeakMap();
function sendSSE(res, event, data) {
  let seq = _sseSeqMap.get(res) || 0;
  seq++;
  _sseSeqMap.set(res, seq);
  const d = Object.assign({ sequence_number: seq }, data);
  res.write("event: " + event + "\n");
  res.write("data: " + JSON.stringify(d) + "\n\n");
}
// 兜底：handler 抛错（含异步 rejection）时，按响应是否已开始流式来安全地结束连接，
// 杜绝“连接悬空 -> 客户端收到空/畸形 HTTP 200 -> 无限重试”的问题
function failSafe(res, status, obj) {
  try {
    if (res.writableEnded) return;
    if (!res.headersSent) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    } else {
      const ev = obj && obj.type ? obj : { type: 'error', error: (obj && obj.error) || obj };
      sendSSE(res, 'error', ev);
      if (!res.writableEnded) res.end();
    }
  } catch (e) {}
}
function pipeUpstream(upstream, a, res, complete) {
  let streamEnded = false;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  // 客户端断连时取消上游，避免浪费 API 配额
  res.on('close', () => { if (!streamEnded) { streamEnded = true; try { upstream.destroy(); } catch(e){} } });
  const msgId = 'msg_' + Date.now();
  sendSSE(res, 'message_start', { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model: a.model || 'echo', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  let textStarted = false, outputTokens = 0;
  const toolCalls = [];
  let buf = '';
  upstream.setEncoding('utf-8');
  upstream.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let json;
      try { json = JSON.parse(data); } catch (e) { continue; }
      const choice = json.choices && json.choices[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      // 推理模型: content 可能为空，优先用 content，为空时回退 reasoning_content 保证有输出
      const _piece = (delta.content && String(delta.content) !== '') ? delta.content : (delta.reasoning_content || '');
      if (_piece) {
        if (!textStarted) { sendSSE(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }); textStarted = true; }
        sendSSE(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: _piece } });
        outputTokens++;
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let slot = toolCalls[tc.index];
          if (!slot) { slot = { id: '', name: '', args: '' }; toolCalls[tc.index] = slot; }
          if (tc.id) slot.id = tc.id;
          if (tc.function && tc.function.name) slot.name = tc.function.name;
          if (tc.function && tc.function.arguments) slot.args += tc.function.arguments;
        }
      }
      if (choice.finish_reason) {
        if (textStarted) sendSSE(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        toolCalls.forEach((slot, i) => {
          if (slot.name) {
            sendSSE(res, 'content_block_start', { type: 'content_block_start', index: i + 1, content_block: { type: 'tool_use', id: slot.id || ('tool_' + i), name: slot.name, input: {} } });
            sendSSE(res, 'content_block_delta', { type: 'content_block_delta', index: i + 1, delta: { type: 'input_json_delta', partial_json: slot.args } });
            sendSSE(res, 'content_block_stop', { type: 'content_block_stop', index: i + 1 });
          }
        });
        const stop = choice.finish_reason === 'tool_calls' ? 'tool_use' : (choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn');
        sendSSE(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outputTokens } });
        sendSSE(res, 'message_stop', { type: 'message_stop' });
        streamEnded = true;
        res.end();
        if (complete) complete('ok', null);
      }
    }
  });
  upstream.on('end', () => {
    if (streamEnded || res.writableEnded) return; // finish_reason 已正常结束，避免重复 SSE
    if (!textStarted) {
      // 流被截断但从未收到任何 content，发 error 而非空 message_stop
      sendSSE(res, 'error', { type: 'error', error: { type: 'api_error', message: '上游流被截断，未收到任何响应内容' } });
      streamEnded = true; res.end(); if (complete) complete('error', 'stream truncated');
      return;
    }
    sendSSE(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    sendSSE(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } });
    sendSSE(res, 'message_stop', { type: 'message_stop' });
    streamEnded = true;
    res.end();
    if (complete) complete('ok', null);
  });
  upstream.on('error', (e) => {
    if (streamEnded || res.writableEnded) { if (complete) complete('error', e.message); return; }
    sendSSE(res, 'error', { type: 'error', error: { type: 'api_error', message: e.message } });
    res.end();
    if (complete) complete('error', e.message);
  });
}

function makeEchoStream() {
  const frames = [
    JSON.stringify({ choices: [{ delta: { content: '[Echo 自检] 代理链路正常：Anthropic→OpenAI 转换、tool_use 回写均工作。' }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_echo1', function: { name: 'echo_tool', arguments: '{"received":true}' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    '[DONE]'
  ];
  return Readable.from(frames.map(f => 'data: ' + f + '\n\n'));
}

async function handleMessages(a, res) {
  const started = Date.now();
  const modelName = a.model || '';
  const isExplicit = modelName && modelName !== 'default' && modelName !== 'auto';
  let target = resolveProvider(modelName, isExplicit); // 安全(P2): 显式指定未知模型名时不静默回退
  let done = false;
  function complete(status, err) {
    if (done) return; done = true;
    logReq({ type: 'message', model: a.model || '', provider: target ? target.provider : null, status, err: err || null, ms: Date.now() - started });
  }
  function sendErr(statusCode, type, message) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ type: 'error', error: { type, message } }));
  }
  if (!target) {
    const explicitHint = isExplicit && modelName ? ('未知模型名 "' + modelName + '"，可用: ' + Object.keys(modelMap).join(', ')) : '没有配置任何 provider';
    sendErr(400, 'invalid_request_error', '请检查 config.json 或设置 DEEPSEEK_KEY。' + explicitHint);
    complete('error', 'no provider'); return;
  }
  // 方案 B（修订）：用视觉模型把图片描述成文字、回填进原请求，原文本模型继续作答
  // （不再整体改发视觉模型——截图常作为 function_call_output 返回，视觉上游拒绝在 tool 消息里带 image_url）
  if (containsImage(a)) {
    const vc = getVisionConfig();
    if (vc) {
      debugLog('VISION_DESCRIBE', 'messages', modelName || '', '->', vc.provider + '/' + vc.model);
      a = await describeAnthropicImages(a);
    } else {
      debugLog('VISION_ROUTE', 'messages: 含图片但未启用视觉路由，已剔除图片以兼容文本模型（配置 MODELHUB_VISION_MODEL 可启用图片理解）'); a = stripImages(a);
    }
  }
  const provider = config.providers[target.provider];
  if (!provider.internal && !effectiveKey(target.provider)) {
    sendErr(401, 'authentication_error', 'provider [' + target.provider + '] 缺少 API key，请在界面填写或运行 modelhub keys set ' + target.provider + ' <KEY>');
    complete('error', 'missing key'); return;
  }
  if (provider.internal && target.provider === 'echo') {
    pipeUpstream(makeEchoStream(), a, res, complete);
    return;
  }
  const openaiReq = convertRequest(Object.assign({}, a, { model: target.upstream, _provider: target.provider }));
  const body = JSON.stringify(openaiReq);
  const u = new URL(provider.base_url);
  const mod = u.protocol === 'https:' ? https : http;
  const options = {
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + effectiveKey(target.provider), 'Accept': 'text/event-stream' }
  };
  const req = mod.request(options, (upstream) => {
    if (upstream.statusCode && upstream.statusCode >= 400) {
      let eb = '';
      upstream.on('data', c => eb += c);
      upstream.on('end', () => { sendErr(502, 'upstream_error', '上游(' + target.provider + ') 返回 HTTP ' + upstream.statusCode + ': ' + eb.slice(0, 800)); complete('error', eb.slice(0, 200)); });
      return;
    }
    pipeUpstream(upstream, a, res, complete);
  });
  req.setTimeout(180000, () => { req.destroy(); });
  req.on('error', (e) => { sendErr(500, 'api_error', e.message); complete('error', e.message); });
  req.write(body);
  req.end();
}

// 原生 OpenAI Chat Completions 透传：供 Codex / 任意 OpenAI 客户端使用
// 输入已是 OpenAI 格式，只需解析 model 别名、注入供应商 key，直接转发上游 SSE/JSON
async function handleChatCompletions(body, res) {
  const started = Date.now();
  const modelName = body.model || '';
  const isExplicit = modelName && modelName !== 'default' && modelName !== 'auto';
  let target = resolveProvider(modelName, isExplicit);
  let done = false;
  function complete(status, err) {
    if (done) return; done = true;
    logReq({ type: 'chat', model: body.model || '', provider: target ? target.provider : null, status, err: err || null, ms: Date.now() - started });
  }
  function sendErr(statusCode, message) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message, type: 'invalid_request_error' } }));
  }
  if (!target) {
    const explicitHint = isExplicit && modelName ? ('未知模型名 "' + modelName + '"，可用: ' + Object.keys(modelMap).join(', ')) : '没有配置任何 provider';
    sendErr(400, '请检查 config.json 或设置对应环境变量。' + explicitHint);
    complete('error', 'no provider'); return;
  }
  // 方案 B（修订）：用视觉模型把图片描述成文字、回填进原请求，原文本模型继续作答
  if (containsImage(body)) {
    const vc = getVisionConfig();
    if (vc) {
      debugLog('VISION_DESCRIBE', 'chat', body.model || '', '->', vc.provider + '/' + vc.model);
      body = await describeOpenAIImages(body);
    } else {
      debugLog('VISION_ROUTE', 'chat: 含图片但未启用视觉路由，已剔除 image_url 以兼容文本模型（配置 MODELHUB_VISION_MODEL 可启用图片理解）'); body = stripImages(body);
    }
  }
  const provider = config.providers[target.provider];
  if (provider.internal) { sendErr(400, 'echo 自检模型不支持原生 OpenAI Chat Completions 接口，请选择真实模型 (如 deepseek-chat)'); complete('error', 'echo unsupported'); return; }
  if (!effectiveKey(target.provider)) {
    sendErr(401, 'provider [' + target.provider + '] 缺少 API key，请运行 modelhub keys set ' + target.provider + ' <KEY> 或在界面填写');
    complete('error', 'missing key'); return;
  }
  const fwd = body; // body already transformed above (vision strip/describe); only read afterward, no deep copy needed (Bug #13)
  fwd.model = target.upstream; // 别名 -> 上游真实模型名
  const u = new URL(provider.base_url);
  const mod = u.protocol === 'https:' ? https : http;
  const options = {
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + effectiveKey(target.provider), 'Accept': body.stream ? 'text/event-stream' : 'application/json' }
  };
  const req = mod.request(options, (upstream) => {
    if (upstream.statusCode && upstream.statusCode >= 400) {
      let eb = '';
      upstream.on('data', c => eb += c);
      upstream.on('end', () => {
        const msg = '上游(' + target.provider + ') 返回 HTTP ' + upstream.statusCode + ': ' + eb.slice(0, 800);
        if (!body.stream) { sendErr(upstream.statusCode, msg); }
        else { res.writeHead(upstream.statusCode, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: { message: msg, type: 'upstream_error' } })); }
        complete('error', msg);
      });
      return;
    }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.on('close', () => { try { req.destroy(); } catch(e){} if (!res.writableEnded) complete('error', 'client disconnected'); });
      upstream.pipe(res);
      upstream.on('end', () => { if (!res.writableEnded) res.end(); complete('ok', null); });
      upstream.on('error', (e) => { if (!res.writableEnded) res.end(); complete('error', e.message); });
    } else {
      let data = '';
      upstream.on('data', c => data += c);
      upstream.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(data); complete('ok', null); });
      upstream.on('error', (e) => { sendErr(500, e.message); complete('error', e.message); });
    }
  });
  req.setTimeout(180000, () => { req.destroy(); sendErr(504, '上游(' + target.provider + ') 180s 无响应（超时）'); complete('error', 'upstream timeout'); });
  req.write(JSON.stringify(fwd));
  req.end();
}

// 递归清洗：把任何层级的 input_image 替换为文本占位符
// DeepSeek API 纯文本模型不支持 image_url，input_image 原样透传会导致
// "unknown variant `input_image`, expected `text`" 反序列化错误
function sanitizeOutput(v) {
  if (v == null) return v;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    // 如果数组里只有一项且是 input_image，直接返回占位符字符串
    const hasImage = v.some(p => p && typeof p === 'object' && p.type === 'input_image');
    if (hasImage) {
      // 保留非图片部分，图片替换为占位符
      return v.map(p => {
        if (p && typeof p === 'object') {
          if (p.type === 'input_image') return { type: 'image_url', image_url: { url: 'data:' + (p.media_type || 'image/png') + ';base64,' + (p.image_data || '') } };
          if (p.type === 'input_text' || p.type === 'output_text') return { type: 'text', text: p.text || '' };
        }
        return sanitizeOutput(p);
      });
    }
    return v.map(p => sanitizeOutput(p));
  }
  if (typeof v === 'object') {
    if (v.type === 'input_image') {
      return { type: 'image_url', image_url: { url: 'data:' + (v.media_type || 'image/png') + ';base64,' + (v.image_data || '') } };
    }
    if (v.type === 'input_text' || v.type === 'output_text') {
      return { type: 'text', text: v.text || '' };
    }
    // 递归处理对象的所有属性
    const out = {};
    for (const k of Object.keys(v)) {
      out[k] = sanitizeOutput(v[k]);
    }
    return out;
  }
  return v;
}

// OpenAI Responses API 透传：供新版 Codex (wire_api="responses") 使用
// 上游供应商 (DeepSeek 等) 仅支持 Chat Completions，故在此做 Responses<->Chat 双向转换
function respItemToChat(item, messages) {
  if (typeof item === 'string') { messages.push({ role: 'user', content: item }); return; }
  if (item.type === 'function_call_output') {
    const _out = sanitizeOutput(item.output);
    messages.push({ role: 'tool', tool_call_id: item.call_id, content: (typeof _out === 'string' || Array.isArray(_out)) ? _out : JSON.stringify(_out) });
    return;
  }
  if (item.type === 'function_call') {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: item.call_id || ('call_' + crypto.randomBytes(8).toString('hex')), type: 'function', function: { name: item.name, arguments: item.arguments || '{}' } }] });
    return;
  }
  const role = item.role;
  if (!role) return;
  if (role === 'developer') {
    let text = '';
    const content = item.content;
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) for (const part of content) { if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') text += part.text; else if (part.type === 'input_image') text += ' [image] '; }
    messages.push({ role: 'system', content: text });
    return;
  }
  const content = item.content;
  if (typeof content === 'string') { messages.push({ role, content }); return; }
  if (Array.isArray(content)) {
    let text = '';
    const toolCalls = [];
    const imgParts = [];
    for (const part of content) {
      if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') text += part.text;
      else if (part.type === 'input_image') imgParts.push({ type: 'image_url', image_url: { url: 'data:' + (part.media_type || 'image/png') + ';base64,' + (part.image_data || '') } });
      else if (part.type === 'function_call') toolCalls.push({ id: part.call_id || ('call_' + crypto.randomBytes(8).toString('hex')), type: 'function', function: { name: part.name, arguments: part.arguments || '{}' } });
    }
    if (toolCalls.length) messages.push({ role, content: text || null, tool_calls: toolCalls });
    else if (imgParts.length) messages.push({ role, content: [...imgParts, ...(text ? [{ type: 'text', text }] : [])] });
    else if (text) messages.push({ role, content: text });
    return;
  }
  if (content != null) messages.push({ role, content: String(content) });
}

function responsesToChat(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });
  const input = body.input;
  const items = typeof input === 'string' ? [{ role: 'user', content: input }] : (input || []);
  let pendingCalls = []; // 同一 assistant 轮次的多个 function_call 需合并为一条 assistant 消息
  let pendingReasoning = ''; // 累积上一轮 thinking，回传给 DeepSeek（思考模式硬性要求）
  function flushCalls() {
    if (!pendingCalls.length) { pendingReasoning = ''; return; }
    const m = { role: 'assistant', content: null, tool_calls: pendingCalls.map(c => ({ id: c.id || ('call_' + crypto.randomBytes(8).toString('hex')), type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) };
    if (pendingReasoning && body._provider === 'deepseek') m.reasoning_content = pendingReasoning;
    messages.push(m);
    pendingReasoning = '';
    pendingCalls = [];
  }
  for (const it of items) {
    if (typeof it === 'string') { flushCalls(); messages.push({ role: 'user', content: it }); continue; }
    if (it.type === 'input_image') { flushCalls(); messages.push({ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:' + (it.media_type || 'image/png') + ';base64,' + (it.image_data || '') } }] }); continue; }
    if (it.type === 'function_call') {
      // 缓冲，直到遇到 tool 结果或普通消息才落盘，确保同一轮次的 call 合并到一条 assistant 消息
      pendingCalls.push({ id: it.call_id, name: it.name, args: it.arguments });
      continue;
    }
    if (it.type === 'thinking') { pendingReasoning += (pendingReasoning ? '\n' : '') + (it.thinking || it.text || ''); continue; }
    if (it.type === 'function_call_output') {
      flushCalls(); // assistant(tool_calls) 必须紧接对应的 tool 消息，否则上游会 400 拒答
      const _out = sanitizeOutput(it.output);
      messages.push({ role: 'tool', tool_call_id: it.call_id, content: (typeof _out === 'string' || Array.isArray(_out)) ? _out : JSON.stringify(_out) });
      continue;
    }
    flushCalls();
    const role = it.role;
    if (!role) continue;
    if (role === 'developer') {
      let text = '';
      const content = it.content;
      const imgParts = [];
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) for (const p of content) { if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') text += p.text; else if (p.type === 'input_image') imgParts.push({ type: 'image_url', image_url: { url: p.image_url || 'data:' + (p.media_type || 'image/png') + ';base64,' + (p.image_data || '') } }); }
      const sysContent = imgParts.length ? [...imgParts, ...(text ? [{ type: 'text', text }] : [])] : text;
      messages.push({ role: 'system', content: sysContent });
      continue;
    }
    const content = it.content;
    if (typeof content === 'string') { messages.push({ role, content }); continue; }
    if (Array.isArray(content)) {
      let text = '';
      let reasoning = '';
      const toolCalls = [];
      const imgParts = [];
      for (const p of content) {
        if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') text += p.text;
        else if (p.type === 'thinking' || p.type === 'reasoning') reasoning += (reasoning ? '\n' : '') + (p.thinking || p.reasoning || p.text || '');
        else if (p.type === 'input_image') imgParts.push({ type: 'image_url', image_url: { url: p.image_url || 'data:' + (p.media_type || 'image/png') + ';base64,' + (p.image_data || '') } });
        else if (p.type === 'function_call') toolCalls.push({ id: p.call_id || ('call_' + crypto.randomBytes(8).toString('hex')), type: 'function', function: { name: p.name, arguments: p.arguments || '{}' } });
      }
      const rc = ((reasoning || pendingReasoning) && body._provider === 'deepseek') ? (reasoning || pendingReasoning) : undefined;
      if (toolCalls.length) { const m = { role, content: text || null, tool_calls: toolCalls }; if (rc) m.reasoning_content = rc; messages.push(m); }
      else if (imgParts.length) { const m = { role, content: [...imgParts, ...(text ? [{ type: 'text', text }] : [])] }; if (rc) m.reasoning_content = rc; messages.push(m); }
      else if (text || rc) { const m = { role, content: text || '' }; if (rc) m.reasoning_content = rc; messages.push(m); }
      pendingReasoning = '';
      continue;
    }
    if (content != null) messages.push({ role, content: String(content) });
  }
  flushCalls();
  // 去除连续完全相同的消息（Codex 偶发重复推送同一 user 消息）
  const collapsed = [];
  for (const m of messages) {
    const last = collapsed[collapsed.length - 1];
    if (last && JSON.stringify(last) === JSON.stringify(m)) continue;
    collapsed.push(m);
  }
  const o = { model: body.model, messages: collapsed, stream: !!body.stream };
  if (body.tools) o.tools = body.tools.filter(t => (t.type === 'function' || !t.type)).map(t => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: sanitizeToolParams(t.parameters) } }));
  if (body.temperature != null) o.temperature = body.temperature;
  if (body.top_p != null) o.top_p = body.top_p;
  if (body.max_output_tokens != null) o.max_tokens = body.max_output_tokens;
  if (body.tool_choice) o.tool_choice = body.tool_choice;
  if (body.parallel_tool_calls != null) o.parallel_tool_calls = body.parallel_tool_calls;
  return o;
}

function chatMsgToRespItem(message) {
  if (message.tool_calls && message.tool_calls.length) {
    return message.tool_calls.map(tc => ({ type: 'function_call', call_id: tc.id || ('call_' + crypto.randomBytes(8).toString('hex')), status: 'completed', name: tc.function.name, arguments: tc.function.arguments || '{}' }));
  }
  // 推理模型(DeepSeek V4 等)将最终答案放在 reasoning_content，content 可能为空；为空时回退到 reasoning_content，避免返回空消息
  const _text = (message.content && String(message.content).trim()) ? String(message.content) : (message.reasoning_content || '');
  return { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: _text, annotations: [] }] };
}

async function handleResponses(body, res) {
  const started = Date.now();
  const modelName = body.model || '';
  const isExplicit = modelName && modelName !== 'default' && modelName !== 'auto';
  let target = resolveProvider(modelName, isExplicit);
  debugLog('REQ', body.model, 'provider=' + (target ? target.provider : 'NONE'),
    'tools=' + (body.tools ? body.tools.length : 0),
    'toolNames=' + (body.tools ? body.tools.map(t => t.name).join(',') : '-'),
    'instrLen=' + (body.instructions ? body.instructions.length : 0),
    'inputLen=' + (typeof body.input === 'string' ? body.input.length : (body.input ? body.input.length : 0)));
  let done = false;
  function complete(status, err) {
    if (done) return; done = true;
    debugLog('DONE', body.model, 'status=' + status, 'ms=' + (Date.now() - started), 'err=' + (err || ''));
    logReq({ type: 'responses', model: body.model || '', provider: target ? target.provider : null, status, err: err || null, ms: Date.now() - started });
  }
  function sendErr(statusCode, message) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message, type: 'invalid_request_error' } }));
  }
  if (!target) {
    const explicitHint = isExplicit && modelName ? ('未知模型名 "' + modelName + '"，可用: ' + Object.keys(modelMap).join(', ')) : '没有配置任何 provider';
    sendErr(400, '请检查 config.json。' + explicitHint); complete('error', 'no provider'); return;
  }
  // 方案 B（修订）：用视觉模型把图片描述成文字、回填进原请求，原文本模型继续作答
  if (containsImage(body)) {
    const vc = getVisionConfig();
    if (vc) {
      debugLog('VISION_DESCRIBE', 'responses', body.model || '', '->', vc.provider + '/' + vc.model);
      body = await describeRespImages(body);
    } else {
      debugLog('VISION_ROUTE', 'responses: 含图片但未启用视觉路由，已剔除图片以兼容文本模型（配置 MODELHUB_VISION_MODEL 可启用图片理解）'); body = stripImages(body);
    }
  }
  const provider = config.providers[target.provider];
  if (provider.internal) { sendErr(400, 'echo 自检模型不支持 Responses API，请选择真实模型'); complete('error', 'echo unsupported'); return; }
  if (!effectiveKey(target.provider)) { sendErr(401, 'provider [' + target.provider + '] 缺少 API key，请运行 modelhub keys set ' + target.provider + ' <KEY>'); complete('error', 'missing key'); return; }
  const chatBody = responsesToChat(Object.assign({}, body, { _provider: target.provider }));
  chatBody.model = target.upstream;
  const u = new URL(provider.base_url);
  const mod = u.protocol === 'https:' ? https : http;
  const options = {
    hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + effectiveKey(target.provider), 'Accept': body.stream ? 'text/event-stream' : 'application/json' }
  };
  // 落盘最近一次请求体，便于精确复现 Codex 真实请求（排查空响应用）
  // 安全(B1): 默认【不】写盘，避免完整请求体(system prompt/对话历史/工具参数)泄露进仓库。
  // 仅当显式设置 MODELHUB_DEBUG=1 才落盘，且写入数据目录 ~/.modelhub/（在仓库之外，天然不会被 git 提交）。
  if (process.env.MODELHUB_DEBUG) {
    try { fs.writeFileSync(path.join(DATA_DIR, 'last_request.json'), JSON.stringify(body).slice(0, 200000)); } catch (e) {}
  }
  const rid = 'resp_' + Date.now();
  const req = mod.request(options, (upstream) => {
    // 上游超时保护：DeepSeek 在大请求下可能挂起，必须有上限，否则代理与客户端一起无限挂起 → “无响应”
    req.setTimeout(180000, () => {
      if (res.writableEnded) { complete('error', 'upstream timeout'); return; }
      debugLog('UPSTREAM_TIMEOUT', body.model, target ? target.provider : '?');
      try {
        if (!res.headersSent) {
          if (body.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
            sendSSE(res, 'response.failed', { type: 'response.failed', response: { id: rid, object: 'response', status: 'failed', error: { message: '上游(' + (target ? target.provider : '?') + ') 180s 内无响应（超时）' } } });
          } else {
            sendErr(504, '上游(' + (target ? target.provider : '?') + ') 180s 内无响应（超时）');
          }
        } else {
          sendSSE(res, 'response.failed', { type: 'response.failed', response: { id: rid, object: 'response', status: 'failed', error: { message: '上游超时（180s 无响应）' } } });
        }
        res.end();
      } catch (e2) {}
      req.destroy();
      complete('error', 'upstream timeout');
    });
    if (upstream.status && upstream.status >= 400) {
      if (res.writableEnded) { upstream.resume(); return; } // 超时已处理，只 drain 上游不写客户端
      let eb = '';
      upstream.on('data', c => eb += c);
      upstream.on('end', () => {
        const msg = '上游(' + target.provider + ') 返回 HTTP ' + upstream.status + ': ' + eb.slice(0, 800);
        debugLog('UPSTREAM_ERROR', body.model, target.provider, upstream.status, eb.slice(0, 800));
        if (!body.stream) { sendErr(upstream.status, msg); }
        else {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
          sendSSE(res, 'response.failed', { type: 'response.failed', response: { id: rid, object: 'response', status: 'failed', error: { message: msg } } });
          res.end();
        }
        complete('error', msg);
      });
      return;
    }
    if (!body.stream) {
      let data = '';
      upstream.on('data', c => data += c);
      upstream.on('end', () => {
        try {
          const chatResp = JSON.parse(data);
          const choice = chatResp.choices && chatResp.choices[0];
          if (!choice || !choice.message) { sendErr(502, '上游响应无 choice/message'); complete('error', 'no choice'); return; }
          const items = chatMsgToRespItem(choice.message);
          const resp = {
            id: rid, object: 'response', created_at: Math.floor(Date.now() / 1000), model: body.model, status: 'completed',
            output: (Array.isArray(items) ? items : [items]),
            usage: chatResp.usage ? { input_tokens: chatResp.usage.prompt_tokens || 0, output_tokens: chatResp.usage.completion_tokens || 0, total_tokens: chatResp.usage.total_tokens || 0 } : { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
          };
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(resp));
          complete('ok', null);
        } catch (e) { sendErr(500, '上游响应解析失败: ' + e.message); complete('error', e.message); return; }
      });
      upstream.on('error', e => { sendErr(500, e.message); complete('error', e.message); });
      return;
    }
    // 流式：把上游 Chat SSE 转成 Responses SSE 事件
    let streamEnded = false;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.on('close', () => { if (!streamEnded) { streamEnded = true; try { req.destroy(); } catch(e){} } });
    sendSSE(res, 'response.created', { type: 'response.created', response: { id: rid, object: 'response', created_at: Math.floor(Date.now() / 1000), model: body.model, status: 'in_progress', output: [], tools: body.tools || [], instructions: body.instructions || null } });
    sendSSE(res, 'response.in_progress', { type: 'response.in_progress', response: { id: rid, status: 'in_progress' } });
    let buf = '';
    let textStarted = false, textAcc = '', sawSSE = false;
    const toolSlots = [];
    function finalize() {
      if (streamEnded) return;
      debugLog('FINALIZE', body.model, 'textStarted=' + textStarted, 'textAccLen=' + textAcc.length, 'toolSlots=' + toolSlots.length, 'toolNames=' + toolSlots.map(s => s.name).join(','));
      const outputItems = [];
      if (textStarted) {
        const textItem = { id: 'item_' + rid, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: textAcc, annotations: [] }] };
        outputItems.push(textItem);
        sendSSE(res, 'response.output_text.done', { type: 'response.output_text.done', item_id: 'item_' + rid, output_index: 0, content_index: 0, text: textAcc });
        sendSSE(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: textItem });
      }
      let outIndex = textStarted ? 1 : 0;
      toolSlots.forEach(slot => {
        if (!slot.name) return;
        const cid = slot.id || ('call_' + crypto.randomBytes(8).toString('hex'));
        const item = { id: 'item_' + cid, type: 'function_call', call_id: cid, status: 'completed', name: slot.name, arguments: slot.args };
        outputItems.push(item);
        sendSSE(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: outIndex, item: { id: 'item_' + cid, type: 'function_call', call_id: cid, status: 'completed', name: slot.name, arguments: '' } });
        sendSSE(res, 'response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'item_' + cid, delta: slot.args });
        sendSSE(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: outIndex, item: item });
        outIndex++;
      });
      sendSSE(res, 'response.completed', { type: 'response.completed', response: { id: rid, object: 'response', created_at: Math.floor(Date.now() / 1000), model: body.model, status: 'completed', output: outputItems, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
      streamEnded = true;
      res.end();
      complete('ok', null);
    }
    upstream.setEncoding('utf-8');
    upstream.on('data', chunk => {
      try {
      upDump(chunk);
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        sawSSE = true;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let json; try { json = JSON.parse(data); } catch (e) { continue; }
        if (json.error) {
          const msg = '上游(' + (target ? target.provider : '?') + '): ' + (json.error.message || 'error');
          debugLog('UPSTREAM_SSE_ERROR', body.model, msg);
          if (!res.writableEnded) { sendSSE(res, 'response.failed', { type: 'response.failed', response: { id: rid, object: 'response', status: 'failed', error: { message: msg } } }); res.end(); }
          streamEnded = true; complete('error', 'upstream sse error'); return;
        }
        const choice = json.choices && json.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        // 推理模型: content 可能为空，优先用 content，为空时回退 reasoning_content 保证有输出
        const _piece = (delta.content && String(delta.content) !== '') ? delta.content : (delta.reasoning_content || '');
        if (_piece) {
          if (!textStarted) {
            textStarted = true;
            sendSSE(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'item_' + rid, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '', annotations: [] }] } });
            sendSSE(res, 'response.content_part.added', { type: 'response.content_part.added', item_id: 'item_' + rid, content_index: 0, part: { type: 'text', text: '' } });
          }
          sendSSE(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: 'item_' + rid, output_index: 0, content_index: 0, delta: _piece });
          textAcc += _piece;
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            let slot = toolSlots[tc.index];
            if (!slot) { slot = { id: '', name: '', args: '', index: tc.index }; toolSlots[tc.index] = slot; }
            if (tc.id) slot.id = tc.id;
            if (tc.function && tc.function.name) slot.name = tc.function.name;
            if (tc.function && tc.function.arguments) slot.args += tc.function.arguments;
          }
        }
        if (choice.finish_reason) finalize();
      }
      } catch (e) {
        debugLog('STREAM_PARSE_ERROR', body.model, e.message);
        if (!res.writableEnded) {
          sendSSE(res, 'response.failed', { type: 'response.failed', response: { id: rid, object: 'response', status: 'failed', error: { message: '流式解析异常: ' + e.message } } });
          res.end();
        }
        complete('error', 'stream parse: ' + e.message);
      }
    });
    upstream.on('end', () => {
      if (streamEnded) return;
      if (!sawSSE) {
        const trimmed = buf.trim();
        let errMsg = '上游(' + (target ? target.provider : '?') + ') 返回了非 SSE 响应（可能出错）';
        if (trimmed.startsWith('{')) {
          try { const j = JSON.parse(trimmed); if (j.error && j.error.message) errMsg = '上游(' + (target ? target.provider : '?') + '): ' + j.error.message; } catch (e) {}
        }
        debugLog('UPSTREAM_NON_SSE', body.model, target ? target.provider : '?', trimmed.slice(0, 500));
        if (!res.writableEnded) { sendSSE(res, 'response.failed', { type: 'response.failed', response: { id: rid, object: 'response', status: 'failed', error: { message: errMsg } } }); res.end(); }
        streamEnded = true; complete('error', 'upstream non-sse');
        return;
      }
      finalize();
    });
    upstream.on('error', e => { if (streamEnded || res.writableEnded) { complete('error', e.message); return; } sendSSE(res, 'response.failed', { type: 'response.failed', response: { id: rid, status: 'failed', error: { message: e.message } } }); res.end(); complete('error', e.message); });
  });
  req.on('error', e => { sendErr(500, e.message); complete('error', e.message); });
  req.write(JSON.stringify(chatBody));
  req.end();
}

// ---------- Web 界面 & API ----------
// 内容安全策略：动态绑定当前端口（ACTIVE_PORT），端口变化时管理页面 API 调用不会被 CSP 拦截
function cspHeader() {
  return "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' http://127.0.0.1:" + ACTIVE_PORT + "; frame-ancestors 'none'";
}

// 友好中文管理面板 start.html（每次读盘，便于修改即时生效；pkg 下读 exe 同目录）
function serveStart(res) {
  const p = assetPath('start.html');
  fs.readFile(p, 'utf-8', (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>start.html 未找到</h1><p>路径: ' + p + '</p><p>请将 assets/ 目录放在代理程序同目录下。</p>');
      return;
    }
    // 注入真实 AUTH_TOKEN 到 Web UI，使得页面内 JS 能自动附带鉴权头
    data = data.replace(/\/\*__AUTH_TOKEN__\*\/\s*const\s+AUTH\s*=\s*'[^']*'/, "const AUTH = '" + AUTH_TOKEN.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'");
    // 注入实际端口到 HTML 的 CSP meta 标签
    data = data.replace(/connect-src 'self' http:\/\/127\.0\.0\.1:\d+/g, "connect-src 'self' http://127.0.0.1:" + ACTIVE_PORT);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': cspHeader() });
    res.end(data);
  });
}

// 首屏欢迎/激活页 welcome.html：未授权用户第一眼看到的内容（先看见东西，再填许可）
function serveWelcome(res) {
  const p = assetPath('welcome.html');
  fs.readFile(p, 'utf-8', (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>welcome.html 未找到</h1><p>路径: ' + p + '</p><p>请将 assets/ 目录放在代理程序同目录下。</p>');
      return;
    }
    // 注入实际端口到 HTML 的 CSP（保持与 serveStart 一致）
    data = data.replace(/connect-src 'self' http:\/\/127\.0\.0\.1:\d+/g, "connect-src 'self' http://127.0.0.1:" + ACTIVE_PORT);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': cspHeader() });
    res.end(data);
  });
}

// 通用静态页面服务（如 free-models.html 免费模型额度说明页），每次读盘、随代理同源托管
function serveAsset(res, name) {
  const p = assetPath(name);
  fs.readFile(p, 'utf-8', (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>' + name + ' 未找到</h1><p>路径: ' + p + '</p>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': cspHeader() });
    res.end(data);
  });
}

// CORS：动态绑定当前端口，仅允许本机 Web UI 页面
function cors(res, req) {
  const origin = req && req.headers && req.headers.origin;
  const allowedOrigin = 'http://127.0.0.1:' + ACTIVE_PORT;
  const localOrigin = 'http://localhost:' + ACTIVE_PORT;
  // 安全(B1): 移除了 null origin，防止 file:// HTML / 任意本机程序诱导调用
  const allowed = origin && (origin === allowedOrigin || origin === localOrigin);
  res.setHeader('Access-Control-Allow-Origin', allowed ? origin : allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

// 管理 API 鉴权：除 /health 和 API 转发端点外，所有 /api/* 需要 Bearer token
function requireAuth(req, res) {
  const auth = req.headers['authorization'] || '';
  if (auth === 'Bearer ' + AUTH_TOKEN) return true;
  // Web UI 的 Cookie/会话 token（管理页面自动携带 Authorization header）
  res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'unauthorized', message: '请设置 Authorization: Bearer <token> 头，token 可在启动日志或 ~/.modelhub/config.json 的 auth_token 字段中找到' }));
  return false;
}
function sendJSON(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    let ended = false;
    const MAX_BODY = 10 * 1024 * 1024;
    req.on('data', c => { if (Buffer.byteLength(b) > MAX_BODY) { req.destroy(); return; } b += c; });
    req.on('end', () => { ended = true; try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => { if (!ended) { ended = true; resolve({}); } });
    req.on('close', () => { if (!ended) { ended = true; resolve({}); } });
  });
}
// 安全的 raw body 读取器，与 readBody 相同但返回原始字符串，供外部 try/catch 使用
function readBodySafe(req) {
  return new Promise((resolve) => {
    let b = '';
    let ended = false;
    const MAX_BODY = 10 * 1024 * 1024;
    req.on('data', c => { if (Buffer.byteLength(b) > MAX_BODY) { req.destroy(); return; } b += c; });
    req.on('end', () => { ended = true; resolve(b || '{}'); });
    req.on('error', () => { if (!ended) { ended = true; resolve('{}'); } });
    req.on('close', () => { if (!ended) { ended = true; resolve('{}'); } });
  });
}

// ---------- 客户端配置文件写入（settings.json / config.toml） ----------
// 仅首次写入前备份「最初」版本，后续写入不覆盖 .bak（保证「恢复」永远回到用户最初状态）
function backupOnce(orig, bak) {
  try {
    if (!fs.existsSync(bak) && fs.existsSync(orig)) fs.copyFileSync(orig, bak);
  } catch (e) { /* 备份失败不阻断主流程 */ }
}

// 原子写：先写临时文件再 rename，避免半截写入损坏原配置
function atomicWrite(p, content) {
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
}

// Claude Code：合并修改 settings.json 的 env（不动其它顶层字段、不动 env 中其它 key）
function writeClaudeSettings() {
  const existed = fs.existsSync(CC_PATH);
  backupOnce(CC_PATH, CC_BAK);
  const envKeys = {
    ANTHROPIC_API_URL: PROXY_URL,
    ANTHROPIC_BASE_URL: PROXY_URL,
    ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN,
    ANTHROPIC_MODEL: 'default',
    ANTHROPIC_SMALL_FAST_MODEL: 'default',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'default',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'default',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'default',
    CLAUDE_CODE_SUBAGENT_MODEL: 'default'
  };
  let cfg = {};
  if (existed) {
    const raw = fs.readFileSync(CC_PATH, 'utf-8');
    try { cfg = JSON.parse(raw); }
    catch (e) {
      // 安全(B3): JSON 解析失败时拒绝写入并展示详细错误，防止一次误触丢失原有配置/注释
      const err = new Error('Claude Code 配置文件 (settings.json) 解析失败: ' + e.message + '。请手动修复该文件后再重试。');
      err.code = 'JSON_PARSE_ERROR';
      throw err;
    }
  }
  cfg.env = Object.assign({}, cfg.env || {}, envKeys); // 仅合并 ModelHub key
  atomicWrite(CC_PATH, JSON.stringify(cfg, null, 2));
  return { path: CC_PATH, created: !existed };
}

// Codex：[model_providers.modelhub] 段文本（零依赖 TOML，逐行定位）
// TOML 字符串转义：双引号 → \"，反斜杠 → \\
function tomlEsc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function codexModelhubSection(model) {
  return '\n[model_providers.modelhub]\n' +
         'name = "ModelHub"\n' +
         'base_url = "' + tomlEsc(PROXY_URL) + '/v1"\n' +
         'api_key = "' + tomlEsc(AUTH_TOKEN) + '"\n' +
         'wire_api = "responses"\n' +
         'models = ["deepseek-chat", "deepseek-reasoner", "glm-4-plus", "kimi-chat", "qwen-max"]\n' +
         'default_model = "' + tomlEsc(model) + '"\n';
}

// Codex：局部修改 + 新增/覆盖段（不动其它 [段]）
function writeCodexConfig(model) {
  if (!fs.existsSync(CX_PATH)) {
    const e = new Error('CODEX_CONFIG_MISSING');
    e.code = 'MISSING_FILE';
    throw e; // 不擅自建空文件，避免破坏 Codex 安装
  }
  backupOnce(CX_PATH, CX_BAK);
  const lines = fs.readFileSync(CX_PATH, 'utf-8').split('\n');
  const out = [];
  let inModelhub = false, replaced = false, currentSection = null;
  for (const line of lines) {
    const secMatch = line.match(/^\s*\[(.+)\]\s*$/);
    if (secMatch) {
      if (inModelhub && !replaced) { out.push(codexModelhubSection(model)); replaced = true; }
      inModelhub = (secMatch[1].trim() === 'model_providers.modelhub');
      currentSection = secMatch[1].trim();
      if (inModelhub) continue;       // 跳过旧 modelhub 段全部内容
      out.push(line); continue;
    }
    if (inModelhub) continue;         // 仍在旧 modelhub 段内
    if (currentSection === null) {     // 仅顶层标量：修改 model / model_provider
      if (/^model\s*=/.test(line))      { out.push('model = "' + model + '"'); continue; }
      if (/^model_provider\s*=/.test(line)) { out.push('model_provider = "modelhub"'); continue; }
    }
    out.push(line);
  }
  if (!replaced) out.push(codexModelhubSection(model)); // 原本无该段 → 末尾追加
  atomicWrite(CX_PATH, out.join('\n'));
  return { path: CX_PATH, created: false };
}

// 恢复原配置（从 .bak 写回）
function restoreConfig(tool) {
  const orig = tool === 'cc' ? CC_PATH : CX_PATH;
  const bak  = tool === 'cc' ? CC_BAK  : CX_BAK;
  if (!fs.existsSync(bak)) { const e = new Error('NO_BACKUP'); e.code = 'NO_BACKUP'; throw e; }
  fs.copyFileSync(bak, orig);
  return { path: orig };
}

const REAL_PROVIDERS = () => Object.keys(config.providers).filter(n => !config.providers[n].internal);

function createServer() {
  return http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    const _clientIp = req.socket.remoteAddress || '127.0.0.1';
    noteReq({ method: req.method, url, ip: _clientIp });
    if (!url.startsWith('/v1/messages') && _rateLimited(_clientIp)) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'too many requests' } }));
      return;
    }
    cors(res, req); // 所有响应附 CORS 头，支持本机页面 / file:// 直接打开的页面调用
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; } // 预检
    if (req.method === 'POST' && url.startsWith('/v1/messages')) {
      const raw = await readBodySafe(req);
      try { await handleMessages(JSON.parse(raw), res); } catch (e) { failSafe(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: e.message } }); }
      return;
    }
    if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
      const raw = await readBodySafe(req);
      try { await handleChatCompletions(JSON.parse(raw), res); } catch (e) { failSafe(res, 400, { error: { message: e.message, type: 'invalid_request_error' } }); }
      return;
    }
    if (req.method === 'POST' && (url === '/v1/responses' || url === '/responses')) {
      const raw = await readBodySafe(req);
      try { await handleResponses(JSON.parse(raw), res); } catch (e) { failSafe(res, 400, { error: { message: e.message, type: 'invalid_request_error' } }); }
      return;
    }
    if (req.method === 'GET' && (url === '/start.html')) { serveStart(res); return; }
    if (req.method === 'GET' && (url === '/free-models.html')) { serveAsset(res, 'free-models.html'); return; }
    if (req.method === 'GET' && (url === '/' || url === '/welcome' || url === '/index.html')) { serveWelcome(res); return; }
    if (req.method === 'GET' && (url === '/start' || url === '/start.html' || url === '/ui' || url === '/ui.html' || url === '/dashboard')) { serveStart(res); return; }
    if (req.method === 'GET' && url === '/health') { res.writeHead(200); res.end('OK'); return; }
        // ---- License API (无需鉴权，仅本地校验 key) ----
    if (req.method === 'POST' && url === '/api/license/activate') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const b = JSON.parse(body);
          if (b.key) require('./license').saveLicenseKey(b.key);
          const lic = await require('./license').checkLicense();
          _licenseTier = (lic && lic.tier) ? lic.tier : 'trial';
          sendJSON(res, lic);
        } catch (e) { sendJSON(res, { ok: false, error: e.message }); }
      });
      return;
    }
    if (req.method === 'GET' && url === '/api/license/status') {
      (async () => {
        const lic = await require('./license').checkLicense();
        _licenseTier = (lic && lic.tier) ? lic.tier : 'trial';
        sendJSON(res, lic);
      })();
      return;
    }

    // ---- 管理 API (需鉴权) ----
    // ---- 管理 API 鉴权（以下所有 /api/* 需要 Bearer token）- ---
    if (url.startsWith('/api/')) {
      if (!requireAuth(req, res)) return;
    }
    if (req.method === 'GET' && url === '/api/models') {
      const providers = Object.keys(config.providers).map(name => {
        const p = config.providers[name];
        return {
          name, display: p.display, region: p.region, icon: p.icon, internal: !!p.internal,
          configured: !!effectiveKey(name) && effectiveKey(name) !== '',
          models: Object.entries(p.models).map(([alias, upstream]) => ({ alias, upstream }))
        };
      });
      sendJSON(res, { current: state.current, providers, modelCount: Object.keys(modelMap).length });
      return;
    }
    if (req.method === 'GET' && url === '/api/status') {
      sendJSON(res, { current: state.current, uptime: Date.now() - START_TIME, modelCount: Object.keys(modelMap).length, pid: process.pid });
      return;
    }
    if (req.method === 'GET' && url === '/api/env') {
      const real = REAL_PROVIDERS();
      const configured = real.filter(n => !!effectiveKey(n)).length;
      sendJSON(res, {
        node: { version: process.version, ok: parseInt(process.versions.node.split('.')[0], 10) >= 14 },
        port: { ok: true, value: ACTIVE_PORT },
        claudeSettings: { path: CC_PATH, exists: fs.existsSync(CC_PATH) },
        codexConfig: { path: CX_PATH, exists: fs.existsSync(CX_PATH) },
        providersConfigured: configured, totalProviders: real.length
      });
      return;
    }
    if (req.method === 'GET' && url === '/api/logs') {
      const all = logs.slice().reverse();
      let limit = 0, offset = 0;
      try { const q = new URL(req.url, 'http://localhost'); limit = parseInt(q.searchParams.get('limit') || '0', 10); offset = parseInt(q.searchParams.get('offset') || '0', 10); } catch (e) {}
      const out = limit > 0 ? all.slice(offset, offset + limit) : all;
      sendJSON(res, { logs: out, total: all.length });
      return;
    }
  if (req.method === 'GET' && url === '/api/selftest') {
    const payload = JSON.stringify({ model: 'echo', max_tokens: 64, messages: [{ role: 'user', content: 'ping' }] });
    const opt = { hostname: '127.0.0.1', port: ACTIVE_PORT, path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json' } };
    let settled = false;
    const finish = (obj) => { if (settled) return; settled = true; sendJSON(res, obj); };
    const r = http.request(opt, (resp) => {
      let body = '';
      resp.on('data', d => body += d);
      resp.on('end', () => {
        const events = (body.match(/event: (\w+)/g) || []).map(s => s.replace('event: ', '')).filter(Boolean);
        const ok = events.includes('message_start') && events.includes('content_block_delta') && events.includes('message_stop');
        finish({ ok, events, sample: body.slice(0, 300) });
      });
    });
    // 防 echo 链路异常时请求永久挂起
    r.setTimeout(5000, () => { r.destroy(); finish({ ok: false, error: 'selftest timeout' }); });
    r.on('error', e => finish({ ok: false, error: e.message }));
    r.write(payload); r.end();
    return;
  }
    if (req.method === 'POST' && url === '/api/switch') {
      const body = await readBody(req);
      const m = body.model;
      if (!m || !modelMap[m]) { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid model alias' })); return; }
      state.current = m;
      saveState();
      sendJSON(res, { ok: true, current: state.current });
      return;
    }
    if (req.method === 'POST' && url === '/api/keys') {
      const body = await readBody(req);
      const name = body.provider, key = body.key;
      if (!config.providers[name]) { res.writeHead(400); res.end(JSON.stringify({ error: 'unknown provider' })); return; }
      try {
        if (key) keysFile[name] = key; else delete keysFile[name];
        saveKeysFile(keysFile);
        sendJSON(res, { ok: true, configured: !!effectiveKey(name) });
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }
    // ---- 客户端配置写入（真实写盘） ----
    if (req.method === 'POST' && url === '/api/write-config') {
      const body = await readBody(req);
      const tool = body.tool;
      const model = body.model || state.current;
      try {
        let r;
        if (tool === 'cc') r = writeClaudeSettings();
        else if (tool === 'cx') r = writeCodexConfig(model);
        else { res.writeHead(400); res.end(JSON.stringify({ error: 'unknown tool' })); return; }
        sendJSON(res, { ok: true, path: r.path, created: !!r.created });
      } catch (e) {
        if (e.code === 'MISSING_FILE') {
          res.writeHead(409);
          res.end(JSON.stringify({ ok: false, code: 'MISSING_FILE', message: '~/.codex/config.toml 不存在：请先启动并登录 Codex 让它生成该文件，再回来点「更改配置文件」。' }));
          return;
        }
        if (e.code === 'JSON_PARSE_ERROR') {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, code: 'JSON_PARSE_ERROR', message: e.message }));
          return;
        }
        res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    if (req.method === 'POST' && url === '/api/restore-config') {
      const body = await readBody(req);
      try {
        const r = restoreConfig(body.tool);
        sendJSON(res, { ok: true, path: r.path });
      } catch (e) {
        if (e.code === 'NO_BACKUP') {
          res.writeHead(409);
          res.end(JSON.stringify({ ok: false, code: 'NO_BACKUP', message: '无需恢复：从未写入过该配置。' }));
          return;
        }
        res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    // ---- 停止代理 (CLI 调用) ----
    if (req.method === 'POST' && url === '/api/stop') {
      try { fs.writeFileSync(path.join(__dirname, '..', 'modelhub.stop'), String(Date.now())); } catch (e) {}
      sendJSON(res, { ok: true, message: 'shutting down' });
      setTimeout(() => { try { fs.unlinkSync(PID_PATH); } catch(e){} server.close(); process.exit(0); }, 200);
      return;
    }
        // NOTE: /api/license/activate|status are handled once above (before the auth gate).
    // The duplicate block here was dead code (Bug #9) and has been removed.
    res.writeHead(404); res.end();
  });
}

// ---------- 启动 / 停止 ----------
// 启动后尝试自动打开浏览器到管理面板（仅本机；设 MODELHUB_NO_OPEN=1 可禁用）
function maybeOpenBrowser(port) {
  if (process.env.MODELHUB_NO_OPEN) return;
  const url = "http://127.0.0.1:" + port + "/";
  try {
    // 注意：spawn 找不到可执行文件时是【异步】抛 'error' 事件，try/catch 抓不到，
    // 必须用 .on('error') 吞掉，否则会变为 uncaughtException 拖崩整个代理。
    // 同时用 cmd.exe 绝对路径，避免某些环境(计划任务/受限 PATH)下 PATH 不含 System32 导致 ENOENT。
    let cp;
    if (process.platform === 'win32')
      cp = spawn('C:\\Windows\\System32\\cmd.exe', ['/c', 'start', '', url], { windowsHide: true, detached: true });
    else if (process.platform === 'darwin')
      cp = spawn('open', [url], { detached: true });
    else
      cp = spawn('xdg-open', [url], { detached: true });
    cp.on('error', () => {}); // 打开浏览器失败（无 GUI/无命令）时静默忽略，绝不阻断代理运行
  } catch (e) { /* 打开失败不阻断代理运行 */ }
}

function start(port) {
  const listenPort = port || PORT;
  ACTIVE_PORT = listenPort;
  initDir();
  // License check at startup
  (async () => {
    const lic = await license.checkLicense();
    if (lic && lic.tier) _licenseTier = lic.tier;
    else if (lic && !lic.licensed) _licenseTier = 'trial';
    if (lic.ok && lic.licensed) {
      console.log('  License: ' + (lic.label || lic.tier || 'active') + ' | ' + (lic.remaining_days || 'N/A') + ' days remaining');
    } else if (lic.ok && !lic.licensed) {
      console.warn('  License: UNLICENSED - 7-day trial. Enter license key to unlock all providers.');
    } else {
      console.warn('  License: ' + (lic.error || 'verification failed'));
    }
  })();
  config = loadConfig();
  AUTH_TOKEN = process.env.MODELHUB_AUTH_TOKEN || config.auth_token || 'sk-local-proxy';
  rebuildMaps();
  loadState();
  loadKeys();

  // 未配置任何真实供应商时告警（代理会落到 Echo 自检模式，能连通但不调用上游）
  const realModels = Object.keys(modelMap).filter(k => k !== 'echo');
  if (realModels.length === 0) {
    console.warn('[ModelHub] ⚠️  未检测到任何真实供应商/模型，代理处于「Echo 自检」模式：可连通但不会真正调用上游。请到管理界面配置 API Key。');
  }

  // 写 PID 文件
  try { fs.writeFileSync(PID_PATH, String(process.pid)); } catch (e) {}

  server = createServer();
  // 前台模式下轮询 modelhub.stop 信号文件：外部脚本写入此文件即可优雅停止
  const STOP_FILE = path.join(__dirname, '..', 'modelhub.stop');
  const stopPoll = setInterval(() => {
    try { if (fs.existsSync(STOP_FILE)) { clearInterval(stopPoll); fs.unlinkSync(STOP_FILE); server.close(); process.exit(0); } } catch (e) {}
  }, 2000);
  const tryListen = (p) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        if (process.env.MODELHUB_NO_PORT_INCREMENT) {
          console.error('[ModelHub] 端口 ' + p + ' 被占用，启动失败（已禁用端口漂移）。请先停止占用进程：');
          console.error('  PowerShell: Get-NetTCPConnection -LocalPort ' + p + ' | Select OwningProcess');
          console.error('  或去掉 MODELHUB_NO_PORT_INCREMENT 以启用自动端口漂移');
          process.exit(1);
        }
        const next = p + 1;
        if (next > listenPort + 10) {
          console.error('[ModelHub] 端口 ' + listenPort + '~' + (listenPort + 10) + ' 均被占用，启动失败');
          process.exit(1);
        }
        console.error('[ModelHub] 端口 ' + p + ' 被占用，自动尝试 ' + next);
        tryListen(next);
        return;
      }
      console.error('[ModelHub] 监听错误: ' + err.message);
      process.exit(1);
    });
    server.listen(p, '127.0.0.1', () => {
      server.removeAllListeners('error');
      ACTIVE_PORT = p;
      if (p !== PORT) {
        PROXY_URL = 'http://127.0.0.1:' + p;
        console.log('  ⚠️  端口 ' + (p - 1) + ' 被占用，已自动切换至 ' + p);
        console.log('  ⚠️  请同步更新客户端：ANTHROPIC_API_URL / ANTHROPIC_BASE_URL = ' + PROXY_URL + '/v1');
      }
      console.log('');
      console.log('  ModelHub 多模型代理已启动');
      console.log('  ────────────────────────────────');
      console.log('  Web 管理界面: http://localhost:' + p);
      console.log('  API 端点:     http://localhost:' + p + '/v1/messages');
      console.log('  数据目录:     ' + DATA_DIR);
      console.log('  已加载供应商: ' + REAL_PROVIDERS().join(', '));
      console.log('  支持模型数:   ' + Object.keys(modelMap).length);
      console.log('  当前激活模型: ' + state.current);
      console.log('  ────────────────────────────────');
      console.log('  按 Ctrl+C 停止');
      console.log('');
      maybeOpenBrowser(p);
    });
  };
  tryListen(listenPort);

  // 退出时清理 PID
  process.on('SIGINT', () => { try { fs.unlinkSync(PID_PATH); } catch(e){} process.exit(0); });
  process.on('SIGTERM', () => { try { fs.unlinkSync(PID_PATH); } catch(e){} process.exit(0); });
  // 退出诊断：仅异常退出时把退出码 + 最近请求写入 crash.log，正常 exit 0 不覆盖
  const CRASH_LOG = path.join(__dirname, '..', 'proxy_crash.log');
  process.on('exit', (code) => {
    try { fs.unlinkSync(PID_PATH); } catch(e){}
    if (code !== 0) {
      try {
        const head = '[' + new Date().toISOString() + '] process exit code=' + code + '\n';
        fs.writeFileSync(CRASH_LOG, head + JSON.stringify(recentReqs.slice(-10), null, 2) + '\n');
      } catch(e){}
    }
  });

  return server;
}

function stop() {
  if (server) { server.close(); try { fs.unlinkSync(PID_PATH); } catch(e){} }
}

module.exports = { start, stop, PORT, DATA_DIR, CONFIG_PATH, KEYS_PATH, STATE_PATH, PID_PATH, config, modelMap, effectiveKey, REAL_PROVIDERS };

// 直接运行时自动启动
if (require.main === module) start();







