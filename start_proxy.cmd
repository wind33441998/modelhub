@echo off
setlocal EnableExtensions
cd /d D:\claude-code-proxy-setup
set MODELHUB_NO_OPEN=1
:loop
if exist modelhub.stop (
  echo [%date% %time%] modelhub.stop present, proxy paused. Delete the file to resume. >> proxy_stdout.log
  ping -n 4 127.0.0.1 >nul 2>&1
  goto loop
)
REM rotate stdout log if it grows past 20MB (keep one previous generation)
if exist proxy_stdout.log (
  for %%F in (proxy_stdout.log) do if %%~zF gtr 20971520 move /Y proxy_stdout.log proxy_stdout.1.log >nul 2>&1
)
echo [%date% %time%] starting proxy... >> proxy_stdout.log
"C:\Users\Administrator\.workbuddy\binaries\node\versions\22.12.0\node.exe" "D:\claude-code-proxy-setup\lib\proxy.js" >> proxy_stdout.log 2>&1
echo [%date% %time%] proxy exited code %errorlevel%, restarting in 2s >> proxy_stdout.log
ping -n 3 127.0.0.1 >nul 2>&1
goto loop
