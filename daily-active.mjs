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

import { readFileSync, writeFileSync, readdirSync, existsSync, appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
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
const LOCK_FILE = resolve(__dirname, '.daily-active.lock');

// ---------------------------------------------------------------------------
// 防风控配置
// ---------------------------------------------------------------------------
// 客户端版本指纹：与官方客户端保持一致 (可用环境变量 WB_APP_VERSION 覆盖)
const APP_VERSION = process.env.WB_APP_VERSION || '5.9.4';
const USER_AGENT = `WorkBuddyAI/${APP_VERSION}`;
// 国内版成长中心 (旅行/抽奖/任务/连登/补签) 默认关闭：国际版无这些接口，盲目探测会被风控识别为扫描行为。
// 国内版用户可设置环境变量 WB_CN_FEATURES=1 开启。
const ENABLE_CN_FEATURES = process.env.WB_CN_FEATURES === '1';
// 账号被 11140 限制后，冷却多少天再重新尝试 (期间完全不发请求)
const RESTRICT_COOLDOWN_DAYS = 3;
// --force 参数：忽略“今日已成功”与“冷却期”保护
const FORCE = process.argv.includes('--force');
const LOG_MAX_BYTES = 1024 * 1024;

// 全局请求超时 (20s)，避免网络异常时程序无限挂起
const _rawFetch = globalThis.fetch;
globalThis.fetch = (url, opts = {}) =>
  _rawFetch(url, { signal: AbortSignal.timeout(20000), ...opts });

/** 拟人化随机延迟 (毫秒区间) */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => sleep(min + Math.floor(Math.random() * (max - min)));

/** 本地时区日期 YYYY-MM-DD (避免 UTC 在凌晨 0~8 点算错日期) */
function localDateStr(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 原子写文件：先写临时文件再重命名，防止中途崩溃损坏凭据/状态 */
function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf-8');
  renameSync(tmp, file);
}

// 默认兜底 0 消耗免费模型池 (官方目录认证：billing: x0.00 / free: true)
const DEFAULT_FREE_MODELS = [
  'deepseek-v4.1-flash',
  'hy3'
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
          if (isFree && m.id && m.id !== 'step-5-preview' && !detected.includes(m.id)) {
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

// 提示词主题库：聚焦真实开发者日常提问 (短问短答)，与 WorkBuddy 代码助手的正常使用画像一致
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const TOPIC_TEMPLATES = [
  () => `用一句话解释 ${pick(['快速排序', '哈希表冲突处理', '零拷贝技术', '并发死锁原理', 'TCP 三次握手', '协程与线程的区别', 'LRU 缓存算法', '数据库索引的 B+ 树结构'])}。`,
  () => `在 ${pick(['Python', 'JavaScript', 'Go', 'Rust', 'TypeScript', 'Java'])} 中，如何优雅地实现${pick(['异步错误处理', '深拷贝对象', '数组去重', '字符串格式化', '带超时的请求', '时间戳转日期'])}？请给出一行核心代码。`,
  () => `${pick(['git rebase 和 git merge', 'Docker 的 COPY 和 ADD', 'REST 和 GraphQL', 'SQL 的 INNER JOIN 和 LEFT JOIN', 'Promise.all 和 Promise.allSettled', 'let 和 const'])} 的核心区别是什么？30 字以内。`,
  () => `写一个${pick(['校验邮箱格式', '匹配十六进制颜色值', '提取 URL 中域名', '匹配 11 位手机号'])}的正则表达式，并用一句话说明。`,
  () => `给出${pick(['撤销上一次 git commit 但保留改动', '查看 Docker 容器日志最后 100 行', '统计目录下文件数量', '查找占用 8080 端口的进程'])}的常用命令。`,
  () => `${pick(['如何减小 Docker 镜像体积', '前端首屏加载变慢的常见原因', 'Node.js 内存泄漏的排查思路', 'MySQL 慢查询的优化步骤'])}？请用三个要点简要回答。`
];

function log(msg) {
  const time = new Date().toLocaleString('zh-CN', { hour12: false });
  const line = `[${time}] ${msg}`;
  console.log(line);
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      renameSync(LOG_FILE, LOG_FILE + '.old'); // 日志超过 1MB 自动轮转，保留一份旧日志
    }
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
    atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log(`保存运行状态失败: ${e.message}`);
  }
}

function clientToken(prefix = 'u') {
  return prefix + crypto.randomBytes(16).toString('hex');
}

// 每日签到活动自适应（国内版开启时自动领取）
async function tryDailyCheckin(accountInfo) {
  try {
    const res = await fetch(`${BASE_URL}/v2/billing/meter/checkin-activity-status`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accountInfo.accessToken}`,
        'X-User-Id': accountInfo.uid,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': USER_AGENT
      },
      body: '{}'
    });
    if (res.status === 200) {
      const json = await res.json();
      const d = json.data;
      if (d && d.active) {
        if (!d.today_checked_in) {
          const claimRes = await fetch(`${BASE_URL}/v2/billing/meter/daily-checkin`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accountInfo.accessToken}`,
              'X-User-Id': accountInfo.uid,
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              'User-Agent': USER_AGENT
            },
            body: '{}'
          });
          if (claimRes.status === 200) {
            const claimJson = await claimRes.json();
            const credit = claimJson.data?.credit || d.daily_credit || 100;
            log(`  [签到] 成功领取今日签到积分 +${credit}！(连签 ${d.streak_days + 1} 天)`);
            return;
          }
        } else {
          log(`  [签到] 今日已签到 (连签 ${d.streak_days} 天)`);
          return;
        }
      }
    }
  } catch (err) {}
}

// 成长中心自适应巡检与自动领奖 (礼物/任务/连登兑换/抽奖/补登)
async function runGrowthCenter(accountInfo) {
  const headers = {
    'Authorization': `Bearer ${accountInfo.accessToken}`,
    'X-User-Id': accountInfo.uid,
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  const results = [];

  // 1. Buddy 旅行：领礼物 & 派出发
  try {
    const sRes = await fetch(`${BASE_URL}/v2/activity/growth/buddy/travel/status`, { headers });
    if (sRes.status === 200) {
      const sJson = await sRes.json();
      const state = sJson.data?.state;
      const dailyLimit = sJson.data?.daily_limit_reached;

      if (state === 'arrived') {
        const recordId = sJson.data?.record_id;
        const cRes = await fetch(`${BASE_URL}/v2/activity/growth/buddy/travel/claim`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ record_id: recordId })
        });
        if (cRes.status === 200) {
          const cJson = await cRes.json();
          const gotCredit = cJson.data?.reward_credit ?? 0;
          results.push(`领旅行礼物 +${gotCredit} 积分`);
        }
      } else if (state === 'traveling') {
        const locName = sJson.data?.location?.name || '旅途';
        results.push(`Buddy 旅行中 (${locName})`);
      }

      if ((state === 'idle' || state === 'arrived') && !dailyLimit) {
        const cfgRes = await fetch(`${BASE_URL}/v2/activity/growth/buddy/travel/config`, { headers });
        if (cfgRes.status === 200) {
          const cfgJson = await cfgRes.json();
          const locations = cfgJson.data?.locations || [];
          if (locations.length > 0 && locations[0].id) {
            const dRes = await fetch(`${BASE_URL}/v2/activity/growth/buddy/travel/depart`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ location_id: locations[0].id })
            });
            if (dRes.status === 200) {
              const dJson = await dRes.json();
              if (dJson.code === 0) {
                const loc = dJson.data?.location?.name || locations[0].name || '新地点';
                const dur = dJson.data?.duration_hours || '几';
                results.push(`派 Buddy 去${loc} (${dur}小时后回)`);
              }
            }
          }
        }
      }
    }
  } catch (e) {}

  // 2. 任务列表扫描与领奖
  try {
    const tRes = await fetch(`${BASE_URL}/v2/activity/growth/tasks`, { headers });
    if (tRes.status === 200) {
      const tJson = await tRes.json();
      const tasks = tJson.data?.tasks || [];
      for (const t of tasks) {
        if (t.status === 'completed' || t.accept_status === 'completed') {
          const code = t.code || t.task_code;
          const claimRes = await fetch(`${BASE_URL}/v2/activity/growth/tasks/${code}/claim`, {
            method: 'POST',
            headers,
            body: '{}'
          });
          if (claimRes.status === 200) {
            const claimJson = await claimRes.json();
            if (claimJson.code === 0) {
              results.push(`领任务奖「${t.title || code}」`);
            }
          }
        }
      }
    }
  } catch (e) {}

  // 3. 连登阶梯奖励自动兑换 (7天/14天/28天)
  try {
    const rRes = await fetch(`${BASE_URL}/v2/activity/growth/redeem/summary`, { headers });
    if (rRes.status === 200) {
      const rJson = await rRes.json();
      const d = rJson.data || {};
      const tiers = [
        { key: 'starter', tier: '7d', label: '7天连登档' },
        { key: 'advanced', tier: '14d', label: '14天连登档' },
        { key: 'legendary', tier: '28d', label: '28天连登档' }
      ];

      for (const t of tiers) {
        const st = d[t.key + '_status'];
        if (st && st !== 'locked' && st !== 'claimed') {
          const cRes = await fetch(`${BASE_URL}/v2/activity/growth/redeem`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ tier: t.tier, client_token: clientToken('u') })
          });
          if (cRes.status === 200) {
            const cJson = await cRes.json();
            if (cJson.code === 0) {
              const credit = cJson.data?.credit_granted ?? 0;
              results.push(`连登兑换成功「${t.label}」+${credit}积分`);
            }
          }
        }
      }
    }
  } catch (e) {}

  // 4. 盲盒抽奖
  try {
    const lRes = await fetch(`${BASE_URL}/v2/activity/growth/lottery/chances`, { headers });
    if (lRes.status === 200) {
      const lJson = await lRes.json();
      const chances = lJson.data?.balance || 0;
      if (chances > 0) {
        const dRes = await fetch(`${BASE_URL}/v2/activity/growth/lottery/draw`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ client_token: clientToken('u') })
        });
        if (dRes.status === 200) {
          const dJson = await dRes.json();
          if (dJson.code === 0) {
            const prize = dJson.data?.prize_name || dJson.data?.prize || '奖励';
            results.push(`开盲盒获得: ${prize}`);
          }
        }
      }
    }
  } catch (e) {}

  // 5. 断登补签 (持有补登卡且有断签日时触发)
  try {
    const strRes = await fetch(`${BASE_URL}/v2/activity/growth/streak`, { headers });
    if (strRes.status === 200) {
      const strJson = await strRes.json();
      const makeupCards = strJson.data?.makeup_cards?.balance || 0;
      const makeupDates = new Set(strJson.data?.streak?.makeup_dates || []);

      if (makeupCards > 0) {
        const hmRes = await fetch(`${BASE_URL}/v2/activity/growth/heatmap`, { headers });
        if (hmRes.status === 200) {
          const hmJson = await hmRes.json();
          const cells = hmJson.data?.cells || [];
          const now = new Date();
          const currentMonthPrefix = localDateStr(now).slice(0, 7);
          const todayStr = localDateStr(now);

          const candidates = cells
            .filter(c => c.date.startsWith(currentMonthPrefix) && c.date < todayStr && c.score === 0 && !makeupDates.has(c.date))
            .map(c => c.date);

          if (candidates.length > 0) {
            const targetDate = candidates[candidates.length - 1];
            const useRes = await fetch(`${BASE_URL}/v2/activity/growth/makeup-cards/use`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ target_date: targetDate })
            });
            if (useRes.status === 200) {
              const useJson = await useRes.json();
              if (useJson.code === 0) {
                results.push(`自动补登 ${targetDate} (保住连签)`);
              }
            }
          }
        }
      }
    }
  } catch (e) {}

  if (results.length > 0) {
    log(`  [成长中心] ${results.join(' | ')}`);
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
        'User-Agent': USER_AGENT
      },
      body: '{}'
    });

    if (res.status === 200) {
      const json = await res.json();
      if (json.code === 0 && json.data?.accessToken) {
        data.auth.accessToken = json.data.accessToken;
        if (json.data.refreshToken) data.auth.refreshToken = json.data.refreshToken;
        if (json.data.expiresAt) data.auth.expiresAt = json.data.expiresAt;
        atomicWrite(vaultFile, JSON.stringify(data, null, 2));
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
        'User-Agent': USER_AGENT
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
    const res = await fetch(`${BASE_URL}/v2/activity/growth/heatmap`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accountInfo.accessToken}`,
        'X-User-Id': accountInfo.uid,
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': USER_AGENT
      }
    });
    if (res.status === 200) {
      const json = await res.json();
      const cells = json?.data?.cells || [];
      const today = localDateStr();
      const cell = cells.find(c => c.date === today);
      return cell ? cell.score : 0;
    }
  } catch {}
  return null;
}

// 上报客户端活跃事件 (触发官方每日 30 积分奖励结算判定)
async function reportActivityEvent(accountInfo, modelName, conversationId, inputLength = 100) {
  try {
    const now = Date.now();
    const body = [
      {
        eventCode: 'chat_request_send',
        timestamp: now,
        reportDelay: 1000,
        mode: 'unknown',
        conversationId: conversationId || crypto.randomUUID(),
        requestId: crypto.randomBytes(8).toString('hex'),
        inputLength,
        requestModelId: modelName,
        requestModelName: modelName,
        maxSteps: 500,
        mentionContexts: [],
        knowledgeId: [],
        knowledgeName: [],
        agentName: 'cli',
        agentType: 'main',
        timezone: 'Asia/Shanghai',
        traceId: crypto.randomBytes(16).toString('hex'),
        userId: accountInfo.uid,
        username: accountInfo.nickname || accountInfo.email || accountInfo.uid,
        userNickname: accountInfo.nickname || accountInfo.email || accountInfo.uid
      }
    ];

    const res = await fetch(`${BASE_URL}/v2/report`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accountInfo.accessToken}`,
        'X-User-Id': accountInfo.uid,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': USER_AGENT
      },
      body: JSON.stringify(body)
    });
    return res.status === 200;
  } catch (err) {
    log(`[警告] 活跃事件上报异常: ${err.message}`);
    return false;
  }
}

// 解析官方错误体，提取业务错误码
function parseErrorCode(errorText) {
  try {
    const j = JSON.parse(errorText);
    return typeof j?.code === 'number' ? j.code : null;
  } catch {
    return null;
  }
}

// 发起真实合法对话与活跃上报
// 重试策略：仅对网络异常 / 5xx 做 1 次带随机延迟的重试；
// 对 401/403/429 以及风控码 11140 一律不重试，避免对风控拦截点“连撞”加重处罚。
async function sendDailyConversation(accountInfo, modelName, questionText, attempt = 1) {
  const token = accountInfo.accessToken;
  const conversationId = crypto.randomUUID();
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
    'User-Agent': USER_AGENT,
    'X-User-Id': accountInfo.uid,
    'X-Conversation-ID': conversationId,
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
      // 完整读取流直至服务端正常结束 (不提前 cancel，避免产生异常中断特征)
      const reader = res.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }

      // 对话成功后，同步上报官方客户端埋点事件 (将活跃分即刻计入后台)
      await jitter(300, 900);
      await reportActivityEvent(accountInfo, modelName, conversationId, questionText.length);

      return { ok: true, duration: Date.now() - startTime };
    }

    const errorText = await res.text().catch(() => '');
    const code = parseErrorCode(errorText);
    const result = { ok: false, status: res.status, code, error: errorText, duration };

    if (code === 11140) {
      result.restricted = true;
      return result;
    }
    if (res.status >= 500 && attempt === 1) {
      log(`[重试] 服务端 HTTP ${res.status}，稍后用备选模型重试一次...`);
      await jitter(3000, 7000);
      return await sendDailyConversation(accountInfo, 'hy3', questionText, attempt + 1);
    }
    return result;
  } catch (err) {
    if (attempt === 1) {
      log(`[重试] 请求异常 (${err.message})，稍后重试一次...`);
      await jitter(3000, 7000);
      return await sendDailyConversation(accountInfo, 'hy3', questionText, attempt + 1);
    }
    return { ok: false, status: -1, error: err.message, duration: Date.now() - startTime };
  }
}

/** 单实例锁：防止重复启动 (如双击两次) 造成同一账号并发请求 */
function acquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const ageMs = Date.now() - statSync(LOCK_FILE).mtimeMs;
      if (ageMs < 10 * 60 * 1000) return false; // 10 分钟内的锁视为有效；更旧的视为残留
    }
    writeFileSync(LOCK_FILE, String(process.pid), 'utf-8');
  } catch {}
  return true;
}
function releaseLock() {
  try { unlinkSync(LOCK_FILE); } catch {}
}

// 主流程
async function main() {
  if (!acquireLock()) {
    console.log('检测到另一个实例正在运行，本次退出。');
    return;
  }
  process.on('exit', releaseLock);
  process.on('SIGINT', () => process.exit(130));

  log('====================================================');
  log(' 开始执行 WorkBuddy 每日多账号活跃与积分查询任务...');
  if (FORCE) log('[提示] 已启用 --force：忽略“今日已成功”与“风控冷却期”保护。');

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
          email: content.account?.email,
          filePath: fullPath,
          raw: content
        });
      }
    } catch (e) {
      log(`解析账号文件 ${f} 失败: ${e.message}`);
    }
  }

  // 随机打乱账号处理顺序，避免每天固定先后节拍
  const accounts = Array.from(accountsMap.values()).sort(() => Math.random() - 0.5);
  log(`已识别出 ${accounts.length} 个独立有效账号。`);

  // 2. 动态加载 0 消耗免费模型候选池
  const freeModels = getFreeModels();
  const state = loadState();
  state.accountHistory = state.accountHistory || {};
  const todayStr = localDateStr();

  let currentModelIdx = state.modelIndex % freeModels.length;
  const selectedModel = freeModels[currentModelIdx];
  log(`今日选定轮换模型: [${selectedModel}] (0 积分免费模型)`);

  await jitter(1000, 4000);

  // 3. 对每个独立账号执行对话与积分查询
  let successCount = 0;
  let skipCount = 0;
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const hist = state.accountHistory[acc.uid] = state.accountHistory[acc.uid] || {};
    log(`----------------------------------------------------`);
    log(`正在处理第 ${i + 1}/${accounts.length} 个账号: [${acc.nickname}] (UID: ${acc.uid.slice(0, 8)}...)`);

    // 保护 1：今日已成功，不再重复打扰 (一天多次运行也会被风控视为异常频率)
    if (!FORCE && hist.lastSuccessDate === todayStr) {
      log(`[跳过] 今日已成功完成活跃，无需重复请求。`);
      skipCount++;
      continue;
    }
    // 保护 2：风控冷却期内完全不发请求
    if (!FORCE && hist.restrictedUntil && Date.now() < hist.restrictedUntil) {
      const until = new Date(hist.restrictedUntil).toLocaleString('zh-CN', { hour12: false });
      log(`[跳过] 该账号此前被官方风控限制 (11140)，冷却至 ${until}。请先在官方客户端点击“提交反馈”申诉。`);
      skipCount++;
      continue;
    }

    // 检查并刷新 Token
    const activeToken = await refreshTokenIfNeeded(acc.filePath, acc.raw);
    acc.accessToken = activeToken;

    // 查询当前精确积分
    const balanceBefore = await fetchPreciseBalance(acc);
    if (balanceBefore !== null) {
      log(`[${acc.nickname}] 当前积分余额: ${balanceBefore}`);
    }

    await jitter(3000, 7000);

    // 随机抽取完全不同的对话问题
    const randomTopicGen = TOPIC_TEMPLATES[Math.floor(Math.random() * TOPIC_TEMPLATES.length)];
    const question = randomTopicGen();
    log(`发送自然对话: "${question}"`);

    const result = await sendDailyConversation(acc, selectedModel, question);
    if (result.ok) {
      log(`✓ [${acc.nickname}] 对话成功！(耗时 ${result.duration}ms)，已成功在官方服务留下今日活跃记录！`);
      successCount++;
      hist.lastSuccessDate = todayStr;
      hist.consecutiveFailures = 0;
      delete hist.restrictedUntil;
    } else if (result.restricted) {
      hist.restrictedUntil = Date.now() + RESTRICT_COOLDOWN_DAYS * 86400000;
      hist.consecutiveFailures = (hist.consecutiveFailures || 0) + 1;
      log(`⚠ [${acc.nickname}] 触发官方风控 11140 (账号对话功能被限制)。已熔断：不再重试，${RESTRICT_COOLDOWN_DAYS} 天内自动跳过该账号。`);
      log(`  处理建议：在官方客户端弹窗点击【提交反馈】申诉；资产/积分不受影响；其他账号不受影响。`);
      saveState(state);
      if (i < accounts.length - 1) await jitter(3000, 6000);
      continue; // 受限账号不再做任何后续探测请求
    } else {
      hist.consecutiveFailures = (hist.consecutiveFailures || 0) + 1;
      log(`✗ [${acc.nickname}] 对话失败 HTTP ${result.status} (耗时 ${result.duration}ms): ${String(result.error || '').slice(0, 180)}`);
      if (result.status === 401) {
        log(`  登录凭据已失效，请在 WorkBuddy 客户端重新登录该账号。`);
      }
    }

    // 国内版成长中心自动化 (国际版默认关闭，避免对不存在的接口做探测)
    if (ENABLE_CN_FEATURES && result.ok) {
      await jitter(1000, 2500);
      await tryDailyCheckin(acc);
      await runGrowthCenter(acc);
    }

    // 仅在对话成功后查询最新活跃与积分
    if (result.ok) {
      await jitter(1500, 3000);
      const heatmapScore = await fetchHeatmapScore(acc);
      if (heatmapScore !== null) {
        const statusText = heatmapScore > 0 ? ' (今日活跃已点亮，明日清晨自动发放 +30 奖励包)' : ' (活跃分暂未同步)';
        log(`[${acc.nickname}] 今日累计活跃热力分: ${heatmapScore}${statusText}`);
      }
      const balanceAfter = await fetchPreciseBalance(acc);
      if (balanceAfter !== null) {
        log(`[${acc.nickname}] 当前最新积分余额: ${balanceAfter}`);
      }
    }

    saveState(state); // 每个账号处理完立即落盘，防止中途崩溃丢失进度

    if (i < accounts.length - 1) {
      await jitter(3000, 7000);
    }
  }

  // 4. 更新状态与轮换指针 (今日实际发出过请求才轮换)
  state.lastRunDate = todayStr;
  if (successCount > 0) {
    state.modelIndex = (currentModelIdx + 1) % freeModels.length;
  }
  saveState(state);

  log('----------------------------------------------------');
  log(`每日活跃任务执行完成！成功: ${successCount} / ${accounts.length} (跳过 ${skipCount})。下次轮换模型: ${freeModels[state.modelIndex % freeModels.length]}`);
  log('====================================================\n');
}

main().catch(err => {
  log(`程序未捕获异常: ${err.stack || err.message}`);
  process.exit(1);
});
