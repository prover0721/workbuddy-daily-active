# Windows 任务计划程序一键注册脚本 (Register WorkBuddy Daily Active Scheduler)
$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$TaskName = "WorkBuddyDailyActive"
$NodeExe = "node.exe"
if (Test-Path "C:\Program Files\nodejs\node.exe") {
    $NodeExe = "C:\Program Files\nodejs\node.exe"
}

$Action = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$ScriptDir\daily-active.mjs`"" -WorkingDirectory $ScriptDir
$Trigger = New-ScheduledTaskTrigger -Daily -At "08:30AM"
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Write-Host "正在注册 Windows 每日定时计划任务 [$TaskName]..." -ForegroundColor Cyan

# 移除旧任务（若存在）
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

# 注册新任务
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "WorkBuddy 国际版多账号每日 0 消耗保活与活跃积分结算任务" | Out-Null

Write-Host "计划任务注册成功！" -ForegroundColor Green
Write-Host "执行时间: 每天早晨 08:30 (若电脑未开机，开机后将自动补跑)" -ForegroundColor Green
Write-Host "任务名称: $TaskName" -ForegroundColor Yellow