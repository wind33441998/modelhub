// ModelHub CLI — 命令分发器
// 用法: modelhub <command> [options]

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_PORT = process.env.MODELHUB_PORT || process.env.PORT || 4000;
let PORT = DEFAULT_PORT;
let AUTH_TOKEN = process.env.MODELHUB_AUTH_TOKEN || 'sk-local-proxy'; // 可从 config.json 覆写
const DATA_DIR = path.join(os.homedir(), '.modelhub');
const PID_PATH = path.join(DATA_DIR, 'modelhub.pid');
const PORT_PATH = path.join(DATA_DIR, 'cli_port.json');
const KEYS_PATH = path.join(DATA_DIR, 'keys.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const LOG_PATH = path.join(DATA_DIR, 'modelhub.log');
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'assets', 'config.json');
const license = require('./license.js');

const BANNER = '\x1b[36mModelHub\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function ok(m) { return GREEN + '✓' + RESET + ' ' + m; }
function bad(m) { return RED + '✗' + RESET + ' ' + m; }
function warn(m) { return YELLOW + '⚠' + RESET + ' ' + m; }

const HELP = `
${BANNER} — Claude Code 多模型本地代理

${DIM}国产供应商直连免翻墙，8 家 22 模型，Web 管理界面${RESET}

${YELLOW}用法:${RESET}
  modelhub <command> [options]
  ${DIM}无参数直接运行 = 启动代理并打开管理界面 (http://localhost:4000)${RESET}

${YELLOW}命令:${RESET}
  ${GREEN}start${RESET} [-d] [-p PORT]       启动代理 (${DIM}-d 后台, -p 指定端口${RESET})
  ${GREEN}stop${RESET}                     停止后台代理
  ${GREEN}status${RESET}                   查看运行状态 + 当前模型
  ${GREEN}models${RESET}                   列出所有可用模型
  ${GREEN}switch${RESET} <model>           切换当前激活模型
  ${GREEN}keys${RESET} [list]              列出已配置的 API Key
  ${GREEN}keys set${RESET} <provider> <key>  设置供应商 API Key
  ${GREEN}keys del${RESET} <provider>      删除供应商 API Key
  ${GREEN}ui${RESET}                       在浏览器打开管理界面
  ${GREEN}doctor${RESET}                   环境自检
  ${GREEN}selftest${RESET}                 运行代理链路自检 (无需 API Key)
  ${GREEN}activate${RESET} <key>           激活许可证 (购买后输入授权码, 支持 --stdin 盲输)
  ${GREEN}help${RESET}                     显示此帮助
  ${GREEN}--version, -v${RESET}            显示版本号

${YELLOW}示例:${RESET}
  ${DIM}modelhub start                    ${RESET}# 前台启动, 默认端口 4000
  ${DIM}modelhub start -d -p 8080         ${RESET}# 后台启动, 端口 8080
  ${DIM}modelhub keys set deepseek sk-xx  ${RESET}# 配置 DeepSeek API Key
  ${DIM}modelhub switch glm-4-plus        ${RESET}# 切换到智谱 GLM-4-Plus
  ${DIM}modelhub ui                       ${RESET}# 打开 Web 管理界面

${YELLOW}数据目录:${RESET} ~/.modelhub/
${YELLOW}文档:${RESET} https://github.com/wind33441998/modelhub
`;

// ---------- 工具函数 ----------
function apiCall(method, urlPath, body, timeout) {
  return new Promise((resolve) => {
    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path: urlPath,
      method: method,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AUTH_TOKEN }
    };
    const req = http.request(options, (resp) => {
      let data = '';
      resp.on('data', d => data += d);
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, json: JSON.parse(data || '{}') }); }
        catch (e) { resolve({ status: resp.statusCode, json: null, raw: data }); }
      });
    });
    req.on('error', () => resolve({ status: 0, error: true }));
    req.setTimeout(timeout || 3000, () => { req.destroy(); resolve({ status: 0, error: true }); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function isRunning() {
  if (!fs.existsSync(PID_PATH)) return false;
  try {
    const pid = parseInt(fs.readFileSync(PID_PATH, 'utf-8').trim(), 10);
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
  } catch (e) { return false; }
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(DEFAULT_CONFIG_PATH)) {
    fs.copyFileSync(DEFAULT_CONFIG_PATH, CONFIG_PATH);
  }
}

// 持久化/恢复 CLI 使用的端口（来自 -p 参数），使后续 status/stop/ui 等命令连接正确端口
function saveActivePort(port) {
  try { ensureDataDir(); fs.writeFileSync(PORT_PATH, JSON.stringify({ port }, null, 2)); } catch (e) {}
}
function loadActivePort() {
  try {
    if (fs.existsSync(PORT_PATH)) {
      const s = JSON.parse(fs.readFileSync(PORT_PATH, 'utf-8'));
      if (s && s.port) PORT = s.port;
    }
  } catch (e) {}
}
function loadAuthToken() {
  if (process.env.MODELHUB_AUTH_TOKEN) { AUTH_TOKEN = process.env.MODELHUB_AUTH_TOKEN; return; }
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      if (cfg.auth_token) AUTH_TOKEN = String(cfg.auth_token);
    }
  } catch (e) {}
}
loadActivePort();
loadAuthToken();

function loadConfigProviders() {
  const cfgPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : DEFAULT_CONFIG_PATH;
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    return raw.providers || {};
  } catch (e) { return {}; }
}

function loadKeys() {
  if (!fs.existsSync(KEYS_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8')) || {}; } catch (e) { return {}; }
}

function saveKeys(keys) {
  ensureDataDir();
  // 安全(B2): 数据目录 0700，密钥文件 0600
  try { fs.chmodSync(DATA_DIR, 0o700); } catch (_) {}
  fs.writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2));
  try { fs.chmodSync(KEYS_PATH, 0o600); } catch (_) {}
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true });
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true });
    else spawn('xdg-open', [url], { detached: true });
  } catch (e) { console.log('  请手动打开: ' + url); }
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return h + 'h ' + m + 'm ' + sec + 's';
  if (m > 0) return m + 'm ' + sec + 's';
  return sec + 's';
}

// ---------- 命令实现 ----------
function cmdHelp() {
  console.log(HELP);
}

function cmdStart(args) {
  const daemon = args.includes('-d') || args.includes('--daemon');
  let port = PORT;
  const pIdx = args.indexOf('-p');
  if (pIdx >= 0 && args[pIdx + 1]) port = parseInt(args[pIdx + 1], 10);
  const portIdx = args.indexOf('--port');
  if (portIdx >= 0 && args[portIdx + 1]) port = parseInt(args[portIdx + 1], 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.log(bad('无效端口号: ' + port));
    return;
  }

  // 检查是否已在运行
  if (isRunning()) {
    console.log(bad('代理已在运行 (PID 文件存在)，如需重启请先执行 modelhub stop'));
    return;
  }

  // 持久化端口，使后续 status/stop/ui 等命令使用正确端口
  saveActivePort(port);
  PORT = port; // 同步更新模块级变量

  if (daemon) {
    // 后台启动
    ensureDataDir();
    const proxyPath = path.join(__dirname, 'proxy.js');
    const env = Object.assign({}, process.env, { MODELHUB_PORT: String(port) });
    const logFd = fs.openSync(LOG_PATH, 'w');
    const child = spawn(process.execPath, [proxyPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: env
    });
    child.unref();
    setTimeout(() => {
      if (isRunning()) {
        console.log(ok('代理已在后台启动'));
        console.log('  ' + DIM + 'PID: ' + fs.readFileSync(PID_PATH, 'utf-8').trim() + RESET);
        console.log('  ' + DIM + '端口: ' + port + RESET);
        console.log('  ' + DIM + 'Web 界面: http://localhost:' + port + RESET);
        console.log('  ' + DIM + '日志: ' + LOG_PATH + RESET);
        console.log('  停止: modelhub stop');
      } else {
        console.log(bad('后台启动可能失败，请查看日志: ' + LOG_PATH));
      }
    }, 1500);
  } else {
    // 前台启动
    ensureDataDir(); // 与 daemon 分支对称
    process.env.MODELHUB_PORT = String(port);
    const { start } = require('./proxy.js');
    start(port);
  }
}

function cmdStop() {
  if (!isRunning()) {
    console.log(warn('代理未在运行'));
    // 清理残留 PID 文件
    try { fs.unlinkSync(PID_PATH); } catch (e) {}
    return;
  }
  // 优先用 API 优雅停止
  apiCall('POST', '/api/stop', null, 5000).then((r) => {
    if (r.status === 200) {
      console.log(ok('代理已停止'));
      // 等待进程实际退出（最多 1.5s）
      let tries = 0;
      const wait = setInterval(() => {
        if (!isRunning() || ++tries > 5) { clearInterval(wait); if (isRunning()) forceKill(); }
      }, 300);
    } else {
      // 兜底：读 PID 强制杀
      forceKill();
    }
  });
}

function forceKill() {
  try {
    const pid = parseInt(fs.readFileSync(PID_PATH, 'utf-8').trim(), 10);
    if (!pid) { try { fs.unlinkSync(PID_PATH); } catch (e) {} return; }
    // 校验 PID 是否仍属于 ModelHub 进程（防止回收后误杀）
    try { process.kill(pid, 0); } catch (e) {
      try { fs.unlinkSync(PID_PATH); } catch (_) {} return;
    }
    try { process.kill(pid); console.log(ok('代理进程已终止 (PID: ' + pid + ')')); }
    catch (e) { console.log(warn('无法终止进程 (PID: ' + pid + '): ' + e.message)); }
    try { fs.unlinkSync(PID_PATH); } catch (e) {}
  } catch (e) {
    console.log(bad('无法停止代理: ' + e.message));
  }
}

function cmdStatus() {
  if (!isRunning()) {
    console.log(bad('代理未运行，请先执行 modelhub start'));
    return;
  }
  apiCall('GET', '/api/status').then((r) => {
    if (r.error || r.status !== 200) {
      console.log(bad('代理未响应 (PID 文件存在但端口无响应)'));
      console.log('  ' + DIM + '可能进程已崩溃，执行 modelhub stop 清理后重启' + RESET);
      return;
    }
    const d = r.json;
    console.log(ok('代理运行中'));
    console.log('  ' + DIM + '当前模型: ' + RESET + (d.current || 'unknown'));
    console.log('  ' + DIM + '运行时长: ' + RESET + formatUptime(d.uptime || 0));
    console.log('  ' + DIM + '模型总数: ' + RESET + (d.modelCount || 0));
    console.log('  ' + DIM + 'PID: ' + RESET + (d.pid || ''));
    console.log('  ' + DIM + '端口: ' + PORT + RESET);
    console.log('  ' + DIM + 'Web 界面: http://localhost:' + PORT + RESET);
  });
}

function cmdModels() {
  const providers = loadConfigProviders();
  const keys = loadKeys();
  console.log('');
  console.log('  ' + BANNER + ' 可用模型列表');
  console.log('  ' + '─'.repeat(50));
  for (const [name, p] of Object.entries(providers)) {
    const hasKey = keys[name] || (p.api_key && !p.api_key.startsWith('${')) ? true : false;
    const keyStatus = hasKey ? GREEN + '✓' + RESET : RED + '✗' + RESET;
    console.log('  ' + (p.icon || '🔌') + ' ' + (p.display || name) + ' ' + DIM + '[' + name + ']' + RESET + ' ' + keyStatus);
    for (const [alias, upstream] of Object.entries(p.models || {})) {
      console.log('      ' + alias + ' ' + DIM + '→ ' + upstream + RESET);
    }
  }
  // 内置自检
  console.log('  🔁 Echo 自检 ' + DIM + '[echo]' + RESET + ' ' + GREEN + '✓' + RESET);
  console.log('      echo ' + DIM + '→ echo (内置, 无需密钥)' + RESET);
  console.log('');
  console.log('  ' + DIM + '切换模型: modelhub switch <alias>' + RESET);
  console.log('  ' + DIM + '配置密钥: modelhub keys set <provider> <key>' + RESET);
  console.log('');
}

function cmdSwitch(args) {
  const model = args[0];
  if (!model) {
    console.log(bad('请指定模型别名, 例如: modelhub switch deepseek-chat'));
    console.log('  ' + DIM + '查看所有模型: modelhub models' + RESET);
    return;
  }
  if (!isRunning()) {
    console.log(bad('代理未运行，请先执行 modelhub start'));
    return;
  }
  apiCall('POST', '/api/switch', { model }).then((r) => {
    if (r.status === 200 && r.json.ok) {
      console.log(ok('已切换到: ' + r.json.current));
    } else {
      console.log(bad('切换失败: ' + (r.json && r.json.error ? r.json.error : '未知模型别名')));
      console.log('  ' + DIM + '查看所有模型: modelhub models' + RESET);
    }
  });
}

function cmdKeys(args) {
  const sub = args[0] || 'list';
  const providers = loadConfigProviders();

  if (sub === 'list') {
    const keys = loadKeys();
    console.log('');
    console.log('  ' + BANNER + ' API Key 配置');
    console.log('  ' + '─'.repeat(50));
    for (const [name, p] of Object.entries(providers)) {
      const envVar = (p.api_key || '').replace(/\$\{([^}]+)\}/g, '$1');
      const hasEnvKey = envVar && process.env[envVar];
      const hasFileKey = !!keys[name];
      const configured = hasEnvKey || hasFileKey;
      const source = hasFileKey ? '(keys.json)' : (hasEnvKey ? '(env)' : '');
      const status = configured ? GREEN + '✓ 已配置' + RESET + ' ' + DIM + source + RESET : RED + '✗ 未配置' + RESET;
      console.log('  ' + (p.icon || '🔌') + ' ' + (p.display || name) + ' ' + DIM + '[' + name + ']' + RESET);
      console.log('      ' + status);
      if (envVar) console.log('      ' + DIM + '环境变量: ' + envVar + RESET);
    }
    console.log('');
    console.log('  ' + DIM + '设置密钥: modelhub keys set <provider> <key>' + RESET);
    console.log('  ' + DIM + '删除密钥: modelhub keys del <provider>' + RESET);
    console.log('');
  } else if (sub === 'set') {
    const provider = args[1];
    let key = args[2];
    const useStdin = args.includes('--stdin') || args.includes('-s');
    if (!provider) {
      console.log(bad('用法: modelhub keys set <provider> <key>'));
      console.log('  ' + DIM + '例如: modelhub keys set deepseek sk-xxxxxxxx' + RESET);
      console.log('  ' + DIM + '安全模式: modelhub keys set deepseek --stdin (从 stdin 交互输入, 不暴露在进程列表/shell 历史中)' + RESET);
      return;
    }
    if (useStdin) {
      // 安全(B2): 从 stdin 读取密钥，不暴露在进程命令行/shell 历史中
      console.log('  ' + YELLOW + '请输入 ' + provider + ' 的 API Key (输入后回车确认，盲输不回显):' + RESET);
      const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      // 关闭 echo（Unix 用 tty 模式，Windows 用 setRawMode）
      if (process.stdin.isTTY) {
        const wasRaw = process.stdin.isRaw;
        process.stdin.setRawMode && process.stdin.setRawMode(true);
        rl._writeToOutput = function _writeToOutput() {};
      }
      rl.question('', (answer) => {
        key = answer.trim();
        if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
        rl.close();
        if (!key) {
          console.log(bad('密钥不能为空'));
          return;
        }
        const keys = loadKeys();
        keys[provider] = key;
        saveKeys(keys);
        console.log(ok('已保存 ' + provider + ' 的 API Key'));
        if (isRunning()) {
          apiCall('POST', '/api/keys', { provider, key }).then((r) => {
            if (r.status === 200) console.log('  ' + DIM + '代理已热更新' + RESET);
            else console.log('  ' + warn('密钥已写入文件，但代理热更新失败（状态 ' + r.status + '），重启代理后生效'));
          });
        } else {
          console.log('  ' + DIM + '密钥已写入 ~/.modelhub/keys.json (0600 权限)，下次启动生效' + RESET);
        }
      });
      return;
    }
    if (!providers[provider]) {
      console.log(bad('未知供应商: ' + provider));
      console.log('  ' + DIM + '可用供应商: ' + Object.keys(providers).join(', ') + RESET);
      return;
    }
    if (!key) {
      console.log(bad('用法: modelhub keys set <provider> <key>'));
      console.log('  ' + DIM + '安全模式: modelhub keys set ' + provider + ' --stdin' + RESET);
      return;
    }
    const keys = loadKeys();
    keys[provider] = key;
    saveKeys(keys);
    console.log(ok('已保存 ' + provider + ' 的 API Key'));
    // 如果代理在运行，热更新
    if (isRunning()) {
      apiCall('POST', '/api/keys', { provider, key }).then((r) => {
        if (r.status === 200) console.log('  ' + DIM + '代理已热更新' + RESET);
        else console.log('  ' + warn('密钥已写入文件，但代理热更新失败（状态 ' + r.status + '），重启代理后生效'));
      });
    } else {
      console.log('  ' + DIM + '密钥已写入 ~/.modelhub/keys.json，下次启动生效' + RESET);
    }
  } else if (sub === 'del') {
    const provider = args[1];
    if (!provider) {
      console.log(bad('用法: modelhub keys del <provider>'));
      return;
    }
    if (!providers[provider]) {
      console.log(bad('未知供应商: ' + provider));
      console.log('  ' + DIM + '可用供应商: ' + Object.keys(providers).join(', ') + RESET);
      return;
    }
    const keys = loadKeys();
    if (!keys[provider]) {
      console.log(warn(provider + ' 没有已保存的密钥'));
      return;
    }
    delete keys[provider];
    saveKeys(keys);
    console.log(ok('已删除 ' + provider + ' 的 API Key'));
    if (isRunning()) {
      apiCall('POST', '/api/keys', { provider, key: '' }).then((r) => {
        if (r.status === 200) console.log('  ' + DIM + '代理已热更新' + RESET);
        else console.log('  ' + warn('密钥已删除，但代理热更新失败（状态 ' + r.status + '），重启代理后生效'));
      });
    }
  } else {
    console.log(bad('未知子命令: ' + sub));
    console.log('  ' + DIM + '可用: list, set, del' + RESET);
  }
}

function cmdUI() {
  if (!isRunning()) {
    console.log(bad('代理未运行，请先执行 modelhub start'));
    return;
  }
  const url = 'http://localhost:' + PORT;
  console.log(ok('正在打开管理界面: ' + url));
  openBrowser(url);
}

function cmdDoctor() {
  console.log('');
  console.log('  ' + BANNER + ' 环境自检');
  console.log('  ' + '─'.repeat(50));

  let block = false;

  // 1. Node 版本
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 14) console.log('  ' + ok('Node.js v' + process.version + ' (>=14)'));
  else { console.log('  ' + bad('Node.js 版本过低: v' + process.version + '，需要 >=14')); block = true; }

  // 2. 数据目录
  ensureDataDir();
  console.log('  ' + ok('数据目录: ' + DATA_DIR));

  // 3. 配置文件
  if (fs.existsSync(CONFIG_PATH)) console.log('  ' + ok('配置文件: ' + CONFIG_PATH));
  else console.log('  ' + warn('配置文件不存在 (将从默认模板创建)'));

  // 4. API Key 配置
  const providers = loadConfigProviders();
  const keys = loadKeys();
  let n = 0;
  for (const [name, p] of Object.entries(providers)) {
    const envVar = (p.api_key || '').replace(/\$\{([^}]+)\}/g, '$1');
    if (keys[name] || (envVar && process.env[envVar])) n++;
  }
  if (n > 0) console.log('  ' + ok('已配置 ' + n + '/' + Object.keys(providers).length + ' 个供应商 API Key'));
  else console.log('  ' + warn('未配置任何 API Key (运行 modelhub keys set <provider> <key> 配置)'));

  // 5. Claude Code 配置
  const claudePath = path.join(os.homedir(), '.claude', 'settings.json');
  if (fs.existsSync(claudePath)) console.log('  ' + ok('Claude Code 配置: ' + claudePath));
  else console.log('  ' + warn('未找到 Claude Code 配置 (可能尚未安装)'));

  // 6. 端口检查
  const net = require('net');
  const srv = net.createServer();
  srv.once('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      if (isRunning()) console.log('  ' + ok('端口 ' + PORT + ' 已被 ModelHub 占用 (运行中)'));
      else { console.log('  ' + bad('端口 ' + PORT + ' 被其他程序占用')); block = true; }
    }
    finish();
  });
  srv.once('listening', () => {
    console.log('  ' + ok('端口 ' + PORT + ' 空闲可用'));
    srv.close(finish);
  });
  srv.listen(PORT, '127.0.0.1');

  function finish() {
    console.log('');
    if (block) {
      console.log('  ' + bad('环境检查未通过，请先解决上述问题'));
      process.exit(1);
    }
    console.log('  ' + ok('环境检查通过，可以启动: modelhub start'));
    console.log('');
  }
}

function cmdSelftest() {
  if (!isRunning()) {
    console.log(bad('代理未运行，请先执行 modelhub start'));
    return;
  }
  console.log('  运行代理链路自检...');
  apiCall('GET', '/api/selftest').then((r) => {
    if (r.error || r.status !== 200) {
      console.log('  ' + bad('自检请求失败'));
      return;
    }
    const d = r.json;
    if (d.ok) {
      console.log('  ' + ok('自检通过 — Anthropic→OpenAI 转换、tool_use 回写均正常'));
      console.log('  ' + DIM + '事件流: ' + (d.events || []).join(' → ') + RESET);
    } else {
      console.log('  ' + bad('自检失败'));
      console.log('  ' + DIM + (d.error || d.sample || '未知错误') + RESET);
    }
  });
}

function cmdActivate(args) {
  const useStdin = args.includes('--stdin') || args.includes('-s');
  const key = args.find(a => !a.startsWith('-'));
  if (useStdin && !key) {
    // 安全(B2): 从 stdin 盲输，不暴露在进程命令行/shell 历史中
    console.log('  ' + YELLOW + '请输入授权码 (输入后回车确认，盲输不回显):' + RESET);
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
      rl._writeToOutput = function () {};
    }
    rl.question('', (answer) => {
      const k = answer.trim();
      if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
      rl.close();
      doActivate(k);
    });
    return;
  }
  if (!key) {
    console.log(bad('用法: modelhub activate <key>'));
    console.log('  ' + DIM + '安全模式: modelhub activate --stdin (从 stdin 交互输入, 不暴露在进程列表/shell 历史中)' + RESET);
    return;
  }
  doActivate(key);
}

async function doActivate(key) {
  if (!key) { console.log(bad('授权码不能为空')); return; }
  license.saveLicenseKey(key);
  console.log('  ' + DIM + '正在向授权服务器验证...' + RESET);
  const r = await license.checkLicense();
  if (r.ok && r.licensed) {
    console.log(ok('许可证已激活'));
    if (r.tier) console.log('  ' + DIM + '授权档位: ' + RESET + r.tier);
    if (r.expires_at) console.log('  ' + DIM + '有效期至: ' + RESET + r.expires_at);
    if (r.remaining_days != null) console.log('  ' + DIM + '剩余天数: ' + RESET + r.remaining_days);
    if (r.offline) console.log('  ' + YELLOW + '⚠ 离线模式：使用本地缓存（联网重新验证可刷新）' + RESET);
    console.log('  ' + DIM + '授权码已保存至 ' + license.LIC_KEY_FILE + RESET);
  } else {
    console.log(bad('许可证验证失败: ' + (r.error || '未知错误')));
    console.log('  ' + DIM + '请确认授权码正确且未过期，或重新运行 modelhub activate <key>' + RESET);
  }
}

// ---------- 主入口 ----------
const args = process.argv.slice(2);
const cmd = args[0] || 'start'; // 无参数时默认启动代理（双击 exe 即可直接用）
const cmdArgs = args.slice(1);

switch (cmd) {
  case 'start': cmdStart(cmdArgs); break;
  case 'stop': cmdStop(); break;
  case 'status': cmdStatus(); break;
  case 'models': cmdModels(); break;
  case 'switch': cmdSwitch(cmdArgs); break;
  case 'keys': cmdKeys(cmdArgs); break;
  case 'ui': cmdUI(); break;
  case 'doctor': cmdDoctor(); break;
  case 'selftest': cmdSelftest(); break;
  case 'activate': cmdActivate(cmdArgs); break;
  case 'help': case '--help': case '-h': cmdHelp(); break;
  case '--version': case '-v':
    const pkg = require('../package.json');
    console.log('ModelHub v' + pkg.version);
    break;
  default:
    console.log(bad('未知命令: ' + cmd));
    console.log('  ' + DIM + '运行 modelhub help 查看可用命令' + RESET);
}
