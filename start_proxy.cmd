@echo off
setlocal EnableExtensions
cd /d D:\claude-code-proxy-setup
set MODELHUB_NO_OPEN=1
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
