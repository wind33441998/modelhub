#!/usr/bin/env node
/**
 * sync-proxy.js — 将 lib/proxy.js（单一可信源）同步到 plugin Skill 副本
 * 自动调整路径差异，使两份代码仅路径不同，核心逻辑完全一致。
 *
 * 用法: node scripts/sync-proxy.js
 * 也可由 build_skill.py 自动调用（已在 build 流程中内嵌 sync_proxy()）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'lib', 'proxy.js');
const SKILL = path.join(ROOT, 'plugins', 'anymodel-for-claude-code',
  'skills', 'anymodel-for-claude-code', 'scripts', 'proxy.js');

const REPLACEMENTS = [
  ["path.join(__dirname, '..', 'assets', 'config.json')", "path.join(__dirname, 'config.json')"],
  ["path.join(__dirname, '..', 'assets', name)",           "path.join(__dirname, name)"],
  ["path.join(__dirname, '..', 'proxy_debug.log')",        "path.join(__dirname, 'proxy_debug.log')"],
  ["path.join(__dirname, '..', 'upstream_dump.log')",      "path.join(__dirname, 'upstream_dump.log')"],
  ["path.join(__dirname, '..', 'modelhub.stop')",          "path.join(__dirname, 'modelhub.stop')"],
  ["path.join(__dirname, '..', 'proxy_crash.log')",        "path.join(__dirname, 'proxy_crash.log')"],
  ["path.join(__dirname, '..', 'proxy_stdout.log')",       "path.join(__dirname, 'proxy_stdout.log')"],
];

// start.html 也同步（插件有独立副本，与 assets/start.html 保持完全一致）
const START_SRC = path.join(ROOT, 'assets', 'start.html');
const START_DST = path.join(ROOT, 'plugins', 'anymodel-for-claude-code',
  'skills', 'anymodel-for-claude-code', 'scripts', 'start.html');

if (!fs.existsSync(LIB)) {
  console.error('ERROR: lib/proxy.js not found at', LIB);
  process.exit(1);
}

let src = fs.readFileSync(LIB, 'utf-8');
let count = 0;
for (const [from, to] of REPLACEMENTS) {
  const n = src.split(from).length - 1;
  if (n) {
    src = src.replaceAll(from, to);
    count += n;
    console.log(`  replaced ${n}x: ${from.slice(0, 55)}...`);
  }
}

fs.mkdirSync(path.dirname(SKILL), { recursive: true });
fs.writeFileSync(SKILL, src);
console.log(`\n✓ Synced scripts/proxy.js <- lib/proxy.js (${count} replacements)`);

// 同步 start.html
if (fs.existsSync(START_SRC)) {
  fs.mkdirSync(path.dirname(START_DST), { recursive: true });
  fs.copyFileSync(START_SRC, START_DST);
  console.log('✓ Synced scripts/start.html <- assets/start.html');
}
