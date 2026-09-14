/**
 * 公司信息采集器（v1.2 · 网页抓取替代付费 API）
 * ------------------------------------------------------------
 * 目标：补「成立年份 / 注册地 / 法律形态 / 员工数 / 融资」等公司画像硬证据，
 *       让团队规模估算不再只靠「招聘页岗位数」（P1 系统性低估）。
 *
 * 数据源（全部免费 + 公开）：
 *   A. theorg.com     （员工数 + 组织架构）——网页抓取，无需 key
 *   B. OpenCorporates  API（公司注册信息）——需 key：OPEN_CORPORATES_KEY（付费，跳过）
 *   C. Crunchbase     API（员工数区间/成立年）——需 key：CRUNCHBASE_KEY（付费，跳过）
 *   D. SEC EDGAR     （上市公司 10-K/8-K）——无需 key，仅上市公司
 *   E. Google News RSS（融资/新闻信号）——无需 key
 *   F. Wellfound      （备胎，已知 403 拦截，保留占位）
 *
 * v1.2 变更：移除付费 OpenCorporates/Crunchbase 默认依赖，新增 theorg.com 网页抓取。
 */

const { fetchUrl } = require('../shared/http');
require('../env'); // 确保 OPEN_CORPORATES_KEY / CRUNCHBASE_KEY 从 .env 可读（与 LLM 配置同源）

// ---------- A. theorg.com（员工数，无 key，免费） ----------

/**
 * 抓取 theorg.com 的组织页，提取员工数区间
 * URL 模式：https://theorg.com/org/<company-slug>
 * 信号：页面里的 "X people" / "X employees" 文本
 */
async function probeTheOrg(companySlug, deadline = 0) {
  if (!companySlug) return { available: true, found: false, reason: 'no slug' };
  try {
    const url = `https://theorg.com/org/${encodeURIComponent(companySlug)}`;
    const res = await fetchUrl(url, 15000, 1024 * 1024, 1, deadline);
    if (res.status !== 200) {
      return { available: true, found: false, reason: `HTTP ${res.status}` };
    }
    // 提取所有 "X people" / "X employees" / "X members" 信号
    const matches = res.body.match(/(\d{1,3}[,\s]?\d{3}|\d{2,6})\s*(people|employees?|members?)/gi) || [];
    // 去重 + 解析数字
    const seen = new Set();
    const counts = [];
    for (const m of matches) {
      const numStr = m.match(/(\d{1,3}[,\s]?\d{3}|\d{2,6})/)[1].replace(/[,\s]/g, '');
      const n = parseInt(numStr, 10);
      if (!seen.has(n) && n >= 5 && n <= 100000) {
        seen.add(n);
        counts.push({ count: n, raw: m.trim() });
      }
      if (counts.length >= 5) break;
    }
    if (counts.length === 0) {
      // 兜底：抓页面正文里的最大数字（弱信号）
      return { available: true, found: false, reason: '未匹配到员工数（页面可能非标准布局）' };
    }
    // 最大数字通常是「总人数」，其余是部门/团队
    const max = counts.reduce((a, b) => a.count > b.count ? a : b);
    return {
      available: true, found: true,
      org_slug: companySlug,
      url,
      total_estimate: max.count,
      total_evidence: max.raw,
      breakdown: counts.slice(0, 5), // 前 5 个数字（含部门分布）
    };
  } catch (e) {
    return { available: true, found: false, reason: e.message };
  }
}

// ---------- B. OpenCorporates（需 key，默认跳过） ----------

async function probeOpenCorporates(companyName, deadline = 0) {
  const key = process.env.OPEN_CORPORATES_KEY;
  if (!key) return { available: false, reason: '未配置 OPEN_CORPORATES_KEY（公益项目批复后填入 .env 即启用）' };
  try {
    const url = `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(companyName)}&api_token=${key}`;
    const res = await fetchUrl(url, 15000, 1024 * 1024, 1, deadline);
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      const r = data.results?.companies?.[0];
      if (r) {
        const c = r.company;
        return {
          available: true, found: true,
          name: c.name, incorporation_date: c.incorporation_date,
          company_type: c.company_type, jurisdiction: c.jurisdiction_code,
          registered_address: c.registered_address_in_full,
          url: c.opencorporates_url,
        };
      }
      return { available: true, found: false, reason: '未找到匹配公司' };
    }
    return { available: true, found: false, reason: `HTTP ${res.status}` };
  } catch (e) {
    return { available: true, found: false, reason: e.message };
  }
}

// ---------- C. Crunchbase（需 key，默认跳过） ----------

async function probeCrunchbase(companyName, deadline = 0) {
  const key = process.env.CRUNCHBASE_KEY;
  if (!key) return { available: false, reason: '未配置 CRUNCHBASE_KEY（付费，跳过）' };
  try {
    const permalink = companyName.toLowerCase();
    const url = `https://api.crunchbase.com/api/v4/entities/organizations/${permalink}?user_key=${key}&field_ids=name,num_employees_enum,founded_on,short_description`;
    const res = await fetchUrl(url, 15000, 1024 * 1024, 1, deadline);
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      const props = data.properties || {};
      return {
        available: true, found: true,
        name: props.name, num_employees_enum: props.num_employees_enum,
        founded_on: props.founded_on, short_description: props.short_description,
      };
    }
    return { available: true, found: false, reason: `HTTP ${res.status}` };
  } catch (e) {
    return { available: true, found: false, reason: e.message };
  }
}

// ---------- D. SEC EDGAR（无需 key，仅上市公司） ----------

async function probeSecEdgar(companyName, deadline = 0) {
  try {
    const url = `https://www.sec.gov/cgi-bin/browse-edgar?company=${encodeURIComponent(companyName)}&type=10-K&action=getcompany&output=atom`;
    const res = await fetchUrl(url, 15000, 1024 * 1024, 1, deadline);
    if (res.status === 200 && res.body.includes('conformed-name')) {
      const match = res.body.match(/<cik>(\d{10})<\/cik>|CIK=(\d{10})/);
      const nameMatch = res.body.match(/<conformed-name>([^<]+)<\/conformed-name>/);
      if (match) {
        const cik = match[1] || match[2];
        return { available: true, found: true, cik, company_name: nameMatch ? nameMatch[1] : null, reason: `SEC EDGAR CIK=${cik}（上市公司，可查 10-K 员工数）` };
      }
      return { available: true, found: false, reason: '未在 SEC EDGAR 找到（可能非美国上市公司）' };
    }
    return { available: true, found: false, reason: `HTTP ${res.status || '?'}` };
  } catch (e) {
    return { available: true, found: false, reason: e.message };
  }
}

// ---------- E. Google News RSS（融资/新闻，无需 key） ----------

async function probeNewsSignals(companyName, deadline = 0) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(companyName + ' (funding OR raised OR valuation OR series)')}`;
    const res = await fetchUrl(url, 20000, 2 * 1024 * 1024, 1, deadline);
    if (res.status === 200 && res.body.includes('<item>')) {
      const items = res.body.match(/<title>([^<]+)<\/title>/g) || [];
      const titles = items.map((t) => t.replace(/<[^>]+>/g, '').trim()).filter((t) => t && !t.startsWith('Google')).slice(0, 5);
      if (titles.length > 0) {
        return { available: true, found: true, headlines: titles, source: 'google-news-rss' };
      }
    }
    return { available: true, found: false, reason: '无融资相关新闻' };
  } catch (e) {
    return { available: true, found: false, reason: e.message };
  }
}

// ---------- 公司名 → theorg slug 推断 ----------
/**
 * 把公司名/域名归一化成 theorg slug
 * 例：salesforce.com → salesforce；linear.app → linear；Stripe → stripe
 */
function guessTheOrgSlug(companyName, domain) {
  const source = (domain || companyName || '').toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\.(com|io|app|co|net|org|ai|so|dev|tech).*$/, '')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return source;
}

// ---------- 聚合入口 ----------

async function collectCompanyInfo(companyName, pool, opts = {}) {
  const deadline = opts.deadline || 0;
  const slug = opts.theorgSlug || guessTheOrgSlug(companyName, opts.domain);

  const results = {
    theorg: null, opencorporates: null, crunchbase: null,
    sec_edgar: null, news: null,
  };

  // 预算已尽则整体跳过（记 budget 证据，不算数据缺失）
  if (deadline && Date.now() > deadline - 5000) {
    pool.add({ source: 'http', kind: 'budget_exhausted', detail: `公司信息探测跳过（预算耗尽）` });
    for (const k of Object.keys(results)) results[k] = { available: false, found: false, reason: 'budget-exhausted' };
    return results;
  }

  // 并行探测（共享 deadline 预算）
  const [th, oc, cb, sec, news] = await Promise.allSettled([
    probeTheOrg(slug, deadline),
    probeOpenCorporates(companyName, deadline),
    probeCrunchbase(companyName, deadline),
    probeSecEdgar(companyName, deadline),
    probeNewsSignals(companyName, deadline),
  ]);
  results.theorg = th.status === 'fulfilled' ? th.value : { available: true, found: false, reason: th.reason?.message };
  results.opencorporates = oc.status === 'fulfilled' ? oc.value : { available: true, found: false, reason: oc.reason?.message };
  results.crunchbase = cb.status === 'fulfilled' ? cb.value : { available: true, found: false, reason: cb.reason?.message };
  results.sec_edgar = sec.status === 'fulfilled' ? sec.value : { available: true, found: false, reason: sec.reason?.message };
  results.news = news.status === 'fulfilled' ? news.value : { available: true, found: false, reason: news.reason?.message };

  // 预算耗尽 → 记专用证据（区别于「无数据」）
  const anyBudget = Object.values(results).some((r) => String(r.reason || '').startsWith('budget-exhausted'));
  if (anyBudget) pool.add({ source: 'http', kind: 'budget_exhausted', detail: `公司信息部分探测因预算耗尽未完成（theorg/OpenCorp/SEC/新闻）` });

  // 记入 evidence 池
  if (results.theorg.found) {
    pool.add({
      source: 'company_info', kind: 'theorg',
      detail: `theorg.com 估算员工数 ${results.theorg.total_estimate}（证据：${results.theorg.total_evidence}；部门分布：${results.theorg.breakdown.slice(1).map(b => b.raw).join(' / ') || '无'}）`,
      url: results.theorg.url,
    });
  } else if (results.theorg.available) {
    pool.add({ source: 'company_info', kind: 'theorg', detail: `跳过（${results.theorg.reason}）`, url: `https://theorg.com/org/${slug}` });
  }
  if (results.opencorporates.found) {
    pool.add({ source: 'company_info', kind: 'opencorporates', detail: `${results.opencorporates.name} 成立=${results.opencorporates.incorporation_date} 类型=${results.opencorporates.company_type} 注册地=${results.opencorporates.jurisdiction}`, url: results.opencorporates.url });
  } else if (results.opencorporates.available === false) {
    pool.add({ source: 'company_info', kind: 'opencorporates', detail: `跳过（${results.opencorporates.reason}）` });
  }
  if (results.crunchbase.found) {
    pool.add({ source: 'company_info', kind: 'crunchbase', detail: `${results.crunchbase.name} 员工区间=${results.crunchbase.num_employees_enum} 成立=${results.crunchbase.founded_on}` });
  } else if (results.crunchbase.available === false) {
    pool.add({ source: 'company_info', kind: 'crunchbase', detail: `跳过（${results.crunchbase.reason}）` });
  }
  if (results.sec_edgar.found) {
    pool.add({ source: 'company_info', kind: 'sec_edgar', detail: results.sec_edgar.reason });
  } else if (results.sec_edgar.available) {
    pool.add({ source: 'company_info', kind: 'sec_edgar', detail: results.sec_edgar.reason });
  }
  if (results.news.found) {
    pool.add({ source: 'company_info', kind: 'news', detail: `融资/新闻：${results.news.headlines.join(' | ')}`, url: 'https://news.google.com/' });
  }

  return results;
}

module.exports = {
  collectCompanyInfo,
  probeTheOrg, probeOpenCorporates, probeCrunchbase, probeSecEdgar, probeNewsSignals,
  guessTheOrgSlug,
};
