/**
 * Pipeline 聚合入口（v1.5 · 抽出共享 dissectOne）
 * ------------------------------------------------------------
 * 把 xray.js 主流程拆出，供：
 *   - xray.js（CLI 单次）
 *   - batch_xray_parallel.js（批量并行，Day 5）
 *   - workbench/server.js（Web 工作台异步触发）
 *
 * 共享的设计：
 *   - 三路采集（tech / bm / team）并行（Promise.allSettled）
 *   - 可选红蓝对抗（独立第 4 步，失败不影响主报告）
 *   - 可选缓存（首页结果复用）
 *   - 可选持久化（写入 SQLite，Day 4）
 *
 * 接口：
 *   dissectOne(url, opts) → { report, evidencePool, elapsedMs, writtenFiles? }
 *   opts: {
 *     ownProduct?: string,
 *     withRedBlue?: boolean,
 *     useCache?: boolean,
 *     writeFiles?: { dir, base? },
 *     signalHit?: (source) => void,    // evidence 池统计回调
 *     recordSignalMiss?: (source) => void,
 *   }
 */

const fs = require('fs');
const path = require('path');
const { createEvidencePool } = require('./evidence');
const { collectTechStack } = require('./collect/tech');
const { collectBusinessModel } = require('./collect/pricing');
const { collectTeamSize } = require('./collect/team_runner');
const { assemble } = require('./reason/assemble');
const { renderMarkdown } = require('./render/md');
const cache = require('./cache');
const { generateRedBlue } = require('./llm/redblue');

const DISCLAIMER = '本报告基于公开信息推断，仅供参考。技术栈/商业模式/团队规模均为自动推断，可能与实际存在偏差，请勿作为唯一决策依据。';

function companyFromUrl(url) {
  const host = new URL(url).hostname.replace(/^www\./, '');
  return host.split('.')[0];
}

function slugify(name) {
  return name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

/**
 * Promise 超时包装：超过 ms 就 reject，避免某个 fetch 卡住拖死整个任务
 * 用 AbortController 的方式不能中断同步代码（HTTP 已发出），所以这里用 race：
 *   - 正常完成 → resolve(promise 的值)
 *   - 超时 → reject(Error('timeout after Xms'))
 */
function withTimeout(promise, ms, label = 'op') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（>${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 严格的 URL 校验：必须是 http(s) 协议 + 有 host + host 不能是裸的 'github' 等无 TLD
 */
function assertValidTargetUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    throw new Error(`无效 URL: ${url}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`不支持的协议: ${u.protocol}（仅允许 http/https）`);
  }
  // 防御 LLM 幻觉出的 "user/repo" 形式
  if (!u.hostname.includes('.')) {
    throw new Error(`URL 缺少域名: ${url}（疑似 LLM 编造的仓库路径）`);
  }
  return u.toString();
}

/**
 * 单站完整 pipeline
 */
async function dissectOne(url, opts = {}) {
  const {
    ownProduct = '',
    withRedBlue = false,
    useCache = false,
    writeFiles = null,
  } = opts;

  const target = assertValidTargetUrl(url);

  const company = companyFromUrl(target);
  const pool = createEvidencePool();
  const started = Date.now();

  // v1.7 采集预算（TEST_REPORT P4 根治）：三路采集共享 150s 绝对 deadline，
  // 每个 HTTP 请求超时 = min(自身超时, 剩余预算)，预算耗尽立即放弃并记 budget-exhausted
  // 证据（「没来得及查」≠「没有数据」，供重采引导使用）。
  // 外层 withTimeout 240s 仅作最终兜底（红蓝对抗 LLM 最长 90s 走预算外）。
  const deadline = started + 150000;

  // ---- 采集（三路并行，带总超时）----
  const body = async () => {
  const [tech, bm, team] = await Promise.allSettled([
    collectTechStack(target, pool, { deadline }),
    collectBusinessModel(target, pool, { deadline }),
    collectTeamSize(target, pool, { deadline }),
  ]);
  const techRes = tech.status === 'fulfilled' ? tech.value : { items: [], pageStatus: null };
  const bmRes = bm.status === 'fulfilled' ? bm.value : { monetization: 'unknown', pricingPageUrl: null, providers: [], paywall: [], pricingSignals: [], priceHints: [], evidenceIds: [], data_sufficient: false };
  const teamRes = team.status === 'fulfilled' ? team.value : { range: null, signals: [], data_sufficient: false };
  if (tech.status === 'rejected') pool.add({ source: 'http', kind: 'error', detail: `tech: ${tech.reason?.message}` });
  if (bm.status === 'rejected') pool.add({ source: 'http', kind: 'error', detail: `pricing: ${bm.reason?.message}` });
  if (team.status === 'rejected') pool.add({ source: 'http', kind: 'error', detail: `team: ${team.reason?.message}` });

  // 采集预算耗尽标记（呈现层据此提示重采，而非展示成「数据不足」）
  const budgetExhausted = pool.all().some((e) => e.kind === 'budget_exhausted');

  // ---- 推理组装 ----
  const report = assemble(target, company, pool, techRes, bmRes, teamRes);
  report.budget_exhausted = budgetExhausted; // v1.7：采集预算耗尽 ≠ 数据不足（供重采引导）

  // ---- 可选：红蓝对抗 ----
  let redblueRes = null;
  if (withRedBlue) {
    redblueRes = await generateRedBlue({
      ownProduct,
      targetUrl: target,
      report: { ...report, evidence: pool.all() }, // 把 evidence 池传给 LLM 让它引用
      pool,
    });
    // 把红蓝对抗结果塞进 report
    const { assembleRedBlue } = require('./reason/assemble');
    report.pillars.redblue = assembleRedBlue(redblueRes);
  }

  report.generated_at = new Date().toISOString();
  report.disclaimer = DISCLAIMER;
  report.elapsed_ms = Date.now() - started;

  // 注入 evidence 池
  report.evidence = pool.all();

  // ---- 可选：写文件 ----
  let writtenFiles = null;
  if (writeFiles && writeFiles.dir) {
    const outDir = writeFiles.dir;
    fs.mkdirSync(outDir, { recursive: true });
    const base = writeFiles.base || path.join(outDir, `xray-${slugify(company)}-${Date.now()}`);
    fs.writeFileSync(base + '.json', JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(base + '.md', renderMarkdown(report, pool), 'utf8');
    writtenFiles = { json: base + '.json', md: base + '.md' };
  }

  return { report, evidencePool: pool, elapsedMs: report.elapsed_ms, writtenFiles };
  };
  return await withTimeout(body(), 240000, `dissect ${company}`);
}

module.exports = { dissectOne, companyFromUrl, slugify, DISCLAIMER, withTimeout, assertValidTargetUrl };
