@echo off
setlocal EnableExtensions
cd /d D:\claude-code-proxy-setup
set MODELHUB_NO_OPEN=1
REM === 方案 B：图片请求路由到支持视觉的模型 ===
REM 视觉后端（必须已在 config.json 配置且有 key）。
REM 注意：当前 SiliconFlow 账户余额不足（调用视觉模型返回 insufficient balance），
REM 且本机仅有 deepseek(纯文本、不支持图片) 一个可用 key，故视觉模型暂不可用。
REM 已禁用视觉路由：含图片请求会被安全剔除图片后走 DeepSeek 文本模型（不崩溃，但模型看不到图）。
REM 重新启用：给 SiliconFlow 充值后取消下面两行注释即可（或新增 GEMINI_KEY/QWEN_KEY 换成对应 provider）。
REM set MODELHUB_VISION_PROVIDER=siliconflow
REM set MODELHUB_VISION_MODEL=Qwen/Qwen3-VL-8B-Instruct
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
