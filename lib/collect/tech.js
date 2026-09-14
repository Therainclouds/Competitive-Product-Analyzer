/**
 * 技术栈采集适配器（SPECS 第五节 tech_stack）
 * ------------------------------------------------------------
 * 复用 probes/tech_stack 的检测逻辑（零依赖正则层），
 * 把命中结果接入 evidence 池（每条技术 = 结论，证据 = 命中的信号源）。
 * v1.1：接入 wappalyzer-core 引擎 + webappanalyzer 规则源提升精度。
 */

const { fetchUrl } = require('../shared/http');
const dns = require('dns').promises;

/** 从 HTML 检测框架（与 probes 同规则，独立实现避免循环依赖） */
function detectFromHtml(html, pool) {
  const items = [];
  const patterns = [
    { name: 'Next.js', regex: /__NEXT_DATA__|_next\/static/ },
    { name: 'Nuxt.js', regex: /__NUXT__|_nuxt\// },
    { name: 'Gatsby', regex: /___gatsby|gatsby-ghost|gatsby-plugin/ },
    { name: 'Vue.js', regex: /id="app"|data-v-[a-f0-9]{6,}/i },
    { name: 'React', regex: /data-reactroot|__react|react\.production/ },
    { name: 'Angular', regex: /ng-version=|ng-app/ },
    { name: 'SvelteKit', regex: /__sveltekit|svelte-json|_svelte/ },
    { name: 'Astro', regex: /astro-island|__astro/ },
    { name: 'WordPress', regex: /wp-content\/|wp-includes\// },
    { name: 'Shopify', regex: /cdn\.shopify\.com|Shopify\.theme/ },
    { name: 'Wix', regex: /wix\.com\/scripts|WixCode/ },
    { name: 'Webflow', regex: /webflow\.js|data-wf-/ },
    { name: 'Ghost', regex: /ghost-url|content\/images\/|ghost\.io/ },
  ];
  for (const p of patterns) {
    if (p.regex.test(html)) {
      const evId = pool.add({ source: 'html', kind: 'framework_marker', detail: p.regex.toString() });
      items.push({ name: p.name, confidence: 'medium', evidenceIds: [evId] });
    }
  }
  return items;
}

function detectFromHeaders(headers, pool) {
  const items = [];
  const h = Object.keys(headers).reduce((acc, k) => { acc[k.toLowerCase()] = headers[k]; return acc; }, {});
  const checks = [
    { name: 'nginx', key: 'server', match: /nginx/i },
    { name: 'Apache', key: 'server', match: /apache/i },
    { name: 'Cloudflare', key: 'server', match: /cloudflare/i },
    { name: 'Vercel', key: 'server', match: /vercel/i },
    { name: 'Netlify', key: 'server', match: /netlify/i },
    { name: 'Vercel', key: 'x-vercel-id', match: /.+/ },
    { name: 'Netlify', key: 'x-nf-request-id', match: /.+/ },
    { name: 'Vite', key: 'server', match: /vite/i },
    { name: 'Express', key: 'x-powered-by', match: /express/i },
    { name: 'Next.js', key: 'x-nextjs-cache', match: /.+/ },
  ];
  for (const c of checks) {
    const v = h[c.key];
    if (v && c.match.test(String(v))) {
      const evId = pool.add({ source: 'headers', kind: 'response_header', detail: `${c.key}: ${v}` });
      items.push({ name: c.name, confidence: 'medium', evidenceIds: [evId] });
    }
  }
  return items;
}

function detectFromJsPaths(html, pool) {
  const items = [];
  const paths = html.match(/src="([^"]+\.js[^"]*)"/g) || [];
  const bareSrcs = html.match(/src="([^"]*cdn[^"]*)"/gi) || [];
  const all = paths.concat(bareSrcs).join(' ');
  const checks = [
    { name: 'Vite', regex: /@vite\/client|\.vite\/|\/assets\/index-[\w-]+\.js/ },
    { name: 'webpack', regex: /webpack|chunk\.js|\.bundle\.js/ },
    { name: 'Next.js', regex: /_next\/static\/chunks\// },
    { name: 'Nuxt', regex: /_nuxt\/entry|_nuxt\/index/ },
    { name: 'Alpine.js', regex: /alpinejs|alpine\.js/ },
    { name: 'Tailwind', regex: /cdn\.tailwindcss|tailwindcss\.com|tailwind/ },
  ];
  for (const c of checks) {
    if (c.regex.test(all)) {
      const evId = pool.add({ source: 'js_paths', kind: 'script_path', detail: c.regex.toString() });
      items.push({ name: c.name, confidence: 'medium', evidenceIds: [evId] });
    }
  }
  return items;
}

async function detectCdnFromDns(hostname, pool) {
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
        items.push({ name: c.name, confidence: 'medium', evidenceIds: [evId] });
      }
    }
  } catch (e) { /* 无 CNAME 正常 */ }
  return items;
}

/** 技术栈采集主入口：返回 items[] + 页面状态 evidence */
async function collectTechStack(url, pool) {
  const hostname = new URL(url).hostname;
  const items = [];
  const seen = new Set();

  const push = (it) => {
    if (!it || !it.name) return;
    const key = `${it.name}|${it.evidenceIds[0]}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(it);
  };

  const [page, dnsHits] = await Promise.allSettled([fetchUrl(url), detectCdnFromDns(hostname, pool)]);

  let pageStatus = null;
  if (page.status === 'fulfilled' && page.value.body) {
    const p = page.value;
    pageStatus = p.status;
    pool.add({ source: 'http', kind: 'page', detail: `status=${p.status}`, url });
    detectFromHeaders(p.headers, pool).forEach(push);
    detectFromHtml(p.body, pool).forEach(push);
    detectFromJsPaths(p.body, pool).forEach(push);
  } else {
    pool.add({ source: 'http', kind: 'page', detail: `fetch failed: ${page.reason?.message || 'unknown'}`, url });
  }
  if (dnsHits.status === 'fulfilled') dnsHits.value.forEach(push);

  return { items, pageStatus };
}

module.exports = { collectTechStack };
