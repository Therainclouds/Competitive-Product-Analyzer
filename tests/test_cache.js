/**
 * Cache 单元测试
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpCache = path.join(os.tmpdir(), `xray-cache-test-${Date.now()}.json`);
const cache = require('../lib/cache');

cache.init({ cachePath: tmpCache, ttlMs: 60000 });

console.log('Test 1: get 不存在的 key → null');
assert.strictEqual(cache.get('https://example.com'), null);
console.log('  ✅ PASSED');

console.log('Test 2: set + get → 返回一致');
const data = { status: 200, body: 'hello', fetched_at: new Date().toISOString() };
cache.set('https://example.com', data);
const got = cache.get('https://example.com');
assert.deepStrictEqual(got, data);
console.log('  ✅ PASSED');

console.log('Test 3: stats 记录 hit');
const s = cache.stats();
assert.strictEqual(s.hits, 1);
assert.strictEqual(s.misses, 1);
assert.strictEqual(s.writes, 1);
assert.strictEqual(s.size, 1);
console.log('  ✅ PASSED, hits =', s.hits, 'writes =', s.writes);

console.log('Test 4: URL normalize（带 hash 的 URL 视为相同）');
cache.set('https://example.com/page#section1', { body: 'x' });
assert.ok(cache.get('https://example.com/page#section2') !== null);
console.log('  ✅ PASSED');

console.log('Test 5: 持久化 → 重启 init 后数据还在');
cache.persist();
cache.init({ cachePath: tmpCache, ttlMs: 60000 });
assert.ok(cache.get('https://example.com') !== null, '重启后应能取到');
console.log('  ✅ PASSED');

console.log('Test 6: 过期 → TTL 到期返回 null');
cache.init({ cachePath: tmpCache, ttlMs: -1 }); // TTL 已过期
assert.strictEqual(cache.get('https://example.com'), null);
console.log('  ✅ PASSED');

console.log('Test 7: LRU 淘汰');
cache.init({ cachePath: tmpCache, ttlMs: 60000, maxEntries: 3 });
cache.set('a', { x: 1 });
cache.set('b', { x: 2 });
cache.set('c', { x: 3 });
cache.set('d', { x: 4 }); // 应淘汰 'a'
cache.get('a'); // 应 miss
const s2 = cache.stats();
assert.strictEqual(cache.get('b') !== null, true, 'b 应在');
assert.strictEqual(cache.get('c') !== null, true, 'c 应在');
assert.strictEqual(cache.get('d') !== null, true, 'd 应在');
console.log('  ✅ PASSED, size =', s2.size);

console.log('Test 8: clear + invalidate');
cache.invalidate('b');
assert.strictEqual(cache.get('b'), null);
cache.clear();
assert.strictEqual(cache.stats().size, 0);
console.log('  ✅ PASSED');

fs.unlinkSync(tmpCache);
console.log('\n=== 所有 Cache 测试通过 ===');
