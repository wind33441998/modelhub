#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build anymodel-for-claude-code.skill from the plugin skill folder.

Produces a .skill zip whose top-level directory is `anymodel-for-claude-code/`,
containing SKILL.md + scripts/ (matches the standalone Claude Code skill layout).
Excludes runtime data, logs, git, node_modules.
"""
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "plugins", "anymodel-for-claude-code",
                   "skills", "anymodel-for-claude-code")
OUT = os.path.join(ROOT, "anymodel-for-claude-code.skill")

# ---- 单一源同步 ----
# lib/proxy.js 是代理的唯一可信源。Skill 副本 scripts/proxy.js 由它自动生成，
# 仅把运行态的资源路径 (../assets, ../proxy_*.log, ../modelhub.stop, ../proxy_crash.log)
# 适配为 Skill 副本的同目录路径。这样改 lib/proxy.js 一处，build 自动同步 Skill 副本，
# 避免两份代码手工不同步。
LIB_PROXY = os.path.join(ROOT, "lib", "proxy.js")
SKILL_PROXY = os.path.join(SRC, "scripts", "proxy.js")
REPLACEMENTS = [
    ("path.join(__dirname, '..', 'assets', 'config.json')", "path.join(__dirname, 'config.json')"),
    ("path.join(__dirname, '..', 'assets', name)", "path.join(__dirname, name)"),
    ("path.join(__dirname, '..', 'proxy_debug.log')", "path.join(__dirname, 'proxy_debug.log')"),
    ("path.join(__dirname, '..', 'upstream_dump.log')", "path.join(__dirname, 'upstream_dump.log')"),
    ("path.join(__dirname, '..', 'modelhub.stop')", "path.join(__dirname, 'modelhub.stop')"),
    ("path.join(__dirname, '..', 'proxy_crash.log')", "path.join(__dirname, 'proxy_crash.log')"),
]

def sync_proxy():
    if not os.path.isfile(LIB_PROXY):
        print("WARN: lib/proxy.js not found, skip skill proxy sync")
        return
    with open(LIB_PROXY, "r", encoding="utf-8") as f:
        src = f.read()
    for a, b in REPLACEMENTS:
        src = src.replace(a, b)
    os.makedirs(os.path.dirname(SKILL_PROXY), exist_ok=True)
    with open(SKILL_PROXY, "w", encoding="utf-8") as f:
        f.write(src)
    print("Synced scripts/proxy.js <- lib/proxy.js")

EXCLUDE_DIRS = {".git", "data", "__pycache__", "node_modules"}
EXCLUDE_EXT = {".log"}
EXCLUDE_FILES = {".gitignore"}

if not os.path.isdir(SRC):
    print("ERROR: skill source not found:", SRC)
    sys.exit(1)

sync_proxy()

count = 0
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, dirnames, filenames in os.walk(SRC):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fn in sorted(filenames):
            if fn in EXCLUDE_FILES:
                continue
            if os.path.splitext(fn)[1] in EXCLUDE_EXT:
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, SRC)
            arc = os.path.join("anymodel-for-claude-code", rel)
            z.write(full, arc)
            count += 1

print(f"Built {OUT}  ({count} files)")
