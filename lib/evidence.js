/**
 * evidence 池：全报告证据的单一事实源（SPECS 第三节，护城河核心）
 * ------------------------------------------------------------
 * 每条结论必须能回溯到 ≥1 条 evidence（来源 + 细节 + 抓取时间）。
 * 展示层可据此生成证据链；「数据不足」时 evidence 为空则该维度标注不足。
 */

let counter = 0;

/** 创建证据池（每个报告一个实例） */
function createEvidencePool() {
  const pool = new Map();

  function add({ source, kind, detail, url = null }) {
    const id = `ev-${++counter}`;
    pool.set(id, { id, source, kind, detail, url, fetched_at: new Date().toISOString() });
    return id;
  }

  function get(id) { return pool.get(id) || null; }

  function all() { return Array.from(pool.values()); }

  function refs(ids) { return (ids || []).map((id) => ({ evidenceId: id })).filter((r) => pool.has(r.evidenceId)); }

  return { add, get, all, refs };
}

/** 来源权重表（SPECS 第四节；第一版时效恒为 1） */
const SOURCE_WEIGHTS = {
  headers: 1.0,
  html: 0.9,
  js_paths: 0.8,
  dns: 0.8,
  cookies: 0.9, // v1.7 规则引擎通道
  meta: 0.9,    // v1.7 规则引擎通道
  url: 0.6,     // v1.7 规则引擎通道（路径启发式，易误报）
  implies: 0.5, // v1.7 传递推断（依赖父命中，证据力最弱）
  pricing_page: 1.0,
  pricing_signal: 0.9,
  paywall_heuristic: 0.7,
  payment_fingerprint: 0.6, // 已知 SSR 盲区，权重下调
  github: 0.8,
  careers: 0.5,
  company_info: 0.8,
  llm_redblue: 0.7, // LLM 推理（红蓝对抗）— 中等权重，需 evidence 回查支撑
  llm_pricing: 0.7, // v1.7 LLM 定价页结构化抽取（回原文可核对）
};

/** 置信度分级（按维度累计加权分） */
function gradeConfidence(score, independentSources) {
  if (score >= 2.0 && independentSources >= 2) return 'high';
  if (score >= 1.0) return 'medium';
  return 'low';
}

/** 计算一组 evidence 的加权分 */
function weightedScore(evidenceIds, pool) {
  let score = 0;
  const sources = new Set();
  for (const id of evidenceIds) {
    const ev = pool.get(id);
    if (!ev) continue;
    score += SOURCE_WEIGHTS[ev.source] || 0.5;
    sources.add(ev.source);
  }
  return { score: Math.round(score * 10) / 10, independentSources: sources.size };
}

module.exports = { createEvidencePool, SOURCE_WEIGHTS, gradeConfidence, weightedScore };
