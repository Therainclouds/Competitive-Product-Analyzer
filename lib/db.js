/**
 * SQLite 持久化层（v1.5 + v1.6 discovery · 零依赖 · 用 Node 内置 node:sqlite）
 * ------------------------------------------------------------
 * 4 张表：reports / feedbacks / signals_stats / conversations
 *
 * 用途：
 *   - 历史报告持久化（用于跨站对比 + 时间序列）
 *   - 错误反馈闭环（v2.0 审查意见 2.0 红线要求）
 *   - 信号源命中率统计（用于置信度校准）
 *   - v1.6 新增：竞品发现会话状态（grilling 风格 frontier）
 *
 * 接口：
 *   init({ dbPath? })                    建表 + 打开数据库
 *   saveReport({ ...reportFields })      → id
 *   saveFeedback({ ... })                → id
 *   listReports({ limit?, offset?, slug? })
 *   getReport(id)
 *   getFeedbacksForReport(id)
 *   recordSignalHit(source) / recordSignalMiss(source)
 *   getSignalStats()
 *   createConversation({ userIdea })    → id
 *   updateConversation(id, fields)
 *   getConversation(id)
 *   listConversations({ limit? })
 *   close()
 */

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

let _db = null;
let _dbPath = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_url TEXT NOT NULL,
  company TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  elapsed_ms INTEGER,
  tech_stack_json TEXT,
  business_model_json TEXT,
  team_size_json TEXT,
  redblue_json TEXT,
  data_gaps_json TEXT,
  evidence_json TEXT,
  disclaimer TEXT,
  slug TEXT NOT NULL,
  source TEXT DEFAULT 'cli',
  UNIQUE(target_url, generated_at)
);

CREATE INDEX IF NOT EXISTS idx_reports_slug ON reports(slug);
CREATE INDEX IF NOT EXISTS idx_reports_generated_at ON reports(generated_at);

CREATE TABLE IF NOT EXISTS feedbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  pillar TEXT NOT NULL,
  item_ref TEXT,
  verdict TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_feedbacks_report ON feedbacks(report_id);
CREATE INDEX IF NOT EXISTS idx_feedbacks_pillar ON feedbacks(pillar);

CREATE TABLE IF NOT EXISTS signals_stats (
  source TEXT PRIMARY KEY,
  hits INTEGER DEFAULT 0,
  misses INTEGER DEFAULT 0,
  last_updated TEXT
);

-- v1.6: 竞品发现会话（grilling 风格 frontier 状态机）
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_idea TEXT NOT NULL,
  spec_summary TEXT,
  round INTEGER DEFAULT 1,
  ready INTEGER DEFAULT 0,
  frontier_json TEXT,
  asked_ids_json TEXT DEFAULT '[]',
  answers_json TEXT DEFAULT '{}',
  history_json TEXT DEFAULT '[]',
  candidates_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_ready ON conversations(ready);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);
`;

function init(opts = {}) {
  if (_db) return _db;
  _dbPath = opts.dbPath || path.join(__dirname, '..', 'xray.db');
  // 确保父目录存在
  fs.mkdirSync(path.dirname(_dbPath), { recursive: true });
  _db = new DatabaseSync(_dbPath);
  _db.exec(SCHEMA);
  // 迁移：v1.6 新增 history_json 列（老库可能没有）
  try {
    const cols = _db.prepare("PRAGMA table_info(conversations)").all();
    const hasHistory = cols.some(c => c.name === 'history_json');
    if (!hasHistory) {
      _db.exec("ALTER TABLE conversations ADD COLUMN history_json TEXT DEFAULT '[]'");
    }
  } catch (e) { /* table 还不存在时静默忽略 */ }
  return _db;
}

function db() {
  if (!_db) init();
  return _db;
}

function slugifyUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host.split('.')[0].toLowerCase();
  } catch {
    return 'unknown';
  }
}

function saveReport(report) {
  const d = db();
  const stmt = d.prepare(`
    INSERT OR REPLACE INTO reports (
      target_url, company, generated_at, elapsed_ms,
      tech_stack_json, business_model_json, team_size_json,
      redblue_json, data_gaps_json, evidence_json,
      disclaimer, slug, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    report.target,
    report.company,
    report.generated_at || new Date().toISOString(),
    report.elapsed_ms || 0,
    JSON.stringify(report.pillars?.tech_stack || {}),
    JSON.stringify(report.pillars?.business_model || {}),
    JSON.stringify(report.pillars?.team_size || {}),
    JSON.stringify(report.pillars?.redblue || null),
    JSON.stringify(report.data_gaps || []),
    JSON.stringify(report.evidence || []),
    report.disclaimer || '',
    slugifyUrl(report.target),
    report.source || 'cli',
  );
  return result.lastInsertRowid;
}

function saveFeedback({ reportId, pillar, itemRef = null, verdict, note = '' }) {
  if (!reportId) throw new Error('reportId 必需');
  if (!['correct', 'wrong', 'partial', 'unclear'].includes(verdict)) {
    throw new Error(`verdict 必须是 correct/wrong/partial/unclear，收到: ${verdict}`);
  }
  const d = db();
  const stmt = d.prepare(`
    INSERT INTO feedbacks (report_id, pillar, item_ref, verdict, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(reportId, pillar, itemRef, verdict, note, new Date().toISOString());
  return result.lastInsertRowid;
}

function listReports({ limit = 50, offset = 0, slug = null } = {}) {
  const d = db();
  // 列表页需要展示置信度徽章：从 JSON 列里提取三件套 confidence 最小值 + data_gaps
  // 用 json_extract 直接 SQL 解析，避免重复读全 JSON
  let rows;
  if (slug) {
    rows = d.prepare(`
      SELECT id, target_url, company, generated_at, elapsed_ms, slug, source,
             tech_stack_json, business_model_json, team_size_json, data_gaps_json,
             (SELECT COUNT(*) FROM feedbacks WHERE feedbacks.report_id = reports.id) AS feedback_count
      FROM reports WHERE slug = ?
      ORDER BY generated_at DESC LIMIT ? OFFSET ?
    `).all(slug, limit, offset).map(parseReportRow);
  } else {
    rows = d.prepare(`
      SELECT id, target_url, company, generated_at, elapsed_ms, slug, source,
             tech_stack_json, business_model_json, team_size_json, data_gaps_json,
             (SELECT COUNT(*) FROM feedbacks WHERE feedbacks.report_id = reports.id) AS feedback_count
      FROM reports ORDER BY generated_at DESC LIMIT ? OFFSET ?
    `).all(limit, offset).map(parseReportRow);
  }
  return rows;
}

function _safeParse(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

// 三件套 confidence 的最小值（用于列表卡片徽章）
// 优先级：high > medium > low（数值越低越好，给卡片染色用）
const CONF_RANK = { high: 3, medium: 2, low: 1 };
function worstConfidence(pillars) {
  const confs = pillars.map(p => p?.confidence || 'low');
  let rank = 3; // 假设最高
  for (const c of confs) { if ((CONF_RANK[c] ?? 0) < rank) rank = CONF_RANK[c] ?? 0; }
  return rank === 3 ? 'high' : rank === 2 ? 'medium' : 'low';
}

function parseReportRow(row) {
  const tech = _safeParse(row.tech_stack_json);
  const bm = _safeParse(row.business_model_json);
  const team = _safeParse(row.team_size_json);
  const gaps = _safeParse(row.data_gaps_json) || [];
  const pillarConfs = {
    tech_stack: tech?.confidence || 'low',
    business_model: bm?.confidence || 'low',
    team_size: team?.confidence || 'low',
  };
  return {
    id: row.id,
    target_url: row.target_url,
    company: row.company,
    generated_at: row.generated_at,
    elapsed_ms: row.elapsed_ms,
    slug: row.slug,
    source: row.source,
    feedback_count: row.feedback_count,
    pillar_confs: pillarConfs,
    worst_confidence: worstConfidence([tech, bm, team]),
    data_gaps: gaps,
  };
}

function getReport(id) {
  const d = db();
  const row = d.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    target: row.target_url,
    company: row.company,
    generated_at: row.generated_at,
    elapsed_ms: row.elapsed_ms,
    disclaimer: row.disclaimer,
    slug: row.slug,
    source: row.source,
    pillars: {
      tech_stack: JSON.parse(row.tech_stack_json || '{}'),
      business_model: JSON.parse(row.business_model_json || '{}'),
      team_size: JSON.parse(row.team_size_json || '{}'),
      redblue: row.redblue_json ? JSON.parse(row.redblue_json) : null,
    },
    data_gaps: JSON.parse(row.data_gaps_json || '[]'),
    evidence: JSON.parse(row.evidence_json || '[]'),
  };
}

function getFeedbacksForReport(reportId) {
  const d = db();
  return d.prepare(`
    SELECT id, pillar, item_ref, verdict, note, created_at
    FROM feedbacks WHERE report_id = ? ORDER BY created_at DESC
  `).all(reportId);
}

function recordSignalHit(source) {
  const d = db();
  d.prepare(`
    INSERT INTO signals_stats (source, hits, misses, last_updated)
    VALUES (?, 1, 0, ?)
    ON CONFLICT(source) DO UPDATE SET
      hits = hits + 1, last_updated = excluded.last_updated
  `).run(source, new Date().toISOString());
}

function recordSignalMiss(source) {
  const d = db();
  d.prepare(`
    INSERT INTO signals_stats (source, hits, misses, last_updated)
    VALUES (?, 0, 1, ?)
    ON CONFLICT(source) DO UPDATE SET
      misses = misses + 1, last_updated = excluded.last_updated
  `).run(source, new Date().toISOString());
}

function getSignalStats() {
  const d = db();
  return d.prepare(`
    SELECT source, hits, misses,
           ROUND(CAST(hits AS REAL) / NULLIF(hits + misses, 0), 3) AS hit_rate,
           last_updated
    FROM signals_stats ORDER BY source
  `).all();
}

// ---- v1.6: conversation CRUD ----

function createConversation({ userIdea }) {
  const d = db();
  const now = new Date().toISOString();
  const result = d.prepare(`
    INSERT INTO conversations (user_idea, spec_summary, round, ready, frontier_json, asked_ids_json, answers_json, history_json, candidates_json, created_at, updated_at)
    VALUES (?, '', 1, 0, NULL, '[]', '{}', '[]', NULL, ?, ?)
  `).run(userIdea, now, now);
  return result.lastInsertRowid;
}

function updateConversation(id, fields) {
  const d = db();
  const allowed = ['spec_summary', 'round', 'ready', 'frontier_json', 'asked_ids_json', 'answers_json', 'history_json', 'candidates_json'];
  const sets = [];
  const values = [];
  for (const k of allowed) {
    if (k in fields) {
      // SQLite TEXT 列 bind 时，undefined 会抛 "Provided value cannot be bound to SQLite parameter 1"
      // 兜底：undefined / null 一律落空字符串，避免前端/上游漏字段时炸库
      let v = fields[k];
      if (v === undefined || v === null) v = '';
      sets.push(`${k} = ?`);
      values.push(v);
    }
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  d.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

function getConversation(id) {
  const d = db();
  return d.prepare('SELECT * FROM conversations WHERE id = ?').get(id) || null;
}

function listConversations({ limit = 30 } = {}) {
  const d = db();
  return d.prepare(`
    SELECT id, user_idea, spec_summary, round, ready, candidates_json, created_at, updated_at
    FROM conversations ORDER BY updated_at DESC LIMIT ?
  `).all(limit);
}

function close() {
  if (_db) { _db.close(); _db = null; }
}

function dbPath() { return _dbPath; }

module.exports = {
  init, db, saveReport, saveFeedback,
  listReports, getReport, getFeedbacksForReport,
  recordSignalHit, recordSignalMiss, getSignalStats,
  createConversation, updateConversation, getConversation, listConversations,
  close, dbPath,
};
