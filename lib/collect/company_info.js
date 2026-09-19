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

// ---------- B. UK Companies House（官方注册库，免费 key —— OpenCorporates 替代） ----------
// 数据源：英国官方公司注册处，全量公开数据免费（api.gov.uk 确认）。
// key 注册即发：https://developer.company-information.service.gov.uk
// 信号价值：date_of_creation（成立年佐证）+ accounts.last_accounts.type
//   —— UK《公司法》size 条例是法定员工上限：micro-entity ≤10 人、small company ≤50 人、
//      dormant 无经营。这是有法律意义的硬约束，不是模糊推断。

const CH_BASE = 'https://api.company-information.service.gov.uk';

function chAuthHeader() {
  const key = process.env.COMPANIES_HOUSE_KEY;
  if (!key) return null;
  return { 'Authorization': 'Basic ' + Buffer.from(key + ':').toString('base64') };
}

/** 域名 stem（linear.app → linear）与公司名匹配打分 */
function chNameScore(companyTitle, domainStem) {
  const t = (companyTitle || '').toLowerCase();
  const s = (domainStem || '').toLowerCase();
  if (!s) return 0;
  if (t === s) return 3;
  const normT = t.replace(/[^a-z0-9]/g, '');
  const normS = s.replace(/[^a-z0-9]/g, '');
  if (normT === normS) return 2.5;
  if (t.includes(s)) return 2;
  return 0;
}

async function probeCompaniesHouse(companyName, domainStem, deadline = 0) {
  const auth = chAuthHeader();
  if (!auth) return { available: false, reason: '未配置 COMPANIES_HOUSE_KEY（免费注册即得，官方 UK 注册库）' };
  try {
    // 1) 名称搜索（取匹配分最高的前 3 个里再按状态 active 优先）
    const searchUrl = `${CH_BASE}/search/companies?q=${encodeURIComponent(companyName)}&items_per_page=5`;
    const sr = await fetchUrl(searchUrl, 15000, 1024 * 1024, 1, deadline, auth);
    if (sr.status !== 200) return { available: true, found: false, reason: `search HTTP ${sr.status}` };
    const items = (JSON.parse(sr.body).items || []).map((it) => ({
      number: it.company_number, title: it.title,
      score: chNameScore(it.title, domainStem) + (it.company_status === 'active' ? 0.5 : 0),
    })).filter((it) => it.score >= 2).sort((a, b) => b.score - a.score);
    if (items.length === 0) return { available: true, found: false, reason: '无名称匹配的公司条目' };

    // 2) 取最高分条目的完整档案
    const pr = await fetchUrl(`${CH_BASE}/company/${items[0].number}`, 15000, 1024 * 1024, 1, deadline, auth);
    if (pr.status !== 200) return { available: true, found: false, reason: `profile HTTP ${pr.status}` };
    const c = JSON.parse(pr.body);
    const out = {
      available: true, found: true,
      company_name: c.company_name, company_number: c.company_number,
      company_status: c.company_status, jurisdiction: 'UK Companies House',
      incorporation_date: c.date_of_creation, url: `https://find-and-update.company-information.service.gov.uk/company/${c.company_number}`,
    };
    // 法定规模约束（UK Companies Act 2006 注册账户类型）
    const lastType = c.accounts && c.accounts.last_accounts && c.accounts.last_accounts.type;
    if (lastType === 'micro-entity') { out.size_constraint = { label: 'micro-entity 账户', max_employees: 10 }; }
    else if (lastType === 'small' || lastType === 'audit-exemption-simplified' || lastType === 'total-exemption-small') {
      out.size_constraint = { label: 'small company 账户', max_employees: 50 };
    }
    if (lastType) out.last_accounts_type = lastType;
    return out;
  } catch (e) {
    return { available: true, found: false, reason: e.message };
  }
}

// ---------- C. Crunchbase（付费，2025 起无免费 API——保留接口等待用户决定是否订阅） ----------

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
// v1.8：CIK 发现改用官方 company_tickers.json 全量映射——
// 旧 cgi-bin/browse-edgar 端点已被 SEC 收紧（实测 503），data.sec.gov 系列保持开放。

async function probeSecEdgar(companyName, deadline = 0) {
  try {
    const stem = guessTheOrgSlug(companyName, '');
    const res = await fetchUrl('https://www.sec.gov/files/company_tickers.json', 20000, 3 * 1024 * 1024, 1, deadline);
    if (res.status !== 200) return { available: true, found: false, reason: `HTTP ${res.status}` };
    const tickers = JSON.parse(res.body);
    // 匹配优先级：ticker 精确 > 标题归一精确 > 标题前缀（title 如 "Salesforce, Inc." / "Linear Technology Corp"）
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    let hit = null;
    const entries = Object.values(tickers);
    hit = entries.find((e) => norm(e.ticker) === norm(stem))
      || entries.find((e) => norm(e.title) === norm(stem))
      || entries.find((e) => norm(e.title).startsWith(norm(stem)) && norm(stem).length >= 4);
    if (!hit) return { available: true, found: false, reason: '未在 SEC 上市名册中找到（可能未上市或名称差异）' };
    const cik = String(hit.cik_str).padStart(10, '0');
    return {
      available: true, found: true, cik,
      company_name: hit.title, ticker: hit.ticker,
      reason: `SEC EDGAR CIK=${cik}（${hit.title}/${hit.ticker}，上市公司）`,
    };
  } catch (e) {
    return { available: true, found: false, reason: e.message };
  }
}

// ---------- D2. SEC EDGAR 10-K 员工数抽取（上市公司硬数据，无需 key） ----------
// 流程：CIK → data.sec.gov submissions → 最近 10-K 主文档 → 抽 "approximately N employees"
// 员工数在 Item 1 开篇（文档前 1/4），maxBytes 截断可接受。data.sec.gov 要求真实身份 UA。

const SEC_EMPLOYEE_PATTERNS = [
  /approximately\s+([\d,]{2,})\s+(?:full-time\s+)?employees/i,
  /had\s+([\d,]{2,})\s+(?:full-time\s+)?employees/i,
  /([\d,]{2,})\s+(?:full-time\s+)?employees(?:\s+as of|\.)/i,
];

async function probeSec10kEmployees(secEdgarResult, deadline = 0) {
  if (!secEdgarResult || !secEdgarResult.found || !secEdgarResult.cik) {
    return { available: false, reason: '无 CIK（非上市公司或未命中）' };
  }
  try {
    const cik = secEdgarResult.cik;
    const subUrl = `https://data.sec.gov/submissions/CIK${cik}.json`;
    const sub = await fetchUrl(subUrl, 15000, 2 * 1024 * 1024, 1, deadline);
    if (sub.status !== 200) return { available: true, found: false, reason: `submissions HTTP ${sub.status}` };
    const recent = JSON.parse(sub.body).filings ? JSON.parse(sub.body).filings.recent : JSON.parse(sub.body).recent;
    if (!recent || !Array.isArray(recent.form)) return { available: true, found: false, reason: 'submissions 结构异常' };
    let idx = recent.form.findIndex((f) => f === '10-K');
    if (idx < 0) return { available: true, found: false, reason: '无 10-K 申报记录' };
    const accession = (recent.accessionNumber[idx] || '').replace(/-/g, '');
    const primary = recent.primaryDocument[idx];
    const filingDate = recent.filingDate ? recent.filingDate[idx] : null;
    if (!accession || !primary) return { available: true, found: false, reason: '10-K 条目缺文档信息' };

    const docUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${accession}/${primary}`;
    const doc = await fetchUrl(docUrl, 25000, 1500 * 1024, 1, deadline);
    if (doc.status !== 200 || !doc.body) return { available: true, found: false, reason: `10-K 文档 HTTP ${doc.status}` };
    // HTML 转实体还原 + 去标签后搜索
    const text = doc.body.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/<[^>]+>/g, ' ');
    for (const re of SEC_EMPLOYEE_PATTERNS) {
      const m = text.match(re);
      if (m) {
        const n = parseInt(m[1].replace(/,/g, ''), 10);
        if (Number.isFinite(n) && n >= 10) {
          return {
            available: true, found: true, employees: n, filing_date: filingDate,
            raw: m[0].slice(0, 80),
            reason: `10-K 员工数 ${n.toLocaleString()}（filing ${filingDate}）`,
          };
        }
      }
    }
    return { available: true, found: false, reason: '10-K 已取到但未匹配员工数表述' };
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
    theorg: null, companies_house: null, crunchbase: null,
    sec_edgar: null, sec_employees: null, news: null,
  };

  // 预算已尽则整体跳过（记 budget 证据，不算数据缺失）
  if (deadline && Date.now() > deadline - 5000) {
    pool.add({ source: 'http', kind: 'budget_exhausted', detail: `公司信息探测跳过（预算耗尽）` });
    for (const k of Object.keys(results)) results[k] = { available: false, found: false, reason: 'budget-exhausted' };
    return results;
  }

  // 并行探测（共享 deadline 预算）
  const [th, ch, cb, sec, news] = await Promise.allSettled([
    probeTheOrg(slug, deadline),
    probeCompaniesHouse(companyName, slug, deadline),
    probeCrunchbase(companyName, deadline),
    probeSecEdgar(companyName, deadline),
    probeNewsSignals(companyName, deadline),
  ]);
  results.theorg = th.status === 'fulfilled' ? th.value : { available: true, found: false, reason: th.reason?.message };
  results.companies_house = ch.status === 'fulfilled' ? ch.value : { available: true, found: false, reason: ch.reason?.message };
  results.crunchbase = cb.status === 'fulfilled' ? cb.value : { available: true, found: false, reason: cb.reason?.message };
  results.sec_edgar = sec.status === 'fulfilled' ? sec.value : { available: true, found: false, reason: sec.reason?.message };
  results.news = news.status === 'fulfilled' ? news.value : { available: true, found: false, reason: news.reason?.message };

  // 依赖 CIK 的串行步骤：10-K 员工数抽取（预算内）
  results.sec_employees = await probeSec10kEmployees(results.sec_edgar, deadline);
  if (results.sec_employees.found) {
    // CIK 命中即上市公司，10-K 又抽到员工数 → edgar 结果升级为员工数证据
    results.sec_edgar.employees = results.sec_employees.employees;
    results.sec_edgar.filing_date = results.sec_employees.filing_date;
  }

  // 预算耗尽 → 记专用证据（区别于「无数据」）
  const anyBudget = Object.values(results).some((r) => String(r.reason || '').startsWith('budget-exhausted'));
  if (anyBudget) pool.add({ source: 'http', kind: 'budget_exhausted', detail: `公司信息部分探测因预算耗尽未完成（theorg/CompaniesHouse/SEC/新闻）` });

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
  if (results.companies_house.found) {
    const ch = results.companies_house;
    const constraint = ch.size_constraint ? `；${ch.size_constraint.label}→法定员工上限 ${ch.size_constraint.max_employees} 人` : '';
    pool.add({ source: 'company_info', kind: 'companies_house', detail: `${ch.company_name}（${ch.company_status}）成立=${ch.incorporation_date}${constraint}`, url: ch.url });
  } else if (results.companies_house.available === false) {
    pool.add({ source: 'company_info', kind: 'companies_house', detail: `跳过（${results.companies_house.reason}）` });
  }
  if (results.crunchbase.found) {
    pool.add({ source: 'company_info', kind: 'crunchbase', detail: `${results.crunchbase.name} 员工区间=${results.crunchbase.num_employees_enum} 成立=${results.crunchbase.founded_on}` });
  } else if (results.crunchbase.available === false) {
    pool.add({ source: 'company_info', kind: 'crunchbase', detail: `跳过（${results.crunchbase.reason}）` });
  }
  if (results.sec_edgar.found && results.sec_edgar.employees) {
    pool.add({ source: 'company_info', kind: 'sec_edgar', detail: `SEC 10-K 员工数 ${results.sec_edgar.employees.toLocaleString()}（filing ${results.sec_edgar.filing_date}）` });
  } else if (results.sec_edgar.found) {
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
  probeTheOrg, probeCompaniesHouse, probeCrunchbase, probeSecEdgar, probeSec10kEmployees, probeNewsSignals,
  guessTheOrgSlug, chNameScore,
};
