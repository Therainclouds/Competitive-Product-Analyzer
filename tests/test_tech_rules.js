/**
 * 技术栈规则引擎冒烟测试（v1.7 · 离线，零网络）
 * 覆盖：加载、编译、通道匹配、版本提取、implies/excludes、增量合并、误报回归
 */

const assert = require('assert');
const { loadRules } = require('../lib/tech/rules_loader');
const { detect } = require('../lib/tech/detect');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  ✅', name); }
  catch (e) { console.log('  ❌', name, '-', e.message); process.exitCode = 1; }
}

console.log('\n=== 技术栈规则引擎测试 ===\n');

ok('规则加载：静态通道可达应用 5000+ 且 Next.js 存在', () => {
  const { apps, byName } = loadRules();
  assert.ok(apps.length > 5000, `apps=${apps.length}`); // 7613 条规则中仅含 js/dom 浏览器通道的 app 不参与静态检测
  assert.ok(byName.has('Next.js'));
});

ok('增量规则已合并进 Next.js（scriptSrc 含 _next 路径）', () => {
  const { byName } = loadRules();
  const nx = byName.get('Next.js');
  assert.ok(nx.scriptSrc.some((c) => /_next/.test(String(c.re))), 'scriptSrc 未含增量 pattern');
});

ok('React 检测 + 版本提取（scriptSrc）', () => {
  const hits = detect({
    url: 'https://example.com',
    headers: {},
    html: '<script src="/static/react-18.2.0.min.js"></script>',
  });
  const react = hits.find((h) => h.name === 'React');
  assert.ok(react, '未命中 React');
  assert.strictEqual(react.version, '18.2.0');
});

ok('P3 回归：id="app" 不再误报 Vue.js', () => {
  const hits = detect({ url: 'https://figma.com', headers: {}, html: '<div id="app"></div><ng-version="1">x</ng-version>' });
  const names = hits.map((h) => h.name);
  assert.ok(!names.includes('Vue.js'), 'Vue.js 误报回归');
  assert.ok(!names.includes('AngularJS'), 'Angular 误报回归');
});

ok('Next.js 信号：_next/static 脚本路径 + x-nextjs-cache 头', () => {
  const a = detect({ url: 'https://x.com', headers: {}, html: '<script src="/_next/static/chunks/main-abc.js"></script>' });
  assert.ok(a.some((h) => h.name === 'Next.js'));
  const b = detect({ url: 'https://x.com', headers: { 'x-nextjs-cache': 'HIT' }, html: '' });
  assert.ok(b.some((h) => h.name === 'Next.js'));
});

ok('Vercel 增量信号：x-vercel-id 头', () => {
  const hits = detect({ url: 'https://x.com', headers: { 'x-vercel-id': 'cnt1::abc-1' }, html: '' });
  assert.ok(hits.some((h) => h.name === 'Vercel'));
});

ok('implies 传递：Next.js 命中带出 React', () => {
  const hits = detect({ url: 'https://x.com', headers: {}, html: '<script src="/_next/static/chunks/main.js"></script>' });
  const react = hits.find((h) => h.name === 'React');
  assert.ok(react, 'React 未被 implies');
  assert.strictEqual(react.channel, 'implies');
});

ok('meta 通道：generator=WordPress 带版本', () => {
  const hits = detect({ url: 'https://blog.com', headers: {}, html: '<meta name="generator" content="WordPress 6.5">' });
  const wp = hits.find((h) => h.name === 'WordPress');
  assert.ok(wp);
  assert.strictEqual(wp.version, '6.5');
});

ok('cookies 通道：NEXT_LOCALE', () => {
  const hits = detect({ url: 'https://x.com', headers: { 'set-cookie': 'NEXT_LOCALE=en; Path=/' }, html: '' });
  assert.ok(hits.some((h) => h.name === 'Next.js'));
});

ok('无证据输入 → 零命中（不编造）', () => {
  const hits = detect({ url: 'https://x.com', headers: {}, html: '<html><body>nothing</body></html>' });
  assert.strictEqual(hits.length, 0);
});

ok('detect 性能：单页 < 500ms（规则全扫描）', () => {
  const html = '<html>' + '<script src="/assets/index-abc123.js"></script>'.repeat(20) + '<div data-reactroot></div>' + '</html>';
  const t0 = Date.now();
  detect({ url: 'https://x.com', headers: { server: 'nginx' }, html });
  const ms = Date.now() - t0;
  assert.ok(ms < 500, `耗时 ${ms}ms`);
});

console.log(`\n=== ${passed} 项通过 ===\n`);
