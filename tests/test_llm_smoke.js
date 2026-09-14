/**
 * LLM 客户端冒烟测试
 * ------------------------------------------------------------
 * 不调用真实 API，只验证：
 *   1. config() 在缺 key 时抛错
 *   2. extractJson() 能处理三种常见 LLM 输出格式
 *   3. config() 在正确配置时返回正确字段
 */

const assert = require('assert');
const { config, extractJson } = require('../lib/llm/client');

console.log('Test 1: 缺 LLM_API_KEY 应抛错');
try {
  delete process.env.LLM_API_KEY;
  config();
  console.log('  ❌ FAILED: 未抛错');
  process.exit(1);
} catch (e) {
  assert.ok(e.message.includes('LLM_API_KEY'), '错误消息应包含 LLM_API_KEY');
  console.log('  ✅ PASSED:', e.message);
}

console.log('Test 2: extractJson 处理纯 JSON');
const r1 = extractJson('{"a":1,"b":"x"}');
assert.deepStrictEqual(r1, { a: 1, b: 'x' });
console.log('  ✅ PASSED:', JSON.stringify(r1));

console.log('Test 3: extractJson 处理 ```json 代码块');
const r2 = extractJson('```json\n{"a":2}\n```');
assert.deepStrictEqual(r2, { a: 2 });
console.log('  ✅ PASSED:', JSON.stringify(r2));

console.log('Test 4: extractJson 处理前后有废话');
const r3 = extractJson('好的，结果如下：\n{"attacks":[]}\n请查收。');
assert.deepStrictEqual(r3, { attacks: [] });
console.log('  ✅ PASSED:', JSON.stringify(r3));

console.log('Test 5: extractJson 处理无效输入应抛错');
try {
  extractJson('这不是 JSON');
  console.log('  ❌ FAILED: 未抛错');
  process.exit(1);
} catch (e) {
  console.log('  ✅ PASSED:', e.message);
}

console.log('Test 6: config 在正确配置时返回字段');
process.env.LLM_API_KEY = 'sk-test-123';
process.env.LLM_PROVIDER = 'anthropic';
const cfg = config();
assert.strictEqual(cfg.provider, 'anthropic');
assert.strictEqual(cfg.apiKey, 'sk-test-123');
assert.strictEqual(cfg.model, 'claude-sonnet-4-5');
console.log('  ✅ PASSED:', JSON.stringify(cfg));

console.log('Test 7: config 切到 openai provider');
process.env.LLM_PROVIDER = 'openai';
const cfg2 = config();
assert.strictEqual(cfg2.provider, 'openai');
assert.strictEqual(cfg2.model, 'gpt-4o-mini');
console.log('  ✅ PASSED:', JSON.stringify(cfg2));

console.log('Test 8: config 不支持的 provider 抛错');
process.env.LLM_PROVIDER = 'gemini';
try {
  config();
  console.log('  ❌ FAILED: 未抛错');
  process.exit(1);
} catch (e) {
  assert.ok(e.message.includes('gemini'));
  console.log('  ✅ PASSED:', e.message);
}

console.log('\n=== 所有测试通过 ===');
