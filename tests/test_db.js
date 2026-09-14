/**
 * SQLite 持久化层单元测试
 * ------------------------------------------------------------
 * 用临时 db 文件测试，不污染 xray.db。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDb = path.join(os.tmpdir(), `xray-test-${Date.now()}.db`);
const db = require('../lib/db');

db.init({ dbPath: tmpDb });

const sampleReport = {
  target: 'https://linear.app',
  company: 'linear',
  generated_at: new Date().toISOString(),
  elapsed_ms: 12345,
  pillars: {
    tech_stack: { items: [{ name: 'Next.js' }], confidence: 'high' },
    business_model: { monetization: 'freemium' },
    team_size: { range: [10, 50] },
    redblue: { attacks: [{ angle: '价格战' }] },
  },
  data_gaps: [],
  evidence: [{ id: 'ev-1' }],
  disclaimer: 'test disclaimer',
  source: 'test',
};

console.log('Test 1: saveReport → 返回 id');
const id = db.saveReport(sampleReport);
assert.ok(id > 0, 'id 应 > 0');
console.log('  ✅ PASSED, id =', id);

console.log('Test 2: getReport → 完整读取');
const r = db.getReport(id);
assert.strictEqual(r.target, sampleReport.target);
assert.strictEqual(r.company, 'linear');
assert.strictEqual(r.slug, 'linear');
assert.strictEqual(r.pillars.tech_stack.items[0].name, 'Next.js');
assert.strictEqual(r.pillars.business_model.monetization, 'freemium');
assert.strictEqual(r.pillars.team_size.range[0], 10);
assert.strictEqual(r.pillars.redblue.attacks[0].angle, '价格战');
console.log('  ✅ PASSED');

console.log('Test 3: listReports → 列表');
const list = db.listReports({ slug: 'linear' });
assert.ok(list.length >= 1);
assert.strictEqual(list[0].company, 'linear');
console.log('  ✅ PASSED, list size =', list.length);

console.log('Test 4: saveFeedback → 写入并验证');
const fbId = db.saveFeedback({
  reportId: id,
  pillar: 'tech_stack',
  itemRef: 'tech:Next.js',
  verdict: 'correct',
  note: 'Linear 确实用 Next.js',
});
assert.ok(fbId > 0);
const fbs = db.getFeedbacksForReport(id);
assert.strictEqual(fbs.length, 1);
assert.strictEqual(fbs[0].verdict, 'correct');
console.log('  ✅ PASSED, feedback id =', fbId);

console.log('Test 5: feedback verdict 校验');
try {
  db.saveFeedback({ reportId: id, pillar: 'tech_stack', verdict: 'invalid' });
  console.log('  ❌ FAILED: 未抛错');
  process.exit(1);
} catch (e) {
  assert.ok(e.message.includes('verdict'));
  console.log('  ✅ PASSED:', e.message);
}

console.log('Test 6: recordSignalHit / recordSignalMiss + getSignalStats');
db.recordSignalHit('headers');
db.recordSignalHit('headers');
db.recordSignalMiss('headers');
db.recordSignalHit('github');
const stats = db.getSignalStats();
const headers = stats.find((s) => s.source === 'headers');
assert.strictEqual(headers.hits, 2);
assert.strictEqual(headers.misses, 1);
assert.strictEqual(headers.hit_rate, 0.667);
console.log('  ✅ PASSED, headers hit_rate =', headers.hit_rate);

console.log('Test 7: listReports 包含 feedback_count');
const list2 = db.listReports({ slug: 'linear' });
assert.ok(list2[0].feedback_count >= 1);
console.log('  ✅ PASSED, feedback_count =', list2[0].feedback_count);

db.close();
fs.unlinkSync(tmpDb);

console.log('\n=== 所有 DB 测试通过 ===');
