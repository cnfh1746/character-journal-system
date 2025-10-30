@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo ====================================
echo 角色日志系统 - 一键上传到GitHub
echo ====================================
echo.

REM 检查是否是git仓库
if not exist ".git" (
    echo [错误] 当前目录不是git仓库
    echo 请先运行 init.bat 初始化仓库
    echo.
    pause
    exit /b 1
)

echo [1/3] 添加文件...
git add .

echo.
echo [2/3] 提交更改...
git commit -m "Update: %date% %time%"
if %errorlevel% equ 0 (
    echo 提交成功
) else (
    echo 没有需要提交的更改
)

echo.
echo [3/3] 强制推送到GitHub (覆盖远程版本)...
git push origin main --force

if %errorlevel% neq 0 (
    echo.
    echo ====================================
    echo [错误] 推送失败！
    echo 可能的原因：
    echo  1. 网络问题
    echo  2. 权限问题
    echo ====================================
    echo.
    pause
    exit /b 1
)

echo.
echo ====================================
echo 上传完成！(已覆盖远程仓库)
echo ====================================
pause
