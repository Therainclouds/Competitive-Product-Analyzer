/**
 * 定价页 LLM 抽取 · 单测（v1.7，不调真实 LLM）
 * ------------------------------------------------------------
 * 验证：
 *   1. validateExtraction 接受合法 A-MINT 结构并归一
 *   2. 非法 monetization / 缺 plans 且 unknown → 拒绝
 *   3. 单条目缺字段保留（忠实原文优先），超长截断
 *   4. extractPricing 无 key 时优雅降级 available:false
 *   5. stripHtml 去标签压空白
 */

const assert = require('assert');
const { validateExtraction, extractPricing, stripHtml } = require('../lib/llm/pricing_extract');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  ✅', name); }
  catch (e) { console.log('  ❌', name, '-', e.message); process.exitCode = 1; }
}

console.log('\n=== 定价页 LLM 抽取测试 ===\n');

ok('validateExtraction 接受合法结构', () => {
  const r = validateExtraction({
    monetization_primary: 'freemium',
    monetization_secondary: ['enterprise-quote'],
    plans: [
      { name: 'Free', price: '0', currency: 'USD', period: 'month', quota: '3 projects', key_features: ['核心功能'] },
      { name: 'Pro', price: '8', currency: 'USD', period: 'month', quota: null, key_features: [] },
    ],
    confidence: 'high',
    notes: '',
  });
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.plans.length, 2);
  assert.strictEqual(r.plans[1].price, '8');
  assert.strictEqual(r.confidence, 'high');
});

ok('validateExtraction 拒绝非法 monetization', () => {
  const r = validateExtraction({ monetization_primary: 'crypto-mining', plans: [] });
  assert.strictEqual(r.available, false);
  assert.ok(/非法值/.test(r.reason));
});

ok('validateExtraction 拒绝 unknown 且无套餐', () => {
  const r = validateExtraction({ monetization_primary: 'unknown', plans: [] });
  assert.strictEqual(r.available, false);
});

ok('validateExtraction 容忍单条目缺字段 + 截断脏输入', () => {
  const r = validateExtraction({
    monetization_primary: 'subscription',
    plans: [
      { name: 'Enterprise' }, // 只有名字，合法（询价场景）
      { name: 'x'.repeat(200), price: '9'.repeat(100) },
      { noName: true },
    ],
    confidence: 'weird',
  });
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.plans.length, 2); // 无名条目被过滤
  assert.strictEqual(r.plans[0].name, 'Enterprise');
  assert.ok(r.plans[1].name.length <= 60);
  assert.strictEqual(r.plans[1].period, null);
  assert.strictEqual(r.confidence, 'low'); // 非法 confidence 归 low
});

ok('validateExtraction plans 上限 12', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `P${i}`, price: String(i) }));
  const r = validateExtraction({ monetization_primary: 'subscription', plans: many, confidence: 'high' });
  assert.strictEqual(r.plans.length, 12);
});

ok('extractPricing 无 key 优雅降级（不抛错）', async () => {
  // 本测试环境不保证 key 存在与否：只断言不抛异常且返回对象
  // （有 key 时会走真实调用，故显式禁 LLM：通过未配置环境）
});

ok('stripHtml 去标签与脚本', () => {
  const out = stripHtml('<div>Pro $8<span>mo</span></div><script>var x=1;</script>  <style>a{}</style>');
  assert.ok(!out.includes('<'));
  assert.ok(!out.includes('var x'));
  assert.ok(out.includes('Pro'));
  assert.ok(out.includes('mo'));
});

(async () => {
  // 真实降级路径：临时清 key
  const savedKey = process.env.LLM_API_KEY;
  delete process.env.LLM_API_KEY;
  try {
    const r = await extractPricing('<html><body>pricing</body></html>', { monetization: 'unknown' });
    assert.strictEqual(r.available, false);
    assert.ok(/未配置|过短/.test(r.reason), `reason=${r.reason}`);
    console.log('  ✅ extractPricing 无 key 降级 reason 合理:', r.reason);
    passed++;
  } catch (e) {
    console.log('  ❌ extractPricing 无 key 应不抛错 -', e.message);
    process.exitCode = 1;
  } finally {
    if (savedKey) process.env.LLM_API_KEY = savedKey;
  }

  // 文本过短降级（有 key 场景也成立）
  process.env.LLM_API_KEY = process.env.LLM_API_KEY || 'sk-test';
  const r2 = await extractPricing('<b>tiny</b>', {});
  assert.strictEqual(r2.available, false);
  assert.ok(/过短/.test(r2.reason));
  console.log('  ✅ 文本过短降级');
  passed++;

  console.log(`\n=== ${passed} 项通过 ===\n`);
})();
