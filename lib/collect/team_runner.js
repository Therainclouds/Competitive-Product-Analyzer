/**
 * 团队规模采集聚合入口（xray.js 调用 collectTeamSize）
 * ------------------------------------------------------------
 * 流程：公司信息（OpenCorporates/Crunchbase/SEC/新闻）→ GitHub org → 招聘页 → 区间投票。
 * v1.1 补强：Crunchbase 员工区间是硬信号（可直出区间），OpenCorporates 成立年佐证规模下限。
 */

const { guessOrgNames, probeGithubOrg, probeCareers, estimateTeamRange } = require('./team');
const { collectCompanyInfo } = require('./company_info');

async function collectTeamSize(url, pool) {
  const hostname = new URL(url).hostname;
  const base = new URL(url).toString().replace(/\/$/, '');
  const companyName = hostname.replace(/^www\./, '').split('.')[0];
  const signals = [];

  // 0. 公司信息（v1.1 新增：注册信息/员工区间/融资新闻）
  const companyInfo = await collectCompanyInfo(companyName, pool);

  // Crunchbase 员工区间 → 直接是强信号（若命中）
  if (companyInfo.crunchbase && companyInfo.crunchbase.found && companyInfo.crunchbase.num_employees_enum) {
    signals.push({
      source: 'crunchbase',
      raw: `num_employees_enum=${companyInfo.crunchbase.num_employees_enum}`,
      estimate_range: null, // 区间由 enum 值映射，见 estimateTeamRange
      weight: 0.9,
      employees_enum: companyInfo.crunchbase.num_employees_enum,
    });
  }

  // 1. GitHub org
  const orgNames = guessOrgNames(hostname);
  const github = await probeGithubOrg(orgNames);
  if (github.found) {
    pool.add({ source: 'github', kind: 'org', detail: `org=${github.org} public_repos=${github.publicRepos}${github.publicMembers ? ` public_members=${github.publicMembers}` : ' (members 不公开)'}`, url: github.url });
  } else {
    pool.add({ source: 'github', kind: 'org', detail: `未找到 GitHub org（尝试: ${orgNames.join(', ')}）`, url: `https://github.com/${orgNames[0]}` });
  }

  // 2. 招聘页
  const careers = await probeCareers(base);
  if (careers.url) {
    pool.add({ source: 'careers', kind: 'careers_page', detail: `岗位块数=${careers.jobCount}（页面 ${careers.url}）`, url: careers.url });
  }

  // 3. 区间投票（含 Crunchbase enum 映射 + OpenCorporates/SEC 佐证）
  const result = estimateTeamRange(github, careers, companyInfo);
  result.signals.forEach((s) => { signals.push(s); });

  return { ...result, signals };
}

module.exports = { collectTeamSize };
