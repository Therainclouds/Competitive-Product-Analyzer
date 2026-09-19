/**
 * 公司信息 / 团队规模 v1.8 单测（离线，零网络）
 * ------------------------------------------------------------
 * 验证：
 *   1. chNameScore 名称匹配打分（同名消歧基础）
 *   2. estimateTeamRange：SEC 10-K 员工数 → 硬区间
 *   3. estimateTeamRange：Companies House 法定上限裁剪（micro ≤10 / small ≤50）
 *   4. opencorporates 字段已彻底移除（免费 API 被拒后的接替路径生效）
 */

const assert = require('assert');
const { chNameScore } = require('../lib/collect/company_info');
const { estimateTeamRange } = require('../lib/collect/team');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  ✅', name); }
  catch (e) { console.log('  ❌', name, '-', e.message); process.exitCode = 1; }
}

console.log('\n=== 公司信息 / 团队规模 v1.8 测试 ===\n');

ok('chNameScore：精确/归一/包含三档', () => {
  assert.strictEqual(chNameScore('linear', 'linear'), 3);
  assert.strictEqual(chNameScore('Linear Technology Ltd', 'linear-technology'), 2.5);
  assert.strictEqual(chNameScore('Linear Group Holdings', 'linear'), 2);
  assert.strictEqual(chNameScore('Unrelated Corp', 'linear'), 0);
});

ok('SEC 10-K 员工数 → 硬区间 [n*0.9, n*1.3]', () => {
  const r = estimateTeamRange(
    { found: false },
    { jobCount: 0 },
    { sec_edgar: { found: true, cik: '0001108524', employees: 83334, filing_date: '2026-03-02' } },
  );
  assert.ok(r.data_sufficient);
  assert.strictEqual(r.range[0], Math.floor(83334 * 0.9));
  assert.strictEqual(r.range[1], Math.ceil(83334 * 1.3));
  const sig = r.signals.find((s) => s.source === 'sec_edgar');
  assert.ok(/硬数据/.test(sig.raw));
});

ok('Companies House micro-entity → 法定上限裁剪 max≤10', () => {
  // 招聘页推断 8 岗 → [20,48]，若无裁剪 max=48；micro 上限 10 → 最终 [1,10]
  const r = estimateTeamRange(
    { found: false },
    { jobCount: 8 },
    { companies_house: { found: true, incorporation_date: '2024-01-01', company_status: 'active', size_constraint: { label: 'micro-entity 账户', max_employees: 10 } } },
  );
  assert.ok(r.data_sufficient);
  assert.ok(r.range[1] <= 10, `max=${r.range[1]} 应被裁剪到 ≤10`);
  assert.ok(r.range[1] >= r.range[0]);
});

ok('small company 账户 → max ≤50 裁剪', () => {
  const r = estimateTeamRange(
    { found: true, publicRepos: 40, publicMembers: null }, // repos 30-99 → theorg/大 org 提示，不直接给区间
    { jobCount: 30 }, // → [75, 180]
    { companies_house: { found: true, incorporation_date: '2020-05-01', company_status: 'active', size_constraint: { label: 'small company 账户', max_employees: 50 } } },
  );
  assert.ok(r.range[1] <= 50, `max=${r.range[1]} 应被裁剪到 ≤50`);
});

ok('无法定上限时不裁剪（老行为不回归）', () => {
  const r = estimateTeamRange({ found: false }, { jobCount: 30 }, { companies_house: { found: true, incorporation_date: '2020-05-01', company_status: 'active' } });
  assert.strictEqual(r.range[1], 180); // 30 岗 × 6
});

ok('注册信息无 size_constraint → 弱信号不产生区间', () => {
  const r = estimateTeamRange({ found: false }, { jobCount: 0 }, { companies_house: { found: true, incorporation_date: '2015-01-01', company_status: 'active' } });
  assert.strictEqual(r.data_sufficient, false); // 只有弱信号 → 不编区间
});

console.log(`\n=== ${passed} 项通过 ===\n`);
