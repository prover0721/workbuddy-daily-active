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

// 默认兜底 0 消耗免费模型池 (优先从本地目录动态校验)
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
      const items = catalog.items || (Array.isArray(catalog) ? catalog : []);
      const detected = [];
      for (const item of items) {
        const id = item.id || item.model_id || item.name;
        const billing = item.billing ?? item.billing_rate ?? item.rate;
        const isFree = item.free === true || billing === 0 || billing === '0' || billing === '0.00';
        if (id && isFree && !detected.includes(id)) {
          detected.push(id);
        }
      }
      if (detected.length > 0) {
        return detected;
      }
    }
  } catch (err) {
    // 降级使用内置认证模型
  }
  return DEFAULT_FREE_MODELS;
}

// 多样化提示词主题库，保证每天不同账号、不同日期的对话内容千变万化且自然真实
const TOPIC_TEMPLATES = [
  // 编程与算法
  () => `请用一句话解释计算机中的${['快速排序', '哈希表冲突处理', '二叉平衡树', '零拷贝技术', '并发死锁原理', 'TCP三次握手', '协程与线程区别', 'RESTful架构', 'LRU缓存淘汰算法', '分布式锁'][Math.floor(Math.random() * 10)]}。`,
  // 系统与开发日常
  () => `开发中遇到${['CPU占用突增', '内存泄漏', '网络偶发超时', '数据库慢查询', 'Git合并冲突', '前端首屏加载慢', 'DNS解析异常'][Math.floor(Math.random() * 7)]}时，最优先排查的步骤是什么？请极简回答。`,
  // 前沿科普与百科
  () => `请简要介绍物理或天文概念：${['量子纠缠', '黑洞事件视界', '詹姆斯韦伯望远镜', '引力透镜效应', '超导临界温度', '宇宙背景辐射'][Math.floor(Math.random() * 6)]}，不超过50字。`,
  // 逻辑与生活常识
  () => `请分享一条关于${['健康用眼', '番茄工作法', '时间管理', '高效阅读', '久坐放松拉伸', '深度睡眠改善'][Math.floor(Math.random() * 6)]}的实用小建议。`,
  // 数学与思维
  () => `计算一道简答题：${['15乘以16等于多少？', '2的10次方是多少？', '什么是费马大定理？', '质数有什么数学特性？'][Math.floor(Math.random() * 4)]}给出答案即可。`
];

function log(msg) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + '\n', 'utf-8');
  } catch (e) {}
}

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch (e) {}
  return { history: {} };
}

function saveState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {}
}

// 查询账号当前精确积分余额 (CycleCapacityRemainPrecise)
async function fetchPreciseBalance(accountInfo) {
  try {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const url = `${BASE_URL}/v2/plugin/user/capacity-package-remain-amount?date=${dateStr}&timeUnit=day`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Authorization': `Bearer ${accountInfo.accessToken}`,
        'Origin': BASE_URL,
        'Referer': `${BASE_URL}/`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!resp.ok) return null;
    const body = await resp.json();
    const data = body.data || body;
    const packages = data.UserCapacityPackageList || data.packages || [];
    
    let totalPrecise = 0;
    for (const pkg of packages) {
      if (pkg.CycleCapacityRemainPrecise !== undefined && pkg.CycleCapacityRemainPrecise !== null) {
        totalPrecise += parseFloat(pkg.CycleCapacityRemainPrecise) || 0;
      } else if (pkg.CycleCapacityRemain !== undefined) {
        totalPrecise += parseFloat(pkg.CycleCapacityRemain) || 0;
      }
    }
    return totalPrecise.toFixed(2);
  } catch (err) {
    return null;
  }
}

// 读取凭据保险库中所有有效账号，按 uid 去重
function loadDistinctAccounts() {
  if (!existsSync(VAULT_DIR)) {
    throw new Error(`找不到凭据保险库目录: ${VAULT_DIR}`);
  }

  const files = readdirSync(VAULT_DIR).filter(f => f.endsWith('.json'));
  const accountsByUid = new Map();

  for (const file of files) {
    const filePath = resolve(VAULT_DIR, file);
    try {
      const content = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (content && content.accessToken) {
        const uid = content.uid || content.email || file;
        // 如果该 uid 尚未记录，或当前文件包含更新的凭据，则采用
        if (!accountsByUid.has(uid) || (content.updatedAt && content.updatedAt > (accountsByUid.get(uid).raw.updatedAt || 0))) {
          accountsByUid.set(uid, {
            filePath,
            fileName: file,
            uid,
            email: content.email || content.username || 'unknown',
            accessToken: content.accessToken,
            refreshToken: content.refreshToken,
            expiresAt: content.expiresAt || 0,
            raw: content
          });
        }
      }
    } catch (err) {
      log(`[警告] 读取凭据文件 ${file} 失败: ${err.message}`);
    }
  }

  return Array.from(accountsByUid.values());
}

// 检查并在需要时自动刷新 Token
async function ensureValidToken(account) {
  const now = Date.now();
  // 提前 5 分钟判断过期
  if (account.expiresAt && account.expiresAt - now > 5 * 60 * 1000) {
    return account.accessToken;
  }

  if (!account.refreshToken) {
    log(`[${account.email}] 无 refreshToken，继续使用现有 accessToken 尝试`);
    return account.accessToken;
  }

  log(`[${account.email}] Token 即将过期或已失效，正在刷新...`);
  try {
    const resp = await fetch(`${BASE_URL}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'WorkBuddyAI/5.8.4',
        'Origin': BASE_URL,
        'Referer': `${BASE_URL}/`
      },
      body: JSON.stringify({ refresh_token: account.refreshToken })
    });

    if (!resp.ok) {
      throw new Error(`刷新失败 HTTP ${resp.status}`);
    }

    const resJson = await resp.json();
    const data = resJson.data || resJson;
    if (data.access_token) {
      account.accessToken = data.access_token;
      if (data.refresh_token) account.refreshToken = data.refresh_token;
      if (data.expires_in) account.expiresAt = now + data.expires_in * 1000;

      // 回写凭据保险库
      account.raw.accessToken = account.accessToken;
      account.raw.refreshToken = account.refreshToken;
      account.raw.expiresAt = account.expiresAt;
      account.raw.updatedAt = now;
      writeFileSync(account.filePath, JSON.stringify(account.raw, null, 2), 'utf-8');
      log(`[${account.email}] Token 刷新成功并已更新本地凭据库`);
      return account.accessToken;
    }
  } catch (err) {
    log(`[${account.email}] 刷新 Token 异常: ${err.message}`);
  }

  return account.accessToken;
}

// 获取当天的热力图与活跃状态
async function fetchUserActivity(token) {
  try {
    const resp = await fetch(`${BASE_URL}/v2/plugin/user/heatmap`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'WorkBuddyAI/5.8.4'
      }
    });
    if (resp.ok) {
      const data = await resp.json();
      const points = data.data?.points || data.points || [];
      const todayStr = new Date().toISOString().slice(0, 10);
      const todayPoint = points.find(p => p.date === todayStr);
      return todayPoint ? todayPoint.score : 0;
    }
  } catch (e) {}
  return null;
}

// 发起一次合法、低消耗/0消耗的真实对话以触发活跃
async function triggerDailyConversation(account, freeModels, retryCount = 0) {
  const token = await ensureValidToken(account);
  // 轮换选择免费模型 (若重试则换下一个)
  const modelIndex = (retryCount) % freeModels.length;
  const selectedModel = freeModels[modelIndex];

  // 动态生成不重复问答提示
  const randomPromptGen = TOPIC_TEMPLATES[Math.floor(Math.random() * TOPIC_TEMPLATES.length)];
  const prompt = randomPromptGen();

  const conversationId = crypto.randomUUID();
  const requestId = crypto.randomUUID();

  log(`[${account.email}] 发起保活对话 -> 模型: [${selectedModel}], 问题: "${prompt}"`);

  const payload = {
    conversation_id: conversationId,
    messages: [
      {
        role: 'user',
        content: prompt
      }
    ],
    model: selectedModel,
    stream: true,
    agent_id: 'default'
  };

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'X-Request-Id': requestId,
    'X-Agent-Purpose': 'general',
    'User-Agent': 'WorkBuddyAI/5.8.4',
    'Origin': BASE_URL,
    'Referer': `${BASE_URL}/`
  };

  const startTime = Date.now();
  const resp = await fetch(`${BASE_URL}/v2/plugin/chat/chat-completion`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    if (retryCount < 1) {
      log(`[${account.email}] 对话请求失败 (HTTP ${resp.status})，尝试更换备选模型重试...`);
      return await triggerDailyConversation(account, freeModels, retryCount + 1);
    }
    throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }

  // 读取前置数据流，一旦确认模型开始应答即可快速关闭流，避免长连接消耗
  let receivedAnyToken = false;
  let replySnippet = '';
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (chunk.includes('data:') || chunk.length > 5) {
        receivedAnyToken = true;
        replySnippet = chunk.slice(0, 100).replace(/\r?\n/g, ' ');
        // 收到首个应答块，已坐实后端计入一次真实有效会话，安全断开
        await reader.cancel();
        break;
      }
    }
  } catch (streamErr) {
    // 忽略主动断开的取消异常
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  log(`[${account.email}] 对话成功响应 (耗时: ${duration}s, 收到应答块: ${receivedAnyToken ? '是' : '否'})`);
  return { success: true, model: selectedModel, prompt, duration };
}

async function main() {
  log('====================================================');
  log(' WorkBuddy 多账号每日活跃打卡程序启动');
  log('====================================================');

  const freeModels = getFreeModels();
  log(`[模型探测] 当前 0 消耗/极低消耗候选池: ${freeModels.join(', ')}`);

  const accounts = loadDistinctAccounts();
  log(`[账号发现] 扫描到 ${accounts.length} 个独立 WorkBuddy 账号`);

  const state = loadState();
  const today = new Date().toISOString().slice(0, 10);
  if (!state.history[today]) {
    state.history[today] = {};
  }

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    log(`----------------------------------------------------`);
    log(`正在处理账号 [${i + 1}/${accounts.length}]: ${acc.email} (UID: ${acc.uid})`);

    try {
      // 1. 查询执行前的当前精确积分
      const initialBalance = await fetchPreciseBalance(acc);
      if (initialBalance !== null) {
        log(`[${acc.email}] 当前积分余额: ${initialBalance}`);
      }

      // 2. 发起轻量对话触发今日活跃
      const result = await triggerDailyConversation(acc, freeModels);

      // 3. 查询执行后的活跃热力图与最新余额
      await new Promise(r => setTimeout(r, 2000)); // 稍作等待以同步服务端统计
      const finalScore = await fetchUserActivity(acc.accessToken);
      const finalBalance = await fetchPreciseBalance(acc);

      log(`[${acc.email}] 今日累计活跃热力分: ${finalScore !== null ? finalScore : '已提交'}`);
      if (finalBalance !== null) {
        log(`[${acc.email}] 结算后积分余额: ${finalBalance}`);
      }

      state.history[today][acc.uid] = {
        email: acc.email,
        time: new Date().toISOString(),
        model: result.model,
        prompt: result.prompt,
        heatmapScore: finalScore,
        balance: finalBalance || initialBalance,
        success: true
      };
    } catch (err) {
      log(`[${acc.email}] 执行失败: ${err.message}`);
      state.history[today][acc.uid] = {
        email: acc.email,
        time: new Date().toISOString(),
        error: err.message,
        success: false
      };
    }
  }

  saveState(state);
  log('====================================================');
  log(' 全部账号活跃打卡与积分查询任务已完成');
  log('====================================================');
}

main().catch(err => {
  log(`[致命错误] ${err.stack || err.message}`);
  process.exit(1);
});
