/**
 * 团队规模采集器（SPECS 第五节 team_size）
 * ------------------------------------------------------------
 * 信号源：
 *  1. GitHub API org 成员数（免费 60req/h，无需 key）—— 仅公开 org
 *  2. 招聘页岗位关键词计数（/careers /jobs /about）—— 只反映在招，系数推断
 * 合规：GitHub 官方 API + 公开页面，真实 UA，不碰 LinkedIn。
 */

const { fetchUrl } = require('../shared/http');

const CAREERS_PATHS = ['/careers', '/jobs', '/about', '/careers/openings', '/jobs/openings'];
const JOB_KEYWORDS = [
  /\b(engineer|engineering)\b/i, /\b(developer|dev)\b/i, /\bdesigner\b/i,
  /\b(product manager|pm)\b/i, /\b(marketing|growth|sales|support|customer)\b/i,
  /\b(data scientist|data)\b/i, /\b(hr|recruiting|talent|finance|operations)\b/i,
  /\b(founder|co-founder|ceo|cto)\b/i,
];

/** 从域名猜 GitHub org 名候选（linear.app → linearapp, linear, thelinearapp...） */
function guessOrgNames(hostname) {
  const root = hostname.replace(/^www\./, '').split('.')[0].toLowerCase();
  const names = new Set();
  names.add(root);
  names.add(root + 'app');
  names.add('the' + root);
  names.add(root + 'hq');
  return Array.from(names);
}

/** 查 GitHub org：返回 public members 数（无 key 限制下的公开数据） */
async function probeGithubOrg(orgNames) {
  for (const org of orgNames.slice(0, 2)) { // 最多试 2 个候选（慢网络预算）
    try {
      const url = `https://api.github.com/orgs/${org}`;
      const res = await fetchUrl(url, 20000); // 20s 上限
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        const publicRepos = data.public_repos || 0;
        const publicMembers = data.public_members || null; // 多数 org 不公开 members
        return { org, found: true, publicRepos, publicMembers, url: `https://github.com/${org}` };
      }
    } catch (e) { /* org 不存在或限流，继续下一个候选 */ }
    await new Promise((r) => setTimeout(r, 600));
  }
  return { org: null, found: false };
}

/** 抓招聘页，统计岗位关键词出现的「岗位块」数量 */
async function probeCareers(baseUrl) {
  for (const p of CAREERS_PATHS.slice(0, 3)) { // 最多试 3 个路径（慢网络预算）
    try {
      const url = new URL(p, baseUrl).toString();
      const res = await fetchUrl(url, 20000); // 20s 上限
      if (res.status >= 200 && res.status < 400 && res.body && res.body.length > 2000) {
        const text = res.body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
        // 岗位列表特征：标题式短语（job title 模式）或关键词密度
        const jobTitlePattern = /\b(software|senior|staff|principal|lead|full[- ]stack|frontend|backend|mobile|ml|ai)\s+(engineer|developer|designer|manager)\b/gi;
        const titleMatches = text.match(jobTitlePattern) || [];
        const keywordHits = {};
        for (const kw of JOB_KEYWORDS) {
          const m = text.match(kw);
          if (m) keywordHits[kw.source] = 1;
        }
        const jobCount = Math.max(titleMatches.length, Object.keys(keywordHits).length);
        if (jobCount > 0) {
          return { url, jobCount, titleMatches: titleMatches.slice(0, 20), keywordHits };
        }
      }
    } catch (e) { /* 该路径不存在，继续 */ }
    await new Promise((r) => setTimeout(r, 600));
  }
  return { url: null, jobCount: 0 };
}

/** Crunchbase num_employees_enum 区间映射（Crunchbase Basic 档公开字段） */
const CRUNCHBASE_ENUM_RANGES = {
  '1-10': [1, 10], '11-50': [11, 50], '51-100': [51, 100], '101-250': [101, 250],
  '251-500': [251, 500], '501-1000': [501, 1000], '1001-5000': [1001, 5000],
  '5001-10000': [5001, 10000], '10001+': [10001, 25000],
};

/** theorg.com 数字区间估算（v1.2.2 多源联合校准）：
 *  实测 10 站对比：theorg 数字 vs 实际员工数 倍数从 1.1x（Typeform）到 14.5x（Salesforce）不等，
 *  没有稳定系数。正确做法是「theorg 数 = 公开档案下限」，上限根据多源信号强度动态调整：
 *
 *  多源联合判断规则（按可用信号动态决定上限倍数）：
 *  - SEC EDGAR 命中 → 上市公司至少千人级别，强制下限 1000
 *  - GitHub repos ≥ 100 → 大型组织，最低 500
 *  - GitHub repos 30-99 → 中等规模，最低 200
 *  - GitHub repos < 30 → 小型，最低 theorg 数
 *  - 招聘页岗位 ≥ 30 → 大规模招聘中，最低 200
 *  - 招聘页岗位 ≥ 10 → 中等招聘，最低 100
 *  - 招聘页岗位 < 10 → 小团队
 *
 *  上限：根据 theorg 数 × 5 + 兜底区间
 *  这是聚合源，弱于 GitHub 官方、强于招聘页 */
function theorgRange(estimate, ctx = {}) {
  let lower = estimate;
  // 多源交叉：取 max(estimate, 其它源推断下限)
  if (ctx.publicCompany) lower = Math.max(lower, 1000); // SEC 命中：上市公司至少千人
  if (ctx.githubRepos >= 100) lower = Math.max(lower, 500);
  else if (ctx.githubRepos >= 30) lower = Math.max(lower, 200);
  if (ctx.jobCount >= 30) lower = Math.max(lower, 200);
  else if (ctx.jobCount >= 10) lower = Math.max(lower, 100);

  // 上限：分档（5x 兜底 + 大公司 15x 兜底）
  let upper;
  if (lower >= 5000) upper = lower * 15;
  else if (lower >= 500) upper = lower * 5;
  else upper = lower * 3;
  return [lower, upper];
}

/** 团队规模区间投票（SPECS 第六节 + v1.1 公司信息补强 + v1.2 theorg） */
function estimateTeamRange(github, careers, companyInfo) {
  const ranges = [];
  const signals = [];

  // 0. Crunchbase 员工区间（硬信号，优先）
  if (companyInfo && companyInfo.crunchbase && companyInfo.crunchbase.found) {
    const enumVal = companyInfo.crunchbase.num_employees_enum;
    if (enumVal && CRUNCHBASE_ENUM_RANGES[enumVal]) {
      const r = CRUNCHBASE_ENUM_RANGES[enumVal];
      ranges.push(r);
      signals.push({ source: 'crunchbase', raw: `num_employees_enum=${enumVal}`, estimate_range: r, weight: 0.9 });
    }
  }

  // 0.3. theorg.com（聚合源，员工数下限信号，免费）
  if (companyInfo && companyInfo.theorg && companyInfo.theorg.found) {
    const ctx = {
      publicCompany: !!(companyInfo.sec_edgar && companyInfo.sec_edgar.found),
      githubRepos: (github && github.found) ? github.publicRepos : 0,
      jobCount: (careers && careers.jobCount) ? careers.jobCount : 0,
    };
    const r = theorgRange(companyInfo.theorg.total_estimate, ctx);
    ranges.push(r);
    const ctxNote = [];
    if (ctx.publicCompany) ctxNote.push('SEC 上市公司');
    if (ctx.githubRepos >= 100) ctxNote.push(`GitHub repos ${ctx.githubRepos}（大型）`);
    else if (ctx.githubRepos >= 30) ctxNote.push(`GitHub repos ${ctx.githubRepos}（中等）`);
    if (ctx.jobCount >= 10) ctxNote.push(`招聘 ${ctx.jobCount} 岗`);
    signals.push({
      source: 'theorg',
      raw: `theorg 公开档案=${companyInfo.theorg.total_estimate}（联合校准：${ctxNote.join(' / ') || '仅 theorg'}；下限≥${r[0]} 上限≤${r[1]}）`,
      estimate_range: r,
      weight: 0.7,
    });
  }

  // 0.5. SEC EDGAR（上市公司：CIK 命中即说明达到上市公司规模，弱佐证下限）
  if (companyInfo && companyInfo.sec_edgar && companyInfo.sec_edgar.found) {
    signals.push({ source: 'sec_edgar', raw: `CIK=${companyInfo.sec_edgar.cik}（上市公司）`, estimate_range: null, weight: 0.4, caveat: 'public-company' });
  }

  // 0.8. OpenCorporates（成立年份佐证：老公司通常更大，但只作弱信号）
  if (companyInfo && companyInfo.opencorporates && companyInfo.opencorporates.found) {
    signals.push({ source: 'opencorporates', raw: `成立=${companyInfo.opencorporates.incorporation_date} 类型=${companyInfo.opencorporates.company_type}`, estimate_range: null, weight: 0.4 });
  }

  if (github && github.found) {
    if (github.publicMembers && github.publicMembers > 0) {
      ranges.push([github.publicMembers, Math.ceil(github.publicMembers * 1.5)]);
      signals.push({ source: 'github', raw: `public_members=${github.publicMembers}`, estimate_range: ranges[ranges.length - 1], weight: 0.8 });
    } else if (github.publicRepos >= 50) {
      // members 不公开但 repos 很多（如 Stripe 98）→ 招聘页岗位数会严重低估（大公司 careers 页常 JS 渲染）
      signals.push({
        source: 'github',
        raw: `org=${github.org} public_repos=${github.publicRepos} (members 不公开；repos≥50 提示公司规模可能显著大于招聘页推断)`,
        estimate_range: null,
        weight: 0.3,
        caveat: 'large-org',
      });
    } else {
      signals.push({ source: 'github', raw: `org=${github.org} public_repos=${github.publicRepos} (members 不公开)`, estimate_range: null, weight: 0.3 });
    }
  }

  if (careers && careers.jobCount > 0) {
    // v0.1 同款经验系数：岗位数 n → [n×2.5, n×6]
    const n = careers.jobCount;
    ranges.push([Math.round(n * 2.5), Math.round(n * 6)]);
    signals.push({ source: 'careers', raw: `job_blocks=${n}`, estimate_range: ranges[ranges.length - 1], weight: 0.5 });
  }

  if (ranges.length === 0) {
    return { range: null, signals, data_sufficient: false };
  }

  // 多源区间取并集（min of mins, max of maxes）
  const min = Math.min(...ranges.map((r) => r[0]));
  const max = Math.max(...ranges.map((r) => r[1]));
  return { range: [min, max], signals, data_sufficient: true };
}

module.exports = { guessOrgNames, probeGithubOrg, probeCareers, estimateTeamRange, CRUNCHBASE_ENUM_RANGES };
