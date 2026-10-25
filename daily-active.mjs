#!/usr/bin/env node
/**
 * WorkBuddy Multi-Account Daily Active Automation (WorkBuddy Daily Active)
 * 
 * ==============================================================================
 * 免责声明 / DISCLAIMER:
 * 本项目仅供技术研究、学术交流与自动化流程可行性探索，不构成任何商业建议或服务承诺。
 * 本项目与 WorkBuddy 官方无任何隶属或合作关系。使用自动化方式调用接口可能涉及不确定的
 * 平台风控规则、使用条款变更或账号风险。使用者须自行对账号安全与调用行为承担全部责任。
 * ==============================================================================
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import crypto from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 自动适配当前用户的 DSH 凭据存储路径 (Portable Path)
const USER_HOME = os.homedir();
const VAULT_DIR = join(USER_HOME, '.dsh', 'workbuddy-vault', 'global');
const CATALOG_FILE = join(USER_HOME, '.dsh', '.workbuddy-ai-catalog.json');
const LOG_FILE = resolve(__dirname, 'daily-active.log');
const STATE_FILE = resolve(__dirname, 'active-state.json');
const BASE_URL = 'https://www.workbuddy.ai';

// 默认兜底 0 消耗免费模型池 (官方目录认证：billing: x0.00 / free: true)
const DEFAULT_FREE_MODELS = [
  'deepseek-v4.1-flash',
  'hy3',
  'step-5-preview'
];

/**
 * 动态从官方模型目录中扫描获取当前所有 0 计费倍率 (billing: 0.00 / free) 的模型列表
 */
function getFreeModels() {
  try {
    if (existsSync(CATALOG_FILE)) {
      const raw = readFileSync(CATALOG_FILE, 'utf-8');
      const catalog = JSON.parse(raw);
      const detected = [];
      for (const entry of Object.values(catalog.entries || {})) {
        for (const m of (entry.models || [])) {
          const isFree = m.billing?.free === true || m.billing?.credits === 'x0.00' || m.billing?.rate === 0;
          if (isFree && m.id && !detected.includes(m.id)) {
            detected.push(m.id);
          }
        }
      }
      if (detected.length > 0) {
        return detected;
      }
    }
  } catch (err) {}
  return DEFAULT_FREE_MODELS;
}

// 多样化提示词主题库，保证每天不同账号、不同日期的对话内容千变万化且自然真实
const TOPIC_TEMPLATES = [
  // 编程与算法
  () => `请用一句话解释计算机中的${['快速排序', '哈希表冲突处理', '二叉平衡树', '零拷贝技术', '并发死锁原理', 'TCP三次握手', '协程与线程区别', 'RESTful架构', 'LRU缓存算法'][Math.floor(Math.random() * 9)]}。`,
  () => `在 ${['Python', 'JavaScript', 'Go', 'Rust', 'TypeScript', 'C++'][Math.floor(Math.random() * 6)]} 中，如何优雅地处理${['异步异常', '深拷贝对象', '列表扁平化', '字符串格式化', '多线程安全', '时间戳转换'][Math.floor(Math.random() * 6)]}？请给出一行核心代码。`,
  // 科学与生活
  () => `简述${['量子纠缠', '光合作用原理', '黑洞事件视界', 'DNA双螺旋结构', '温室效应', '板块构造学说', '开普勒行星定律'][Math.floor(Math.random() * 7)]}的核心概念（30字以内）。`,
  () => `推荐${['一本经典科幻小说', '一本关于心理学的入门书籍', '一个提高专注力的番茄工作法技巧', '一个程序员日常护眼小贴士', '一种简单的有氧拉伸方法'][Math.floor(Math.random() * 5)]}并简要说明理由。`,
  // 幽默与日常思考
  () => `请分享一个${['关于程序员幽默调侃', '关于人工智能发展的哲理思考', '简短且温暖人心的早安祝福', '适合今天开启高效工作的励志短句'][Math.floor(Math.random() * 4)]}。`,
  () => `请列举三种${['世界上最深的海沟', '历史上有名的天文学家', '最抗逆境的植物', '开源社区著名的协议（如MIT）'][Math.floor(Math.random() * 4)]}并附带一句话介绍。`
];

function log(msg) {
  const time = new Date().toLocaleString('zh-CN', { hour12: false });
  const line = `[${time}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + '\n', 'utf-8');
  } catch {}
}

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {}
  return { lastRunDate: '', modelIndex: 0, accountHistory: {} };
}

function saveState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    log(`保存运行状态失败: ${e.message}`);
  }
}

// 自动刷新 Token
async function refreshTokenIfNeeded(vaultFile, data) {
  const exp = data.auth?.expiresAt;
  const nowSec = Math.floor(Date.now() / 1000);
  // 如果还有超过 24 小时有效期，不需要刷新
  if (exp && exp - nowSec > 86400) {
    return data.auth.accessToken;
  }

  const refreshToken = data.auth?.refreshToken;
  if (!refreshToken) {
    return data.auth?.accessToken;
  }

  log(`账号 [${data.account?.nickname || data.account?.email}] Token 即将到期或未记录到期时间，尝试续期...`);
  try {
    const res = await fetch(`${BASE_URL}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${data.auth.accessToken}`,
        'X-Refresh-Token': refreshToken,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'WorkBuddyAI/5.8.4'
      },
      body: '{}'
    });

    if (res.status === 200) {
      const json = await res.json();
      if (json.code === 0 && json.data?.accessToken) {
        data.auth.accessToken = json.data.accessToken;
        if (json.data.refreshToken) data.auth.refreshToken = json.data.refreshToken;
        if (json.data.expiresAt) data.auth.expiresAt = json.data.expiresAt;
        writeFileSync(vaultFile, JSON.stringify(data, null, 2), 'utf-8');
        log(`账号 [${data.account?.nickname}] Token 续期并回写成功！`);
        return data.auth.accessToken;
      }
    }
    log(`Token 续期响应非预期 (HTTP ${res.status})，继续使用现有 accessToken。`);
  } catch (err) {
    log(`Token 续期请求异常: ${err.message}，继续使用现有 accessToken。`);
  }
  return data.auth.accessToken;
}

// 查询账号当前精确积分余额 (CycleCapacityRemainPrecise)
async function fetchPreciseBalance(accountInfo) {
  try {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const begin = fmt(now);
    const end = fmt(new Date(now.getTime() + 3686 * 86400000));

    const body = {
      PageNumber: 1,
      PageSize: 100,
      ProductCode: 'p_tcaca',
      Status: [0, 3],
      PackageEndTimeRangeBegin: begin,
      PackageEndTimeRangeEnd: end
    };

    const res = await fetch(`${BASE_URL}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accountInfo.accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'X-User-Id': accountInfo.uid,
        'User-Agent': 'WorkBuddyAI/5.8.4'
      },
      body: JSON.stringify(body)
    });

    if (res.status === 200) {
      const json = await res.json();
      const accs = json?.data?.Response?.Data?.Accounts || [];
      let total = 0;
      for (const a of accs) {
        total += parseFloat(a.CycleCapacityRemainPrecise ?? a.CycleCapacityRemain) || 0;
      }
      return (Math.round(total * 100) / 100).toFixed(2);
    }
  } catch {}
  return null;
}

// 查询热力图活跃度积分
async function fetchHeatmapScore(accountInfo) {
  try {
    const res = await fetch(`${BASE_URL}/v2/user/user-score-trend`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accountInfo.accessToken}`,
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'WorkBuddyAI/5.8.4'
      }
    });
    if (res.status === 200) {
      const json = await res.json();
      const points = json?.data?.points || [];
      if (points.length > 0) {
        const last = points[points.length - 1];
        return last.score;
      }
    }
  } catch {}
  return null;
}

// 发起真实合法对话 (带失败自动就地重试1次)
async function sendDailyConversation(accountInfo, modelName, questionText, attempt = 1) {
  const token = accountInfo.accessToken;
  const payload = {
    model: modelName,
    messages: [
      { role: 'system', content: 'You are a helpful and concise AI assistant.' },
      { role: 'user', content: questionText }
    ],
    stream: true
  };

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'User-Agent': 'WorkBuddyAI/5.8.4',
    'X-Conversation-ID': crypto.randomUUID(),
    'X-Conversation-Request-ID': crypto.randomUUID(),
    'X-Conversation-Message-ID': crypto.randomUUID(),
    'X-Agent-Purpose': 'conversation'
  };

  const startTime = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/v2/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    const duration = Date.now() - startTime;
    if (res.status === 200) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let replySnippet = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          const chunk = decoder.decode(value);
          replySnippet += chunk;
          if (replySnippet.length > 200) {
            reader.cancel();
            break;
          }
        }
      }
      return { ok: true, duration };
    } else {
      const errorText = await res.text().catch(() => '');
      if (attempt === 1) {
        log(`[重试] 首选模型 ${modelName} 响应 HTTP ${res.status}，正在重试备选模型...`);
        const fallbackModel = 'hy3';
        return await sendDailyConversation(accountInfo, fallbackModel, questionText, attempt + 1);
      }
      return { ok: false, status: res.status, error: errorText, duration };
    }
  } catch (err) {
    if (attempt === 1) {
      log(`[重试] 请求异常 (${err.message})，正在重试...`);
      return await sendDailyConversation(accountInfo, 'hy3', questionText, attempt + 1);
    }
    return { ok: false, status: -1, error: err.message, duration: Date.now() - startTime };
  }
}

// 主流程
async function main() {
  log('====================================================');
  log(' 开始执行 WorkBuddy 每日多账号活跃与积分查询任务...');

  if (!existsSync(VAULT_DIR)) {
    log(`错误：未找到凭据保险库路径 ${VAULT_DIR}`);
    process.exit(1);
  }

  const files = readdirSync(VAULT_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    log(`警告：保险库目录下没有任何账号凭据文件。`);
    process.exit(0);
  }

  // 1. 读取并按 uid 聚合去重账号
  const accountsMap = new Map();
  for (const f of files) {
    const fullPath = resolve(VAULT_DIR, f);
    try {
      const content = JSON.parse(readFileSync(fullPath, 'utf-8'));
      const uid = content.account?.uid || content.auth?.sub;
      if (!uid) continue;

      if (!accountsMap.has(uid)) {
        accountsMap.set(uid, {
          uid,
          nickname: content.account?.nickname || content.account?.email || content.accountId || uid.slice(0, 8),
          filePath: fullPath,
          raw: content
        });
      }
    } catch (e) {
      log(`解析账号文件 ${f} 失败: ${e.message}`);
    }
  }

  const accounts = Array.from(accountsMap.values());
  log(`已识别出 ${accounts.length} 个独立有效账号。`);

  // 2. 动态加载 0 消耗免费模型候选池
  const freeModels = getFreeModels();
  const state = loadState();
  const todayStr = new Date().toISOString().slice(0, 10);
  
  let currentModelIdx = state.modelIndex % freeModels.length;
  const selectedModel = freeModels[currentModelIdx];
  log(`今日选定轮换模型: [${selectedModel}] (0 积分免费模型)`);

  // 3. 对每个独立账号执行对话与积分查询
  let successCount = 0;
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    log(`----------------------------------------------------`);
    log(`正在处理第 ${i + 1}/${accounts.length} 个账号: [${acc.nickname}] (UID: ${acc.uid.slice(0, 8)}...)`);

    // 检查并刷新 Token
    const activeToken = await refreshTokenIfNeeded(acc.filePath, acc.raw);
    acc.accessToken = activeToken;

    // 查询当前精确积分
    const balanceBefore = await fetchPreciseBalance(acc);
    if (balanceBefore !== null) {
      log(`[${acc.nickname}] 当前积分余额: ${balanceBefore}`);
    }

    // 随机抽取完全不同的对话问题
    const randomTopicGen = TOPIC_TEMPLATES[Math.floor(Math.random() * TOPIC_TEMPLATES.length)];
    const question = randomTopicGen();
    log(`发送自然对话: "${question}"`);

    const result = await sendDailyConversation(acc, selectedModel, question);
    if (result.ok) {
      log(`✓ [${acc.nickname}] 对话成功！(耗时 ${result.duration}ms)，已成功在官方服务留下今日活跃记录！`);
      successCount++;
    } else {
      log(`✗ [${acc.nickname}] 对话失败 HTTP ${result.status} (耗时 ${result.duration}ms): ${result.error?.slice(0, 180)}`);
    }

    // 稍作等待并查询最新活跃与积分
    await new Promise(r => setTimeout(r, 2000));
    const heatmapScore = await fetchHeatmapScore(acc);
    if (heatmapScore !== null) {
      log(`[${acc.nickname}] 今日累计活跃热力分: ${heatmapScore}`);
    }
    const balanceAfter = await fetchPreciseBalance(acc);
    if (balanceAfter !== null) {
      log(`[${acc.nickname}] 当前最新积分余额: ${balanceAfter}`);
    }

    if (i < accounts.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // 4. 更新状态与轮换指针
  state.lastRunDate = todayStr;
  state.modelIndex = (currentModelIdx + 1) % freeModels.length;
  saveState(state);

  log('----------------------------------------------------');
  log(`每日活跃任务执行完成！成功: ${successCount} / ${accounts.length}。明天将轮换模型: ${freeModels[state.modelIndex]}`);
  log('====================================================\n');
}

main().catch(err => {
  log(`程序未捕获异常: ${err.stack || err.message}`);
  process.exit(1);
});
