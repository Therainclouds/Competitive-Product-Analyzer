/**
 * 商业模式采集器（SPECS 第五节 business_model）
 * ------------------------------------------------------------
 * 复用 probes/pricing 的规则（定价页发现 + 支付指纹 + 付费墙 + 定价信号），
 * 命中结果接入 evidence 池。
 * 已知局限（实测）：支付指纹在 SSR 定价页 HTML 中通常不可见（0/4 命中），
 * 命中即高置信，未命中不算证据、不惩罚。
 */

const { fetchUrl } = require('../shared/http');

const PRICING_PATHS = ['/pricing', '/plans', '/pricing/plans', '/#pricing', '/pricing-plans'];

const PAYMENT_PATTERNS = [
  { provider: 'Stripe', js: /js\.stripe\.com\/v3|window\.Stripe|@stripe\/stripe-js|stripe\.js/, dom: /[^a-z]stripe[^a-z]/i },
  { provider: 'Paddle', js: /cdn\.paddle\.com\/paddle\/paddle\.js|window\.Paddle|@paddle\/paddle-js/, dom: /[^a-z]paddle[^a-z]/i },
  { provider: 'RevenueCat', js: /js\.revenuecat\.com|Purchases\b|@revenuecat\/purchases-js/, dom: /[^a-z]revenuecat[^a-z]/i },
  { provider: 'Gumroad', js: /gumroad\.com\/js|gumroad\-overlay/, dom: /[^a-z]gumroad[^a-z]/i },
  { provider: 'Lemon Squeezy', js: /lemonsqueezy\.com\/js|window\.LemonSqueezy/, dom: /[^a-z]lemonsqueezy[^a-z]/i },
  { provider: 'Braintree', js: /js\.braintreegateway\.com|braintree\.js/, dom: /[^a-z]braintree[^a-z]/i },
  { provider: 'Adyen', js: /adyen\.com|adyen\.js/, dom: /[^a-z]adyen[^a-z]/i },
  { provider: 'PayPal', js: /paypal\.com\/sdk\/js|paypal\.js/, dom: /[^a-z]paypal[^a-z]/i },
];

const PAYWALL_SIGNALS = [
  { name: '订阅 CTA', regex: /start free trial|start your trial|subscribe now|go pro|upgrade to pro/i, weight: 1 },
  { name: '登录墙', regex: /log in to (view|continue|read)|sign in to (view|continue|read)|create a free account to/i, weight: 1 },
  { name: '价格墙', regex: /pricing starts at|\$[\d,.]+ \/ (month|year)|per month|billed annually/i, weight: 1 },
  { name: '免费额度', regex: /free (plan|tier|forever)|get started for free|100% free/i, weight: 1 },
  { name: '企业询价', regex: /contact (us|sales) (for|about) pricing|talk to sales/i, weight: 1 },
  { name: 'robots 拦截', regex: /<meta name="robots" content="[^"]*noindex/i, weight: 0.5 },
  { name: 'iframe 付费组件', regex: /<iframe[^>]*(stripe|paddle|billing|checkout)[^>]*>/i, weight: 0.5 },
];

function extractPricingSignals(body) {
  const signals = [];
  const text = body.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                   .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                   .replace(/<[^>]+>/g, ' ')
                   .replace(/\s+/g, ' ');
  const planPatterns = [
    { key: 'free-tier', regex: /\bFree\b/i, weight: 0.6 },
    { key: 'starter', regex: /\bStarter\b/i, weight: 0.5 },
    { key: 'pro', regex: /\bPro\b/i, weight: 0.6 },
    { key: 'business', regex: /\bBusiness\b/i, weight: 0.5 },
    { key: 'enterprise', regex: /\bEnterprise\b/i, weight: 0.6 },
    { key: 'team', regex: /\bTeam\b(?!\s+(?:of|size))/i, weight: 0.4 },
  ];
  for (const p of planPatterns) {
    if (p.regex.test(text)) signals.push({ signal: `plan:${p.key}`, weight: p.weight, evidence: p.regex.toString() });
  }
  const priceMonthly = text.match(/\$[\d,.]+(?:\s*\/\s*(?:mo|month|mo\.))|\$[\d,.]+(?:\s*per\s*(?:month|mo))/i);
  if (priceMonthly) signals.push({ signal: 'price-monthly', weight: 0.8, evidence: priceMonthly[0] });
  const priceYearly = text.match(/\$[\d,.]+(?:\s*\/\s*(?:yr|year|yr\.))|\$[\d,.]+(?:\s*per\s*(?:year|yr))/i);
  if (priceYearly) signals.push({ signal: 'price-yearly', weight: 0.7, evidence: priceYearly[0] });
  const quota = text.match(/([\d,]+(?:\s*[kKmM]b?|\s*(?:credits|seats|users|requests|rows|GB|api calls))\s+free|\bfree\s+([\d,]+(?:\s*[kKmM]b?|\s*(?:credits|seats|users|requests|rows|GB|api calls))))/i);
  if (quota) signals.push({ signal: 'free-quota', weight: 0.7, evidence: quota[0] });
  if (/per (api call|request|credit|seat|user|GB|row)|pay[- ]as[- ]you[- ]go|usage[- ]based/i.test(text)) {
    signals.push({ signal: 'usage-based', weight: 0.6, evidence: 'usage-based pattern' });
  }
  if (/ad[- ]supported|advertising[- ]supported|free with ads/i.test(text)) {
    signals.push({ signal: 'ad-supported', weight: 0.5, evidence: 'ad pattern' });
  }
  return signals;
}

async function findPricingPage(baseUrl, pool, deadline = 0) {
  for (const p of PRICING_PATHS) {
    try {
      const url = new URL(p, baseUrl).toString();
      // 定价页是一手证据核心来源：给 30s 硬超时（现代营销页常 >2MB，慢网传输需更久）
      const res = await fetchUrl(url, 30000, 2 * 1024 * 1024, 1, deadline);
      if (res && res.status && res.status >= 200 && res.status < 400 && res.body) {
        const pricey = /pricing|\$[\d,.]+|per month|plans/i.test(res.body.slice(0, 20000));
        if (pricey) {
          pool.add({ source: 'pricing_page', kind: 'page_found', detail: `${url} (status=${res.status})`, url });
          return { url, status: res.status, body: res.body };
        }
      }
    } catch (e) {
      if (e.budgetExhausted) { // 预算耗尽：记证据并放弃剩余路径（区别于 404）
        pool.add({ source: 'http', kind: 'budget_exhausted', detail: `定价页探测预算耗尽: ${e.message}`, url: baseUrl });
        break;
      }
      /* 该路径不存在 */
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return { url: null, status: null, body: null };
}

/**
 * 从页面提取脚本 src 并抓取 bundle 内容，搜支付服务商特征。
 * 根治 P2 盲区：SSR 定价页 HTML 支付指纹 0/4 命中——支付脚本（Stripe.js 等）
 * 异步加载在 JS bundle 里。策略：定价页 HTML 里的 script src，
 * 优先同源/已知支付 CDN，最多 4 个，共享管线 deadline。
 */
async function probePaymentInBundles(body, baseUrl, pool, evidenceIds, deadline) {
  const providers = [];
  let srcs = (body.match(/<script[^>]+src=["']([^"']+)["']/gi) || []).map((s) => (s.match(/src=["']([^"']+)["']/i) || [])[1]).filter(Boolean);
  const abs = srcs.map((s) => { try { return new URL(s, baseUrl).toString(); } catch { return null; } }).filter(Boolean);
  // 优先疑似支付类路径，其余按顺序补足，总共最多 4 个 bundle
  const isPayish = (u) => /stripe|paypal|paddle|braintree|revenuecat|lemonsqueezy|gumroad|adyen|checkout|billing|payment|pricing/i.test(u);
  abs.sort((a, b) => (isPayish(b) ? 1 : 0) - (isPayish(a) ? 1 : 0));
  const picked = abs.slice(0, 4);
  const fetched = await Promise.allSettled(picked.map((u) => fetchUrl(u, 8000, 1024 * 1024, 0, deadline)));
  for (const r of fetched) {
    if (r.status !== 'fulfilled' || !r.value.body) continue;
    const text = r.value.body;
    const bundleUrl = picked[fetched.indexOf(r)];
    for (const p of PAYMENT_PATTERNS) {
      if (providers.some((x) => x.provider === p.provider)) continue;
      if (p.js.test(text)) {
        const evId = pool.add({ source: 'payment_fingerprint', kind: 'payment_provider', detail: `${p.provider}（JS bundle 内容命中：${bundleUrl.slice(0, 90)}）`, url: bundleUrl });
        evidenceIds.push(evId);
        providers.push({ provider: p.provider, confidence: 'high', via: 'bundle' });
      }
    }
  }
  return providers;
}

/** 商业模式采集主入口 */
async function collectBusinessModel(url, pool, opts = {}) {
  const deadline = opts.deadline || 0;
  const pricing = await findPricingPage(url, pool, deadline);
  const body = pricing.body || '';
  const evidenceIds = [];
  const priceHints = [];

  // 支付指纹 · HTML 层（已知 SSR 盲区：命中即高置信，未命中不算缺陷）
  const providers = [];
  for (const p of PAYMENT_PATTERNS) {
    const jsHit = p.js.test(body);
    const domHit = p.dom.test(body);
    if (jsHit || domHit) {
      const evId = pool.add({ source: 'payment_fingerprint', kind: 'payment_provider', detail: `${p.provider} (${jsHit ? 'JS 特征' : 'DOM 文本'})`, url: pricing.url });
      evidenceIds.push(evId);
      providers.push({ provider: p.provider, confidence: jsHit ? 'high' : 'medium' });
    }
  }

  // v1.7 · P2 盲区补采：HTML 未命中任何支付商时，抓 JS bundle 搜特征（SSR 页支付脚本异步加载）
  if (providers.length === 0 && body) {
    const viaBundle = await probePaymentInBundles(body, pricing.url || url, pool, evidenceIds, deadline);
    providers.push(...viaBundle);
  }

  // 付费墙
  const paywall = [];
  for (const s of PAYWALL_SIGNALS) {
    if (s.regex.test(body)) {
      const evId = pool.add({ source: 'paywall_heuristic', kind: 'paywall_signal', detail: s.name, url: pricing.url });
      evidenceIds.push(evId);
      paywall.push({ signal: s.name, weight: s.weight });
    }
  }

  // 定价信号
  const pricingSignals = extractPricingSignals(body);
  for (const s of pricingSignals) {
    const evId = pool.add({ source: 'pricing_signal', kind: 'pricing', detail: `${s.signal} (${s.evidence})`, url: pricing.url });
    evidenceIds.push(evId);
    if (s.signal.startsWith('price-')) priceHints.push({ raw: s.evidence, period: s.signal });
  }

  // 变现方式规则（与 probes 一致）
  const hasFree = pricingSignals.some((s) => s.signal === 'plan:free-tier') || paywall.some((s) => s.signal === '免费额度');
  const hasPaidPlans = pricingSignals.some((s) => s.signal === 'price-monthly' || s.signal === 'price-yearly') ||
                       pricingSignals.some((s) => s.signal === 'plan:pro' || s.signal === 'plan:starter' || s.signal === 'plan:business' || s.signal === 'plan:enterprise');
  const hasUsage = pricingSignals.some((s) => s.signal === 'usage-based');
  const hasAds = pricingSignals.some((s) => s.signal === 'ad-supported');
  const hasEnterpriseOnly = paywall.some((s) => s.signal === '企业询价') && !hasPaidPlans;

  let monetization = 'unknown';
  if (hasAds) monetization = 'ad-supported';
  else if (hasFree && hasPaidPlans) monetization = 'freemium';
  else if (hasFree && !hasPaidPlans && !hasUsage) monetization = 'free-product';
  else if (hasUsage && hasPaidPlans) monetization = 'usage-based + subscription';
  else if (hasPaidPlans) monetization = 'subscription';
  else if (hasEnterpriseOnly) monetization = 'enterprise-quote';

  // ---- v1.7 LLM 结构化抽取（A-MINT schema；未配 key / 失败自动跳过，不影响规则结果）----
  let llmExtract = null;
  if (body && opts.llmExtract !== false) {
    const { extractPricing } = require('../llm/pricing_extract');
    llmExtract = await extractPricing(body, { monetization, priceHints, paywall: paywall.map((s) => s.signal) });
    if (llmExtract.available) {
      const evId = pool.add({
        source: 'llm_pricing', kind: 'llm_extract',
        detail: `LLM 抽取 ${llmExtract.plans.length} 个套餐（${llmExtract.plans.map((p) => p.name).join('/')}）monetization=${llmExtract.monetization_primary} conf=${llmExtract.confidence}`,
        url: pricing.url,
      });
      evidenceIds.push(evId);
      // 覆盖规则：LLM high 置信与规则不一致时采纳 LLM（规则结果留痕于 llm_extract.rule_monetization）
      if (llmExtract.confidence === 'high' && llmExtract.monetization_primary !== monetization) {
        llmExtract.rule_monetization = monetization;
        monetization = llmExtract.monetization_primary;
      } else if (monetization === 'unknown' && llmExtract.monetization_primary !== 'unknown' && llmExtract.confidence !== 'low') {
        // 规则引擎本来就判断不出 → 采纳 LLM 的非 low 置信结果
        llmExtract.rule_monetization = 'unknown';
        monetization = llmExtract.monetization_primary;
      }
    }
  }

  return {
    monetization,
    pricingPageUrl: pricing.url,
    providers,
    paywall,
    pricingSignals,
    priceHints,
    evidenceIds,
    llmExtract,
    data_sufficient: !!pricing.url, // 找到定价页即视为有数据
  };
}

module.exports = { collectBusinessModel };
