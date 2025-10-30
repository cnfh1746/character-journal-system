@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo ====================================
echo 角色日志系统 - 一键上传到GitHub
echo ====================================
echo.

git add .
git commit -m "Update: %date% %time%"
git push origin main

echo.
echo ====================================
echo 上传完成！
echo ====================================
pause
