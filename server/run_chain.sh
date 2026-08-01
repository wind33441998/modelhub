#!/bin/bash
# 监管脚本：在本后台任务内拉起 License Server + cloudflared 隧道，并自愈。
set -u
cd /d/claude-code-proxy-setup/server

# 加载 .env（去掉 \r，跳过注释/空行），导出为环境变量
while IFS='=' read -r k v; do
  k="$(echo "$k" | tr -d '\r')"
  v="$(echo "$v" | tr -d '\r')"
  [ -z "$k" ] && continue
  case "$k" in \#*) continue;; esac
  export "$k=$v"
done < <(sed 's/\r$//' .env)

echo "GUMROAD_SECRET_LEN=${#GUMROAD_SECRET}"
NODE=/c/Users/Administrator/.workbuddy/binaries/node/versions/22.12.0/node.exe

start_server() {
  echo "[$(date)] starting server"
  "$NODE" server.js >> /d/claude-code-proxy-setup/server/chain_svc.log 2>&1 &
  echo $! > /tmp/svc.pid
}
start_tunnel() {
  echo "[$(date)] starting tunnel"
  /d/bin/cloudflared.exe tunnel --protocol http2 --edge-ip-version 4 run modelhub-webhook >> /d/claude-code-proxy-setup/server/chain_tunnel.log 2>&1 &
  echo $! > /tmp/tunnel.pid
}

start_server
start_tunnel

while true; do
  sleep 15
  if ! kill -0 "$(cat /tmp/svc.pid 2>/dev/null)" 2>/dev/null; then
    echo "[$(date)] server down, restart"; start_server
  fi
  if ! kill -0 "$(cat /tmp/tunnel.pid 2>/dev/null)" 2>/dev/null; then
    echo "[$(date)] tunnel down, restart"; start_tunnel
  fi
  echo "[$(date)] alive svc=$(kill -0 "$(cat /tmp/svc.pid)" 2>/dev/null && echo yes || echo no) tunnel=$(kill -0 "$(cat /tmp/tunnel.pid)" 2>/dev/null && echo yes || echo no)"
done
