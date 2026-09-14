/**
 * 红蓝对抗单元测试（不调真实 LLM）
 * ------------------------------------------------------------
 * 验证：
 *   1. evidenceCheck 能识别有效/无效 evidence ID
 *   2. 无效 evidence 的 attack 自动降级为 confidence=low
 *   3. aggregateConfidence 计算正确
 *   4. generateRedBlue 在 LLM 失败时返回 data_sufficient: false 不抛错
 */

const assert = require('assert');
const { evidenceCheck, aggregateConfidence } = require('../lib/llm/redblue');
const { createEvidencePool } = require('../lib/evidence');

// 模拟 evidence 池
const pool = createEvidencePool();
pool.add({ source: 'headers', kind: 'response_header', detail: 'server: nginx', url: 'https://linear.app' }); // ev-1
pool.add({ source: 'pricing_page', kind: 'page_found', detail: '/pricing', url: 'https://linear.app/pricing' }); // ev-2
pool.add({ source: 'github', kind: 'org', detail: 'org=linear', url: 'https://github.com/linear' }); // ev-3

console.log('Test 1: evidenceCheck 接受有效 ID');
const attacks1 = [
  { angle: '价格碾压', evidence: ['ev-1', 'ev-2'], confidence: 'high' },
  { angle: '渠道优势', evidence: ['ev-3'], confidence: 'medium' },
];
const r1 = evidenceCheck(attacks1, pool);
assert.strictEqual(r1.used.length, 3);
assert.strictEqual(r1.missing.length, 0);
assert.strictEqual(attacks1[0].confidence, 'high'); // 没动
assert.strictEqual(attacks1[1].confidence, 'medium');
console.log('  ✅ PASSED');

console.log('Test 2: evidenceCheck 拒绝无效 ID 并降级');
const attacks2 = [
  { angle: '虚构攻击', evidence: ['ev-99', 'ev-100'], confidence: 'high' }, // 都不存在
  { angle: '部分有效', evidence: ['ev-1', 'ev-99'], confidence: 'high' },
];
const r2 = evidenceCheck(attacks2, pool);
assert.strictEqual(r2.used.length, 1);
assert.deepStrictEqual(r2.missing.sort(), ['ev-100', 'ev-99']);
assert.strictEqual(attacks2[0].confidence, 'low'); // 全部无效 → 强制 low
assert.strictEqual(attacks2[0].evidence.length, 0);
assert.strictEqual(attacks2[1].confidence, 'high'); // 有 1 个有效 → 保持 high
assert.deepStrictEqual(attacks2[1].evidence, ['ev-1']);
console.log('  ✅ PASSED:', r2.notes.length, '条 notes');

console.log('Test 3: aggregateConfidence');
assert.strictEqual(aggregateConfidence([]), 'low');
assert.strictEqual(aggregateConfidence([{ confidence: 'high' }, { confidence: 'high' }]), 'high');
// weights: high=1.0, medium=0.6, low=0.3
// 边界：avg >= 0.8 → high；avg >= 0.5 → medium；否则 low
assert.strictEqual(aggregateConfidence([{ confidence: 'high' }, { confidence: 'medium' }]), 'high'); // avg=0.8 → high
assert.strictEqual(aggregateConfidence([{ confidence: 'high' }, { confidence: 'low' }]), 'medium'); // avg=0.65 → medium
assert.strictEqual(aggregateConfidence([{ confidence: 'medium' }, { confidence: 'medium' }]), 'medium'); // avg=0.6 → medium
assert.strictEqual(aggregateConfidence([{ confidence: 'medium' }, { confidence: 'low' }]), 'low'); // avg=0.45 → low
assert.strictEqual(aggregateConfidence([{ confidence: 'low' }, { confidence: 'low' }]), 'low'); // avg=0.3 → low
console.log('  ✅ PASSED');

console.log('Test 4: generateRedBlue 在 LLM 失败时不抛错');
process.env.LLM_API_KEY = 'sk-fake'; // 故意 fake，触发网络失败
const { generateRedBlue } = require('../lib/llm/redblue');
(async () => {
  try {
    const r = await generateRedBlue({
      ownProduct: '我自己做 issue tracker',
      targetUrl: 'https://linear.app',
      report: { pillars: { tech_stack: { items: [] }, business_model: {}, team_size: {} } },
      pool,
    });
    assert.strictEqual(r.data_sufficient, false);
    assert.ok(r.meta.error, '应有 error 字段');
    assert.strictEqual(r.attacks.length, 0);
    console.log('  ✅ PASSED:', r.meta.error.slice(0, 60));
  } catch (e) {
    console.log('  ❌ FAILED: 不应抛错:', e.message);
    process.exit(1);
  }

  console.log('\n=== 所有红蓝对抗测试通过 ===');
})();
