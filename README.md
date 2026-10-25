# WorkBuddy Daily Active & Automation Exploration (WorkBuddy 每日自动化活跃与积分查询)

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18%2B-brightgreen" alt="Node.js 18+">
  <img src="https://img.shields.io/badge/Language-JavaScript%20%7C%20PowerShell-blue" alt="Language">
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="License">
  <img src="https://img.shields.io/badge/Status-Feasibility%20Study-orange" alt="Status">
</p>

[中文说明](#中文文档) | [English Documentation](#english-documentation)

---

<a name="中文文档"></a>
## ⚠️ 严正免责声明与风险提示 (Disclaimer & Risk Notice)

> ### 📢 特别说明 (Special Notice)
> **本项目仅提供一个技术思考与学术交流的原型，旨在展示“基于本地凭据管理实现多账号 API 周期性调度与高精度状态监控”这一流程的技术可行性。**
> 
> 1. **风险不定声明**：
>    - 使用任何自动化脚本、程序化手段与第三方平台接口交互，其行为在平台层面的合规性、安全性及规则判定**存在极大的不确定性与潜在风险**。
>    - 第三方服务商（包括但不限于 WorkBuddy 及其关联方）的 API 结构、服务条款（Terms of Service）、防刷风控机制及积分奖励策略随时可能发生调整、下线或更新。
> 2. **责任完全自负**：
>    - 本项目代码**“按现状”（AS-IS）**提供，作者与贡献者不对代码的稳定性、有效性或持续可用性作任何形式的明示或暗示保证。
>    - 任何个人或组织因运行、参考或分发本项目而直接或间接导致的**账号受限、积分清零、账号封禁、服务终止或其它财产与数据损失**，均由使用者本人完全独立承担，**作者与贡献者概不承担任何直接、间接或连带责任**。
> 3. **合法合规倡议**：
>    - 请勿将本项目用于任何破坏计算机信息系统、恶意消耗服务器资源、批量违规牟利或违反当地法律法规的场景。如果您不同意上述条款，请立即关闭并删除本仓库及相关代码。

---

## 💡 技术思考与核心背景

在许多包含每日活跃积分/激励机制的 AI 服务平台（如 WorkBuddy 国际版）中，系统往往采用**次日自动结算机制**：
- **无须主动打卡**：不存在显式的“签到”按钮或 Claim 接口。
- **活跃度判定**：只要当日账号产生了真实、合规的模型会话记录（即用户活跃热力分 `score > 0`），官方服务集群便会在次日清晨（通常为 06:00~09:40 UTC+8）自动向该账号派发奖励积分包（Bonus Pack，30天有效期）。

本项目围绕这一机制，探索并实现了一套**极低系统开销、零额度消耗、零人工干预**的多账号调度实践方案。

---

## 🌟 核心特性与实现机制

1. **多账号去重与自动续期**：
   - 自动扫描本地 DSH 保险库凭据，按唯一用户 ID (`uid`) 进行智能合并与去重。
   - 自动感知 Token 生命周期，在即将到期时通过官方 `token/refresh` 接口完成无感续期与本地回写。
2. **0 消耗免费模型动态探测**：
   - 优先读取官方模型目录元数据（`.workbuddy-ai-catalog.json`），动态筛选 `billing: 0.00` 且 `free: true` 的模型（如 `deepseek-v4.1-flash`、`hy3`、`step-5-preview` 等），杜绝消耗任何付费或额度积分。
3. **多样化不重复对话生成**：
   - 内置跨计算机、算法、科普、日常思维等多种维度的动态生成提问语料，确保每日各账号的提问千变万化，规避死板的固定内容。
4. **流式极速响应与早停机制**：
   - 对话请求采用 Server-Sent Events (SSE) 流式传输，客户端在收到后端首个有效 Token 应答确认后立即主动断开连接，既留下了合法会话记录，又避免了服务器资源与算力的无效消耗。
5. **高精度积分余额解析**：
   - 深度解析官方订阅包与奖励包结构，直接提取 `CycleCapacityRemainPrecise` 浮点字段，显示精确到小数点后两位（如 `428.21`）的真实余额。
6. **双模运行体验**：
   - **日常托管**：支持一键注册为 Windows 计划任务，每天 08:30 静默执行，开机自动补跑。
   - **交互查询**：提供桌面双击一键运行脚本，并在控制台停顿供查看积分结果。

---

## 🛠️ 快速上手

### 环境需求
- Windows 10 / 11
- Node.js 18.0 或更高版本（支持原生 `fetch`）
- 本地已配置 DSH 凭据环境（或具有兼容的 `~/.dsh/workbuddy-vault/global/*.json` 凭据）

### 1. 手动运行与查分
克隆或下载本仓库后，使用 PowerShell 运行：
```powershell
.\run-daily.ps1
```
或者直接使用 Node.js 执行：
```bash
node daily-active.mjs
```

### 2. 安装后台定时任务（每天 08:30 自动打卡）
以管理员或普通用户身份在当前目录执行：
```powershell
.\install-scheduler.ps1
```
*提示：该脚本会自动配置 `StartWhenAvailable` 特性。若 08:30 时计算机处于关机状态，开机后系统会自动补跑一次。*

### 3. 卸载定时任务
如果不再需要自动执行，可随时运行：
```powershell
.\uninstall-scheduler.ps1
```

---

<a name="english-documentation"></a>
## English Documentation

### ⚠️ Disclaimer & Risk Notice

> ### 📢 Important Note
> **This project is strictly an independent technical feasibility exploration and workflow demonstration. It aims to showcase the technical feasibility of scheduled multi-account API orchestration and precise balance monitoring based on local credential storage.**
>
> 1. **Uncertain Risk Disclaimer**:
>    - Interacting with third-party platform APIs via automated scripts carries **inherent uncertainties and risks** regarding platform terms, compliance, and rate limiting.
>    - Third-party platform policies, anti-bot mechanisms, API endpoints, and reward systems may change, expire, or be modified at any time without notice.
> 2. **Assumption of Risk & No Liability**:
>    - This repository is provided **"AS IS"**, without warranty of any kind, express or implied.
>    - The author and contributors **shall not be held liable** for any account bans, suspensions, balance deductions, service termination, or any other direct or indirect damages resulting from the use or distribution of this software.
>    - Users assume all risks and responsibilities when executing this code.
> 3. **Compliance**:
>    - Do not use this project for any malicious abuse, server exhaustion, unauthorized commercial exploitation, or activities violating local regulations.

---

### 💡 Features

- **Multi-Account Deduplication & Refresh**: Automatically discovers credentials from the local vault, merges accounts by `uid`, and handles OAuth token refresh transparently.
- **Dynamic 0-Credit Model Discovery**: Reads the local model catalog to select models with `billing: 0.00` / `free: true` dynamically.
- **Varied & Natural Conversations**: Generates randomized questions across computer science, system debugging, science trivia, and daily life tips to prevent repetitive dialogue.
- **Early-Termination SSE Handling**: Aborts the SSE stream immediately upon receiving the initial response chunk, minimizing bandwidth and server consumption while recording valid activity.
- **High-Precision Balance Queries**: Parses `CycleCapacityRemainPrecise` to report balances accurate to two decimal places.
- **Windows Task Scheduler Integration**: Comes with simple PowerShell scripts to install (`install-scheduler.ps1`) or uninstall (`uninstall-scheduler.ps1`) daily background tasks (runs at 08:30 AM with missed-task catch-up).

---

### 🚀 Usage

#### Prerequisites
- Node.js 18.0+
- Windows PowerShell 5.1 / PowerShell 7+

#### Run Manually
```powershell
# Interactive run with console pause
.\run-daily.ps1

# Direct Node.js execution
node daily-active.mjs
```

#### Install Scheduled Task
```powershell
.\install-scheduler.ps1
```

#### Remove Scheduled Task
```powershell
.\uninstall-scheduler.ps1
```

---

## 📄 License
This project is licensed under the [MIT License](LICENSE).
