/**
 * 刷新 webappanalyzer 规则快照（v1.7）
 * ------------------------------------------------------------
 * 用法：node scripts/update_rules.js
 * 依赖：git（仅用 GitHub API 列目录 + raw 下载，不整仓 clone）
 * 快照落地：rules/webappanalyzer/（提交进仓库，运行时零网络）
 * 规则源：github.com/enthec/webappanalyzer（MIT，社区持续维护）
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'rules', 'webappanalyzer');
const API = 'https://api.github.com/repos/enthec/webappanalyzer/contents';
const RAW = 'https://raw.githubusercontent.com/enthec/webappanalyzer/main';

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'CompetitorXRay-RulesUpdater/1.0', 'Accept': 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return get(res.headers.location).then(resolve, reject);
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => res.statusCode === 200 ? resolve(body) : reject(new Error(`${res.statusCode} ${url}`)));
    }).on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const dirs = JSON.parse(await get(`${API}/src/technologies`));
  let n = 0;
  for (const f of dirs.filter((d) => d.type === 'file' && d.name.endsWith('.json'))) {
    const body = await get(`${RAW}/src/technologies/${f.name}`);
    JSON.parse(body); // 校验完整性
    fs.writeFileSync(path.join(OUT, f.name), body);
    n++;
    process.stdout.write(`  ${f.name}\n`);
  }
  for (const f of ['categories.json', 'groups.json']) {
    fs.writeFileSync(path.join(OUT, f), await get(`${RAW}/src/${f}`));
    n++;
  }
  console.log(`\n✅ 已刷新 ${n} 个规则文件 → ${OUT}`);
  fs.writeFileSync(path.join(OUT, '_snapshot.json'), JSON.stringify({
    source: 'enthec/webappanalyzer@main',
    refreshed_at: new Date().toISOString(),
  }, null, 2));
  console.log('   刷新后请 git diff 检查异常（体量骤降=上游结构变更，勿直接提交）。');
})();
