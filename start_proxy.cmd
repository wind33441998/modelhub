@echo off
setlocal EnableExtensions
cd /d D:\claude-code-proxy-setup
set MODELHUB_NO_OPEN=1
REM === 方案 B：图片请求路由到支持视觉的模型 ===
REM 视觉后端（必须已在 config.json 配置且有 key）。默认硅基流动 DeepSeek-VL2（国内可直连、免费、OpenAI 兼容）。
REM 想换其他视觉模型？改下面两行即可，例如：
REM   Gemini  : MODELHUB_VISION_PROVIDER=gemini   MODELHUB_VISION_MODEL=gemini-2.5-flash
REM   通义千问 : MODELHUB_VISION_PROVIDER=qwen    MODELHUB_VISION_MODEL=qwen-vl-max
REM   智谱 GLM : MODELHUB_VISION_PROVIDER=zhipu   MODELHUB_VISION_MODEL=glm-4v-plus
set MODELHUB_VISION_PROVIDER=siliconflow
REM deepseek-vl2 在硅基流动已不可用(返回 Model disabled)，改用免费的 Qwen3-VL 系列视觉模型
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
