# PowerShell Execution Wrapper (WorkBuddy Daily Active & Balance Checker)
$ErrorActionPreference = 'Continue'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Set-Location $ScriptDir
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " 正在启动 WorkBuddy 多账号每日活跃与积分查询程序..." -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 优先查找系统中安装的 Node.js
$nodeExe = "node"
if (Test-Path "C:\Program Files\nodejs\node.exe") {
    $nodeExe = "C:\Program Files\nodejs\node.exe"
}

try {
    & $nodeExe "daily-active.mjs"
} catch {
    Write-Host "`n执行过程中遇到异常: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "`n==========================================================" -ForegroundColor Green
Write-Host " 运行完成！详细日志已记录到 daily-active.log。" -ForegroundColor Green
Write-Host " 按任意键退出窗口..." -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Green

# 交互式窗口下按键暂停，防止窗口一闪而过
try {
    [Console]::ReadKey($true) | Out-Null
} catch {
    Start-Sleep -Seconds 3
}