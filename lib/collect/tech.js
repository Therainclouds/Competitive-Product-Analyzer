/**
 * 技术栈采集适配器（SPECS 第五节 tech_stack · v1.7 规则引擎版）
 * ------------------------------------------------------------
 * v1.7：主检测层换成 webappalyzer 社区规则源（rules/webappanalyzer，
 * 7600+ 应用 / MIT / enthec 维护），取代零依赖手写正则（P3 误报根因）。
 * 保留：DNS CNAME CDN 通道（规则源用 TXT，两者互补）。
 * 已知差距：js / dom / scripts / xhr 等浏览器通道未实现（诚实声明于 DATA_SOURCES.md）。
 * 每条命中 = 结论，证据 = 命中通道 + pattern + 抓取页面（接 evidence 池）。
 */

const { fetchUrl } = require('../shared/http');
const dns = require('dns').promises;
const { detect } = require('../tech/detect');

/** 命中通道 → evidence source（权重表在 evidence.js） */
const CHANNEL_SOURCE = {
  scriptSrc: 'js_paths',
  headers: 'headers',
  cookies: 'cookies',
  meta: 'meta',
  html: 'html',
  url: 'url',
  dns: 'dns',
  implies: 'implies',
};

async function detectCdnFromCname(hostname, pool) {
  const items = [];
  try {
    const records = await dns.resolveCname(hostname);
    const cname = records.join(',').toLowerCase();
    const cdnMap = [
      { name: 'Cloudflare', match: /cloudflare/ },
      { name: 'Fastly', match: /fastly/ },
      { name: 'Akamai', match: /akamai/ },
      { name: 'AWS CloudFront', match: /cloudfront/ },
      { name: 'Azure CDN', match: /azureedge|azurefd/ },
      { name: 'Vercel', match: /vercel-dns|vercel\.com/ },
      { name: 'Netlify', match: /netlify/ },
    ];
    for (const c of cdnMap) {
      if (c.match.test(cname)) {
        const evId = pool.add({ source: 'dns', kind: 'cname', detail: `CNAME: ${cname}` });
        items.push({ name: c.name, version: null, cats: [], evidenceIds: [evId] });
      }
    }
  } catch (e) { /* 无 CNAME 正常 */ }
  return items;
}

async function fetchDnsTxt(hostname, deadline = 0) {
  try {
    const budget = deadline ? Math.max(1000, Math.min(8000, deadline - Date.now())) : 8000;
    const records = await dns.resolveTxt(hostname, { signal: AbortSignal.timeout(budget) });
    return records.map((chunks) => chunks.join(''));
  } catch (e) {
    return [];
  }
}

/** 技术栈采集主入口：返回 items[] + 页面状态 evidence */
async function collectTechStack(url, pool, opts = {}) {
  const deadline = opts.deadline || 0;
  const hostname = new URL(url).hostname;
  const items = [];
  const byName = new Map();

  const push = (it) => {
    if (!it || !it.name) return;
    if (!byName.has(it.name)) byName.set(it.name, it);
    else byName.get(it.name).evidenceIds.push(...it.evidenceIds);
  };

  const [page, cnameHits] = await Promise.allSettled([fetchUrl(url, 20000, 2 * 1024 * 1024, 2, deadline), detectCdnFromCname(hostname, pool)]);

  let pageStatus = null;
  const ctx = { url, headers: {}, html: '', dnsTxt: [] };
  if (page.status === 'fulfilled' && page.value.body) {
    const p = page.value;
    pageStatus = p.status;
    pool.add({ source: 'http', kind: 'page', detail: `status=${p.status}`, url });
    ctx.headers = p.headers;
    ctx.html = p.body;
  } else {
    const reason = page.reason?.budgetExhausted ? 'budget_exhausted' : (page.reason?.message || 'unknown');
    pool.add({ source: 'http', kind: page.reason?.budgetExhausted ? 'budget_exhausted' : 'page', detail: `fetch failed: ${reason}`, url });
  }
  ctx.dnsTxt = await fetchDnsTxt(hostname, deadline);

  // ---- 规则引擎主通道 ----
  let detections = [];
  try {
    detections = detect(ctx);
  } catch (e) {
    pool.add({ source: 'html', kind: 'error', detail: `rule engine failed: ${e.message}`, url });
  }
  for (const d of detections) {
    const source = CHANNEL_SOURCE[d.channel] || 'html';
    const evId = pool.add({
      source,
      kind: `wappalyzer:${d.channel}`,
      detail: `${d.name}${d.version ? ` ${d.version}` : ''} ← ${(d.pattern || '').slice(0, 120)}`,
      url,
    });
    push({ name: d.name, version: d.version, cats: d.cats, channel: d.channel, evidenceIds: [evId] });
  }

  // ---- CNAME CDN 补充通道 ----
  if (cnameHits.status === 'fulfilled') cnameHits.value.forEach(push);

  return { items: [...byName.values()], pageStatus };
}

module.exports = { collectTechStack };
