@echo off
setlocal EnableExtensions
cd /d D:\claude-code-proxy-setup
del /f /q "D:\claude-code-proxy-setup\modelhub.stop" >nul 2>&1
schtasks /Change /TN "ModelHubProxy" /Enable >nul 2>&1
schtasks /Run /TN "ModelHubProxy" >nul 2>&1
echo ModelHub proxy starting, available at http://127.0.0.1:4000/start.html in a few seconds
