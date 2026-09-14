/**
 * 半人半机工作台 · HTTP 服务（v1.5 + v1.6 discovery · Day 6-7）
 * ------------------------------------------------------------
 * 零依赖：用 Node 内置 http 模块 + 手动路由。
 *
 * 路由：
 *   GET  /                          主页面
 *   GET  /api/reports               列出报告（?slug=&limit=&offset=）
 *   GET  /api/reports/:id           单份报告详情
 *   POST /api/reports               触发新解剖（body: { url, withRedBlue?, ownProduct? }）
 *   POST /api/reports/:id/feedback  提交反馈
 *   GET  /api/stats                 signals_stats
 *   GET  /api/health                健康检查
 *
 * v1.6 新增（竞品发现 · grilling 风格 frontier）：
 *   POST /api/discover/start        启动会话（body: { userIdea }）
 *   POST /api/discover/answer       提交本轮答案（body: { conversationId, answers }）
 *   POST /api/discover/skip         跳过剩余问题立即出候选（body: { conversationId }）
 *   GET  /api/discover/:id          拉取会话完整状态（断线恢复用）
 *
 * 端口：默认 3737（WORKBENCH_PORT 覆盖）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const db = require('../lib/db');
const { dissectOne, assertValidTargetUrl } = require('../lib/pipeline');
const {
  startConversation,
  answerQuestions,
  skipConversation,
} = require('../lib/llm/discover');
const { parseMultipart, extractTextFromFile } = require('../lib/http_multipart');
const { renderMarkdown } = require('../lib/render/md');
const llmClient = require('../lib/llm/client');

// ---- 用户设置（LLM API key 等）持久化到 settings.json ----
const SETTINGS_PATH = path.join(__dirname, '..', 'settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const j = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      if (j && typeof j === 'object') return j;
    }
  } catch (e) {
    console.error('settings.json 读取失败（忽略）:', e.message);
  }
  return {};
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), 'utf8');
}

// 启动时把 settings.json 的应用配置注入 LLM 客户端（优先于 .env）
const _bootSettings = loadSettings();
if (_bootSettings.llm) {
  llmClient.setRuntimeConfig(_bootSettings.llm);
  console.log(`  LLM 配置：已从 settings.json 载入（${_bootSettings.llm.provider || 'anthropic'} · ${_bootSettings.llm.model || '默认模型'}）`);
}

function settingsStatus() {
  const llm = llmClient.getRuntimeConfig() || {};
  let hasKey = false;
  let keyMasked = '';
  let source = 'none';
  try {
    const cfg = llmClient.config(); // 合并 runtime + env 后的有效配置
    hasKey = !!cfg.apiKey;
    keyMasked = llmClient.maskKey(cfg.apiKey);
    source = llm.apiKey ? 'settings.json' : (process.env.LLM_API_KEY ? '.env' : 'none');
    return {
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      hasKey, keyMasked, source,
    };
  } catch {
    return { provider: llm.provider || 'anthropic', baseUrl: '', model: '', hasKey: false, keyMasked: '', source };
  }
}

async function routeGetSettings(req, res) {
  sendJson(res, 200, settingsStatus());
}

/**
 * POST /api/settings
 * body: { provider?, baseUrl?, model?, apiKey?, test? }
 * - apiKey 传空字符串 → 保留现有 key
 * - test=true → 保存前先测连接，失败不落盘
 */
async function routeSaveSettings(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: 'JSON 解析失败: ' + e.message }); }

  const { provider, baseUrl, model } = body;
  let apiKey = (body.apiKey || '').trim();
  const doTest = body.test !== false; // 默认测试

  // 合并出候选配置
  const current = llmClient.getRuntimeConfig() || {};
  const next = {
    provider: (provider || current.provider || 'anthropic').toLowerCase(),
    baseUrl: (baseUrl || '').trim() || current.baseUrl || '',
    model: (model || '').trim() || current.model || '',
    apiKey: apiKey || current.apiKey || '',
  };
  if (!llmClient.DEFAULTS[next.provider]) {
    return sendJson(res, 400, { error: `不支持的 provider: ${next.provider}（仅 anthropic / openai）` });
  }
  if (!next.apiKey) {
    return sendJson(res, 400, { error: 'API Key 不能为空（也没有已保存的 key 可继承）' });
  }

  // 测连接
  let testResult = null;
  if (doTest) {
    try {
      testResult = await llmClient.testConnection({ ...next, apiKey });
    } catch (e) {
      return sendJson(res, 422, { error: '连接测试失败: ' + String(e.message).slice(0, 300), testFailed: true });
    }
  }

  // 落盘 + 生效
  const settings = loadSettings();
  settings.llm = next;
  settings.updated_at = new Date().toISOString();
  try { saveSettings(settings); } catch (e) {
    return sendJson(res, 500, { error: '写入 settings.json 失败: ' + e.message });
  }
  llmClient.setRuntimeConfig(next);
  console.log(`  LLM 配置已更新：${next.provider} · ${next.model || '默认'} · ${llmClient.maskKey(next.apiKey)}`);
  sendJson(res, 200, { ...settingsStatus(), test: testResult });
}

/**
 * POST /api/settings/test —— 只测不落盘；body 可带 draft 配置（apiKey 留空 = 测现有）
 */
async function routeTestSettings(req, res) {
  let body = {};
  try { body = await readBody(req); } catch {}
  try {
    const merged = { ...(llmClient.getRuntimeConfig() || {}) };
    if (body.provider) merged.provider = body.provider;
    if (body.baseUrl) merged.baseUrl = body.baseUrl;
    if (body.model) merged.model = body.model;
    if ((body.apiKey || '').trim()) merged.apiKey = body.apiKey.trim();
    const result = await llmClient.testConnection(merged);
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, 200, { ok: false, error: String(e.message).slice(0, 300) });
  }
}

const PORT = parseInt(process.env.WORKBENCH_PORT || '3737', 10);
const HOST = process.env.WORKBENCH_HOST || '127.0.0.1';
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');

// 任务进度（内存，简单实现；多 worker 时需换 Redis）
const tasks = new Map(); // taskId → { status, progress, reportId? }

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ---- 路由 ----

async function routeIndex(req, res) {
  try {
    const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
  } catch (e) {
    send(res, 500, `index.html 读取失败: ${e.message}`);
  }
}

async function routeListReports(req, res, url) {
  const slug = url.searchParams.get('slug');
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const reports = db.listReports({ slug, limit, offset });
  sendJson(res, 200, { reports, total: reports.length });
}

async function routeGetReport(req, res, url, idStr) {
  const id = parseInt(idStr, 10);
  if (isNaN(id)) return sendJson(res, 400, { error: 'id 必须为整数' });
  const report = db.getReport(id);
  if (!report) return sendJson(res, 404, { error: '报告不存在' });
  const feedbacks = db.getFeedbacksForReport(id);
  sendJson(res, 200, { report, feedbacks });
}

async function routeCreateReport(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: 'JSON 解析失败: ' + e.message }); }

  const { url, withRedBlue = false, ownProduct = '' } = body;
  if (!url || typeof url !== 'string') return sendJson(res, 400, { error: 'url 必填' });

  // URL 预校验：避免 LLM 幻觉出的 "user/repo" 把任务卡到天荒地老
  try {
    assertValidTargetUrl(url);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }

  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  tasks.set(taskId, { status: 'running', progress: '启动解剖', startedAt: Date.now() });

  // 异步执行（不等返回）。硬超时兜底：3 分钟强制终止，任务绝不 pending 超过 3min
  const HARD_TIMEOUT_MS = 180000;
  const hardTimer = setTimeout(() => {
    const t = tasks.get(taskId);
    if (t && t.status === 'running') {
      tasks.set(taskId, { status: 'error', error: `硬超时：超过 ${HARD_TIMEOUT_MS / 1000}s 未完成（已强制终止）` });
    }
  }, HARD_TIMEOUT_MS);

  // 异步执行（不等返回）
  (async () => {
    try {
      tasks.get(taskId).progress = '采集中（技术栈 / 商业模式 / 团队规模）';
      const result = await dissectOne(url, {
        ownProduct,
        withRedBlue: !!withRedBlue,
        writeFiles: null, // 工作台不直接写文件
      });
      tasks.get(taskId).progress = '入库';
      const reportId = db.saveReport({ ...result.report, source: 'workbench' });
      tasks.set(taskId, { status: 'done', reportId, elapsed: result.elapsedMs });
    } catch (e) {
      tasks.set(taskId, { status: 'error', error: e.message });
    } finally {
      clearTimeout(hardTimer);
    }
  })();

  sendJson(res, 202, { taskId, status: 'running' });
}

async function routeGetTask(req, res, url, taskIdStr) {
  const task = tasks.get(taskIdStr);
  if (!task) return sendJson(res, 404, { error: '任务不存在' });
  sendJson(res, 200, { taskId: taskIdStr, ...task });
}

async function routeReportMarkdown(req, res, idStr) {
  const id = parseInt(idStr, 10);
  if (isNaN(id)) return sendJson(res, 400, { error: 'id 必须为整数' });
  const report = db.getReport(id);
  if (!report) return sendJson(res, 404, { error: '报告不存在' });
  try {
    // renderMarkdown 需要 pool.all()；报告里已带 evidence 数组，包一层适配
    const fakePool = { all: () => report.evidence || [] };
    const markdown = renderMarkdown(report, fakePool);
    sendJson(res, 200, { markdown });
  } catch (e) {
    sendJson(res, 500, { error: 'Markdown 渲染失败: ' + e.message });
  }
}

async function routeFeedback(req, res, idStr) {
  const id = parseInt(idStr, 10);
  if (isNaN(id)) return sendJson(res, 400, { error: 'id 必须为整数' });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: 'JSON 解析失败: ' + e.message }); }

  const { pillar, itemRef = null, verdict, note = '' } = body;
  if (!pillar) return sendJson(res, 400, { error: 'pillar 必填' });
  if (!['correct', 'wrong', 'partial', 'unclear'].includes(verdict)) {
    return sendJson(res, 400, { error: 'verdict 必须是 correct/wrong/partial/unclear' });
  }
  const report = db.getReport(id);
  if (!report) return sendJson(res, 404, { error: '报告不存在' });

  const fbId = db.saveFeedback({ reportId: id, pillar, itemRef, verdict, note });
  sendJson(res, 200, { feedbackId: fbId });
}

async function routeStats(req, res) {
  const stats = db.getSignalStats();
  sendJson(res, 200, { signals: stats });
}

async function routeHealth(req, res) {
  sendJson(res, 200, { ok: true, version: 'v1.6', port: PORT });
}

// ---- v1.6: 竞品发现（grilling frontier）----

async function routeDiscoverStart(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: 'JSON 解析失败: ' + e.message }); }
  const { userIdea } = body;
  if (!userIdea || !userIdea.trim()) return sendJson(res, 400, { error: 'userIdea 必填' });

  try {
    const result = await startConversation({ userIdea, db });
    sendJson(res, 200, result);
  } catch (e) {
    console.error('discover start 失败:', e);
    sendJson(res, 500, { error: e.message, hint: '检查 LLM_API_KEY 是否配置' });
  }
}

async function routeDiscoverAnswer(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: 'JSON 解析失败: ' + e.message }); }
  const { conversationId, answers } = body;
  if (!conversationId) return sendJson(res, 400, { error: 'conversationId 必填' });
  if (!answers || typeof answers !== 'object') return sendJson(res, 400, { error: 'answers 必填' });

  try {
    const result = await answerQuestions({ conversationId, answers, db });
    sendJson(res, 200, result);
  } catch (e) {
    console.error('discover answer 失败:', e);
    sendJson(res, 500, { error: e.message });
  }
}

async function routeDiscoverSkip(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: 'JSON 解析失败: ' + e.message }); }
  const { conversationId } = body;
  if (!conversationId) return sendJson(res, 400, { error: 'conversationId 必填' });

  try {
    const result = await skipConversation({ conversationId, db });
    sendJson(res, 200, result);
  } catch (e) {
    console.error('discover skip 失败:', e);
    sendJson(res, 500, { error: e.message });
  }
}

/**
 * multipart 上传：解析文件 → 提取文本 → 启动会话
 * 字段：userIdea（可选）+ file（可选 txt/md/json/csv/html）
 * 若两者都有，文本会拼到 userIdea 前面
 */
async function routeDiscoverUpload(req, res) {
  let parsed;
  try {
    parsed = await parseMultipart(req);
  } catch (e) {
    return sendJson(res, 400, { error: '上传解析失败: ' + e.message });
  }
  const userIdea = (parsed.fields.userIdea || '').trim();
  const files = parsed.files || [];
  if (files.length === 0 && !userIdea) {
    return sendJson(res, 400, { error: '至少提供一段文本或一个文件' });
  }
  // 提取文件文本
  let combinedText = userIdea;
  const fileSummaries = [];
  for (const f of files) {
    const r = extractTextFromFile(f);
    if (r.ok) {
      fileSummaries.push({ name: f.name, length: r.text.length, truncated: r.truncated });
      combinedText = (combinedText ? combinedText + '\n\n' : '') + `【附件：${f.name}】\n${r.text}`;
    } else {
      fileSummaries.push({ name: f.name, error: r.reason });
    }
  }
  // 截断总长度（避免 LLM prompt 超长）
  if (combinedText.length > 12000) {
    combinedText = combinedText.slice(0, 12000) + '\n\n[总输入已截断]';
  }

  try {
    const result = await startConversation({ userIdea: combinedText, db });
    sendJson(res, 200, { ...result, fileSummaries });
  } catch (e) {
    console.error('discover upload 失败:', e);
    sendJson(res, 500, { error: e.message });
  }
}

async function routeGetConversation(req, res, idStr) {
  const id = parseInt(idStr, 10);
  if (isNaN(id)) return sendJson(res, 400, { error: 'id 必须为整数' });
  const conv = db.getConversation(id);
  if (!conv) return sendJson(res, 404, { error: '会话不存在' });
  sendJson(res, 200, {
    conversationId: conv.id,
    userIdea: conv.user_idea,
    ready: !!conv.ready,
    round: conv.round,
    specSummary: conv.spec_summary,
    askedIds: JSON.parse(conv.asked_ids_json || '[]'),
    answers: JSON.parse(conv.answers_json || '{}'),
    history: JSON.parse(conv.history_json || '[]'),
    frontierQuestions: (JSON.parse(conv.frontier_json || '{}').frontier_questions) || [],
    candidates: conv.candidates_json ? JSON.parse(conv.candidates_json).candidates : null,
    dismissedAlternatives: conv.candidates_json ? JSON.parse(conv.candidates_json).dismissed_alternatives : null,
    researchNotes: conv.candidates_json ? JSON.parse(conv.candidates_json).research_notes : null,
  });
}

// ---- 路由分发 ----

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') return send(res, 204, '');

  try {
    if (method === 'GET' && pathname === '/') return routeIndex(req, res);
    if (method === 'GET' && pathname === '/api/health') return routeHealth(req, res);
    if (method === 'GET' && pathname === '/api/reports') return routeListReports(req, res, url);
    if (method === 'GET' && pathname === '/api/stats') return routeStats(req, res);
    if (method === 'POST' && pathname === '/api/reports') return routeCreateReport(req, res);

    // 设置（LLM API key 等）
    if (method === 'GET' && pathname === '/api/settings') return routeGetSettings(req, res);
    if (method === 'POST' && pathname === '/api/settings') return routeSaveSettings(req, res);
    if (method === 'POST' && pathname === '/api/settings/test') return routeTestSettings(req, res);

    // /api/reports/:id
    let m = pathname.match(/^\/api\/reports\/(\d+)$/);
    if (method === 'GET' && m) return routeGetReport(req, res, url, m[1]);

    // /api/reports/:id/feedback
    m = pathname.match(/^\/api\/reports\/(\d+)\/feedback$/);
    if (method === 'POST' && m) return routeFeedback(req, res, m[1]);

    // /api/reports/:id/markdown（导出/分享用）
    m = pathname.match(/^\/api\/reports\/(\d+)\/markdown$/);
    if (method === 'GET' && m) return routeReportMarkdown(req, res, m[1]);

    // /api/tasks/:id
    m = pathname.match(/^\/api\/tasks\/([\w-]+)$/);
    if (method === 'GET' && m) return routeGetTask(req, res, url, m[1]);

    // v1.6: 竞品发现
    if (method === 'POST' && pathname === '/api/discover/start') return routeDiscoverStart(req, res);
    if (method === 'POST' && pathname === '/api/discover/upload') return routeDiscoverUpload(req, res);
    if (method === 'POST' && pathname === '/api/discover/answer') return routeDiscoverAnswer(req, res);
    if (method === 'POST' && pathname === '/api/discover/skip') return routeDiscoverSkip(req, res);

    // /api/discover/:id
    m = pathname.match(/^\/api\/discover\/(\d+)$/);
    if (method === 'GET' && m) return routeGetConversation(req, res, m[1]);

    sendJson(res, 404, { error: '路由不存在', method, pathname });
  } catch (e) {
    console.error('路由错误:', e);
    sendJson(res, 500, { error: e.message });
  }
}

// ---- 启动 ----

function start() {
  db.init();
  const server = http.createServer(handle);
  server.listen(PORT, HOST, () => {
    console.log(`\n🚀 半人半机工作台已启动`);
    console.log(`   地址：http://${HOST}:${PORT}`);
    console.log(`   数据库：${db.dbPath()}`);
    console.log(`   停止：Ctrl+C\n`);
  });
  process.on('SIGINT', () => { console.log('\n关闭工作台...'); db.close(); server.close(); process.exit(0); });
}

if (require.main === module) start();

module.exports = { start, handle };
