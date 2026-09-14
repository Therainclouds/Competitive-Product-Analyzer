/**
 * LLM HTTP 客户端（v1.5）
 * ------------------------------------------------------------
 * 零依赖直连 Anthropic / OpenAI 兼容 API。
 *
 * 配置（环境变量）：
 *   LLM_PROVIDER   : 'anthropic' (默认) | 'openai'
 *   LLM_API_KEY    : 必需
 *   LLM_MODEL      : 默认 'claude-sonnet-4-5'（anthropic）/ 'gpt-4o-mini'（openai）
 *   LLM_BASE_URL   : 可选，覆盖默认 endpoint
 *
 * 接口：
 *   chat({ messages, system?, temperature?, maxTokens?, jsonMode? })
 *     → { text, usage, elapsed_ms, model }
 *
 *   messages  : [{ role: 'user'|'assistant', content: '...' }, ...]
 *   system    : 可选 system prompt
 *   jsonMode  : true → 提示模型返回合法 JSON（OpenAI 走 response_format）
 *
 * 设计哲学：
 *   - 零 npm 依赖，用 Node 内置 https 模块
 *   - 沿用 probes/shared/http.js 的「真实 UA + 重试 + 超时」风格
 *   - 失败抛 Error（含 HTTP 状态 + body 头 200 字），证据池可记录
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ---- 零依赖 .env 加载（仅在环境变量未设置时生效，避免覆盖真实 export）----
let _envLoaded = false;
function loadEnv() {
  if (_envLoaded) return;
  _envLoaded = true;
  const envPath = path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    // 去掉可选引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // 关键：只在 process.env 未设时填入
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv();

// ---- 默认配置 ----
const DEFAULTS = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    path: '/v1/messages',
    model: 'claude-sonnet-4-5',
    version: '2023-06-01',
  },
  openai: {
    baseUrl: 'https://api.openai.com',
    path: '/v1/chat/completions',
    model: 'gpt-4o-mini',
  },
};

// ---- 运行时配置覆盖（来自工作台设置，优先级高于 .env）----
// 由 workbench/server.js 启动时从 settings.json 载入、保存时更新
let _runtime = null; // { provider?, apiKey?, baseUrl?, model? }

function setRuntimeConfig(cfg) {
  _runtime = cfg && Object.keys(cfg).length ? cfg : null;
}
function getRuntimeConfig() {
  return _runtime;
}

/** 掩码 key：只保留末 4 位 */
function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return '****';
  return '••••' + k.slice(-4);
}

/** 当前是否可用（不抛错版本，供 UI 探测） */
function isConfigured() {
  try { config(); return true; } catch { return false; }
}

function config() {
  const provider = ((_runtime && _runtime.provider) || process.env.LLM_PROVIDER || 'anthropic').toLowerCase();
  const apiKey = (_runtime && _runtime.apiKey) || process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error('LLM_API_KEY 未配置。请在工作台 ⚙️ 设置中填入，或设置环境变量 LLM_API_KEY。');
  }
  const baseDef = DEFAULTS[provider];
  if (!baseDef) {
    throw new Error(`不支持的 LLM_PROVIDER: ${provider}（仅 anthropic / openai）`);
  }
  const baseUrl = (_runtime && _runtime.baseUrl) || process.env.LLM_BASE_URL || baseDef.baseUrl;
  const model = (_runtime && _runtime.model) || process.env.LLM_MODEL || baseDef.model;
  return { provider, apiKey, baseUrl, model, version: baseDef.version };
}

/**
 * 零依赖 HTTPS POST（JSON body + JSON 期望响应）
 * 复用 fetchUrl 的退避风格，但支持 POST + body
 */
function postOnce(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function postWithRetry(url, headers, body, timeoutMs = 90000, retries = 1) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await postOnce(url, headers, body, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * 主入口：chat({ messages, system?, temperature?, maxTokens?, jsonMode? })
 */
async function chat(opts) {
  const cfg = config();
  const { messages, system, temperature = 0.5, maxTokens = 2048, jsonMode = false } = opts;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('chat: messages 必须是非空数组');
  }

  const started = Date.now();

  if (cfg.provider === 'anthropic') {
    return await chatAnthropic(cfg, { messages, system, temperature, maxTokens, jsonMode }, started);
  } else {
    return await chatOpenAI(cfg, { messages, system, temperature, maxTokens, jsonMode }, started);
  }
}

// ---- Anthropic 实现 ----

async function chatAnthropic(cfg, opts, started) {
  const { messages, system, temperature, maxTokens, jsonMode } = opts;

  // jsonMode 走 prompt 约束 + 后置 JSON.parse 截取
  let finalSystem = system || '';
  if (jsonMode) {
    finalSystem = (finalSystem ? finalSystem + '\n\n' : '') +
      '【输出格式约束】你的输出必须是合法 JSON，不要包含任何 Markdown 代码块、注释或解释性文字。直接输出 JSON。';
  }

  const reqBody = {
    model: cfg.model,
    max_tokens: maxTokens,
    temperature,
    messages,
  };
  if (finalSystem) reqBody.system = finalSystem;

  const url = cfg.baseUrl + DEFAULTS.anthropic.path;
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': cfg.apiKey,
    'anthropic-version': cfg.version,
    'User-Agent': 'CompetitorXRay-LLM/1.5',
  };

  const res = await postWithRetry(url, headers, JSON.stringify(reqBody));
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`LLM(anthropic) HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }

  const data = JSON.parse(res.body);
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  // jsonMode 后置提取
  let finalText = text;
  if (jsonMode) {
    finalText = extractJson(text);
  }

  return {
    text: finalText,
    raw_text: text,
    usage: data.usage || {},
    elapsed_ms: Date.now() - started,
    model: data.model || cfg.model,
  };
}

// ---- OpenAI 实现 ----

async function chatOpenAI(cfg, opts, started) {
  const { messages, system, temperature, maxTokens, jsonMode } = opts;

  const finalMessages = [];
  if (system) finalMessages.push({ role: 'system', content: system });
  if (jsonMode) {
    finalMessages.push({ role: 'system', content: '你的输出必须是合法 JSON，不要包含 Markdown 代码块。' });
  }
  finalMessages.push(...messages);

  const reqBody = {
    model: cfg.model,
    messages: finalMessages,
    temperature,
    max_tokens: maxTokens,
  };
  if (jsonMode) reqBody.response_format = { type: 'json_object' };

  const url = cfg.baseUrl + DEFAULTS.openai.path;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${cfg.apiKey}`,
    'User-Agent': 'CompetitorXRay-LLM/1.5',
  };

  const res = await postWithRetry(url, headers, JSON.stringify(reqBody));
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`LLM(openai) HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }

  const data = JSON.parse(res.body);
  const text = data.choices?.[0]?.message?.content || '';
  return {
    text,
    raw_text: text,
    usage: data.usage || {},
    elapsed_ms: Date.now() - started,
    model: data.model || cfg.model,
  };
}

// ---- JSON 提取辅助 ----

/**
 * 从 LLM 文本中提取 JSON。处理几种常见情况：
 *   - 纯 JSON
 *   - ```json ... ``` 代码块
 *   - 前后有废话的 JSON
 */
function extractJson(text) {
  const trimmed = text.trim();

  // 情况 1：纯 JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch (_) {}
  }

  // 情况 2：```json ... ``` 代码块
  const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1]); } catch (_) {}
  }

  // 情况 3：找第一个 { 和最后一个 }（含嵌套大括号）
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try { return JSON.parse(candidate); } catch (_) {
      // 尝试去掉尾随逗号等常见 LLM JSON 错误
      try {
        return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
      } catch (_) {}
    }
  }

  // 情况 4：截短 + 重试（剥掉前缀 markdown 噪音）
  // LLM 有时输出 "{...}\n\n注：..." — 找最大合法 JSON 子串
  let depth = 0, start = -1, end = -1;
  for (let i = firstBrace; i >= 0 && i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch (_) {}
  }

  throw new Error('extractJson: 无法从 LLM 输出中提取合法 JSON');
}

/**
 * 连接测试：用给定配置（或当前配置）发一条最小消息，15s 超时
 * cfg: { provider?, apiKey?, baseUrl?, model? } —— 缺省项走现有配置
 * 成功返回 { ok: true, latency_ms, model }；失败抛 Error（含可读原因）
 */
async function testConnection(cfg = {}) {
  const saved = _runtime;
  try {
    // apiKey 留空表示「用现有配置测」
    const merged = { ...(saved || {}), ...Object.fromEntries(Object.entries(cfg).filter(([, v]) => v)) };
    setRuntimeConfig(merged);
    const res = await chat({
      messages: [{ role: 'user', content: '回复 ok 两个字母即可' }],
      maxTokens: 8,
      temperature: 0,
    });
    return { ok: true, latency_ms: res.elapsed_ms || 0, model: config().model, sample: String(res.text).trim().slice(0, 20) };
  } finally {
    setRuntimeConfig(saved);
  }
}

module.exports = { chat, config, extractJson, setRuntimeConfig, getRuntimeConfig, isConfigured, maskKey, testConnection, DEFAULTS };
