# Windows 任务计划程序一键卸载脚本 (Unregister WorkBuddy Daily Active Scheduler)
$ErrorActionPreference = 'SilentlyContinue'
$TaskName = "WorkBuddyDailyActive"

Write-Host "正在卸载 Windows 计划任务 [$TaskName]..." -ForegroundColor Yellow
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "计划任务已成功移除！" -ForegroundColor Green
