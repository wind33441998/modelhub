@echo off
setlocal EnableExtensions
cd /d D:\claude-code-proxy-setup
set MODELHUB_NO_OPEN=1
REM === 方案 B：图片请求路由到支持视觉的模型 ===
REM 视觉后端：SiliconFlow 的 Qwen/Qwen3-VL-8B-Instruct（已在 config.json 配置且有 key）。
REM 2026-07-30 已验证 SiliconFlow 充值后 text 与 vision 均正常（视觉返回图片描述）。
REM 启用视觉路由：含图片请求改发 SiliconFlow 视觉模型（模型能看到图）；视觉 key 失效则安全回退剔除图片。
set MODELHUB_VISION_PROVIDER=siliconflow
set MODELHUB_VISION_MODEL=Qwen/Qwen3-VL-8B-Instruct
:loop
if exist modelhub.stop (
  echo [%date% %time%] modelhub.stop present, proxy paused. Delete the file to resume. >> proxy_cmd.log
  ping -n 4 127.0.0.1 >nul 2>&1
  goto loop
)
echo [%date% %time%] starting proxy... >> proxy_cmd.log
"C:\Users\Administrator\.workbuddy\binaries\node\versions\22.12.0\node.exe" "D:\claude-code-proxy-setup\lib\proxy.js" >> proxy_cmd.log 2>&1
echo [%date% %time%] proxy exited code %errorlevel%, restarting in 2s >> proxy_cmd.log
ping -n 3 127.0.0.1 >nul 2>&1
goto loop
