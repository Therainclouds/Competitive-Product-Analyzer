#!/usr/bin/env node
/**
 * 批量解剖（SPECS 验收标准：5 个真实站点跑完整管线）
 * ------------------------------------------------------------
 * 用法: node batch_xray.js [--out <dir>]
 * 输出：每站 JSON+MD + 控制台验收摘要
 */

const fs = require('fs');
const path = require('path');
const { createEvidencePool } = require('./lib/evidence');
const { collectTechStack } = require('./lib/collect/tech');
const { collectBusinessModel } = require('./lib/collect/pricing');
const { collectTeamSize } = require('./lib/collect/team_runner');
const { assemble } = require('./lib/reason/assemble');
const { renderMarkdown } = require('./lib/render/md');

const TARGETS = [
  'https://vercel.com',
  'https://linear.app',
  'https://www.notion.so',
  'https://www.figma.com',
  'https://stripe.com',
];

const DISCLAIMER = '本报告基于公开信息推断，仅供参考。技术栈/商业模式/团队规模均为自动推断，可能与实际存在偏差，请勿作为唯一决策依据。';

function companyFromUrl(url) {
  return new URL(url).hostname.replace(/^www\./, '').split('.')[0];
}
function slugify(name) { return name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase(); }

async function dissectOne(url, outDir) {
  const company = companyFromUrl(url);
  const pool = createEvidencePool();
  const started = Date.now();

  const [tech, bm, team] = await Promise.allSettled([
    collectTechStack(url, pool),
    collectBusinessModel(url, pool),
    collectTeamSize(url, pool),
  ]);
  const techRes = tech.status === 'fulfilled' ? tech.value : { items: [], pageStatus: null };
  const bmRes = bm.status === 'fulfilled' ? bm.value : { monetization: 'unknown', pricingPageUrl: null, providers: [], paywall: [], pricingSignals: [], priceHints: [], evidenceIds: [], data_sufficient: false };
  const teamRes = team.status === 'fulfilled' ? team.value : { range: null, signals: [], data_sufficient: false };

  const report = assemble(url, company, pool, techRes, bmRes, teamRes);
  report.generated_at = new Date().toISOString();
  report.disclaimer = DISCLAIMER;
  report.elapsed_ms = Date.now() - started;

  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `xray-${slugify(company)}-${Date.now()}`);
  fs.writeFileSync(base + '.json', JSON.stringify({ ...report, evidence: pool.all() }, null, 2), 'utf8');
  fs.writeFileSync(base + '.md', renderMarkdown(report, pool), 'utf8');

  return { company, report };
}

async function main() {
  const outDir = process.argv[2] === '--out' ? process.argv[3] : path.join(__dirname, 'reports');
  const results = [];
  for (const url of TARGETS) {
    process.stdout.write(`解剖 ${companyFromUrl(url)} ... `);
    try {
      const r = await Promise.race([
        dissectOne(url, outDir),
        new Promise((_, rej) => setTimeout(() => rej(new Error('单站超时 150s')), 150000)),
      ]);
      results.push(r);
      console.log(`✅ ${r.report.elapsed_ms}ms | tech=${r.report.pillars.tech_stack.confidence} bm=${r.report.pillars.business_model.confidence} team=${r.report.pillars.team_size.confidence} | gaps: ${r.report.data_gaps.length || 0}`);
    } catch (e) {
      results.push({ company: companyFromUrl(url), error: e.message });
      console.log(`❌ ${e.message}`);
    }
    await new Promise((res) => setTimeout(res, 2000));
  }

  // 验收摘要
  console.log('\n══════════ 批量验收摘要 ══════════');
  const ok = results.filter((r) => !r.error);
  console.log(`跑通管线: ${ok.length}/${results.length}`);
  console.log(`技术栈有数据: ${ok.filter((r) => r.report.pillars.tech_stack.data_sufficient).length}/${ok.length}`);
  console.log(`商业模式有数据: ${ok.filter((r) => r.report.pillars.business_model.data_sufficient).length}/${ok.length}`);
  console.log(`团队规模有数据: ${ok.filter((r) => r.report.pillars.team_size.data_sufficient).length}/${ok.length}`);
  // 证据链统计：每条结论 evidence 引用存在性（从 report 各 pillar 检查）
  const withEvidence = ok.filter((r) => {
    const ts = r.report.pillars.tech_stack.items || [];
    return ts.length > 0 && ts.every((it) => it.evidence && it.evidence.length > 0);
  });
  console.log(`技术栈结论全部带证据链: ${withEvidence.length}/${ok.length}`);
  results.forEach((r) => {
    if (r.error) console.log(`- ${r.company}: ❌ ${r.error}`);
    else console.log(`- ${r.company}: tech=${r.report.pillars.tech_stack.items.map((i) => i.name).join(',') || '无'} | bm=${r.report.pillars.business_model.monetization} | team=${r.report.pillars.team_size.range ? r.report.pillars.team_size.range.join('-') : 'N/A'} | gaps=${r.report.data_gaps.join(',') || '无'}`);
  });
  console.log('══════════════════════════════');
}

main().catch((e) => { console.error('批量解剖失败:', e); process.exit(1); });
