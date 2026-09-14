#!/usr/bin/env node
/**
 * 批量解剖 · 并行版（v1.5 · Day 5）
 * ------------------------------------------------------------
 * 跨站并行（默认 5 并发），复用 pipeline.dissectOne。
 *
 * 用法:
 *   node batch_xray_parallel.js [--concurrency 5] [--out <dir>] [--with-redblue]
 *
 * 与 batch_xray.js（串行版）对比：
 *   - 5 站 × 30s/站 串行 = ~150s；并行（concurrency=5）= ~30-60s
 *   - 站内仍用 Promise.allSettled 跑三路采集
 *   - 写文件 + 入库
 */

const path = require('path');
const fs = require('fs');
const { dissectOne } = require('./lib/pipeline');
const db = require('./lib/db');

const DEFAULT_TARGETS = [
  'https://vercel.com',
  'https://linear.app',
  'https://www.notion.so',
  'https://www.figma.com',
  'https://stripe.com',
];

/** 手写 pMap（零依赖并发控制器） */
async function pMap(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      try {
        results[cur] = await fn(items[cur], cur);
      } catch (e) {
        results[cur] = { error: e.message };
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  const argv = process.argv.slice(2);
  const concIdx = argv.indexOf('--concurrency');
  const concurrency = concIdx >= 0 ? parseInt(argv[concIdx + 1], 10) : 5;
  const outIdx = argv.indexOf('--out');
  const outDir = outIdx >= 0 ? argv[outIdx + 1] : path.join(__dirname, 'reports');
  const withRedBlue = argv.includes('--with-redblue');
  const noDb = argv.includes('--no-db');

  fs.mkdirSync(outDir, { recursive: true });

  console.log(`🔍 批量解剖（${DEFAULT_TARGETS.length} 站，并发=${concurrency}，红蓝=${withRedBlue ? 'on' : 'off'}）`);

  if (!noDb) db.init();

  const startedTotal = Date.now();

  const results = await pMap(DEFAULT_TARGETS, concurrency, async (url) => {
    const company = (() => {
      try { return new URL(url).hostname.replace(/^www\./, '').split('.')[0]; }
      catch { return 'unknown'; }
    })();
    process.stdout.write(`  [start] ${company} ... `);

    try {
      const result = await Promise.race([
        dissectOne(url, {
          ownProduct: '',
          withRedBlue,
          writeFiles: { dir: outDir },
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('单站超时 180s')), 180000)),
      ]);
      const { report } = result;
      // 入库
      if (!noDb) {
        try { db.saveReport({ ...report, source: 'batch' }); } catch (e) { /* 忽略 */ }
      }
      process.stdout.write(`✅ ${report.elapsed_ms}ms | tech=${report.pillars.tech_stack.confidence} bm=${report.pillars.business_model.confidence} team=${report.pillars.team_size.confidence} | gaps=${report.data_gaps.length}\n`);
      return { url, report };
    } catch (e) {
      process.stdout.write(`❌ ${e.message}\n`);
      return { url, error: e.message };
    }
  });

  const totalElapsed = Date.now() - startedTotal;
  const ok = results.filter((r) => !r.error);

  // 验收摘要
  console.log('\n══════════ 批量验收摘要 ══════════');
  console.log(`跑通管线: ${ok.length}/${results.length}`);
  console.log(`总耗时: ${totalElapsed}ms`);
  console.log(`平均单站: ${ok.length ? Math.round(totalElapsed / ok.length) : 0}ms`);
  console.log(`技术栈有数据: ${ok.filter((r) => r.report.pillars.tech_stack.data_sufficient).length}/${ok.length}`);
  console.log(`商业模式有数据: ${ok.filter((r) => r.report.pillars.business_model.data_sufficient).length}/${ok.length}`);
  console.log(`团队规模有数据: ${ok.filter((r) => r.report.pillars.team_size.data_sufficient).length}/${ok.length}`);
  console.log(`红蓝对抗完成: ${ok.filter((r) => r.report.pillars.redblue && r.report.pillars.redblue.present && r.report.pillars.redblue.data_sufficient).length}/${ok.length}`);
  results.forEach((r) => {
    if (r.error) console.log(`- ${r.url}: ❌ ${r.error}`);
    else {
      const ts = r.report.pillars.tech_stack.items.map((i) => i.name).join(',') || '无';
      console.log(`- ${r.url}: tech=${ts} | bm=${r.report.pillars.business_model.monetization} | team=${r.report.pillars.team_size.range ? r.report.pillars.team_size.range.join('-') : 'N/A'} | gaps=${r.report.data_gaps.join(',') || '无'}`);
    }
  });

  // signals_stats
  if (!noDb) {
    const stats = db.getSignalStats();
    console.log('\n=== 信号源命中率 ===');
    stats.forEach((s) => {
      console.log(`  ${s.source.padEnd(20)} hits=${s.hits} misses=${s.misses} rate=${s.hit_rate || 0}`);
    });
    db.close();
  }

  console.log('══════════════════════════════');
}

main().catch((e) => { console.error('批量解剖失败:', e); process.exit(1); });
