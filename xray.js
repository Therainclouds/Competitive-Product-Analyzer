#!/usr/bin/env node
/**
 * 竞品解剖器 · CLI 入口（v1.5）
 * ------------------------------------------------------------
 * 用法:
 *   node xray.js <url> [--out <dir>] [--no-md] [--redblue "<产品描述>"] [--no-db] [--no-cache]
 *
 * 示例:
 *   node xray.js https://linear.app --out ./reports
 *   node xray.js https://linear.app --redblue "我自己做 issue tracker，差异化是 AI 自动分类"
 *   node xray.js https://linear.app --redblue-file ./own-product.md
 *
 * 流程: pipeline.dissectOne() → 写文件 + 入库（可选）
 */

const path = require('path');
const fs = require('fs');
const { dissectOne, slugify } = require('./lib/pipeline');

function usage() {
  console.error(`用法:
  node xray.js <url> [选项]

选项:
  --out <dir>          报告输出目录（默认 xray/reports/）
  --no-md              不输出 Markdown（只出 JSON）
  --redblue "<desc>"   启用红蓝对抗，<desc> 是自家产品描述
  --redblue-file <f>   从文件读取自家产品描述
  --no-db              不写入 SQLite
  --no-cache           不使用首页缓存`);
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') usage();

  const url = argv[0];
  let ownProduct = '';
  let withRedBlue = false;

  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--out') { i++; continue; }
    if (argv[i] === '--no-md') continue;
    if (argv[i] === '--no-db') continue;
    if (argv[i] === '--no-cache') continue;
    if (argv[i] === '--redblue') {
      withRedBlue = true;
      ownProduct = argv[++i] || '';
      continue;
    }
    if (argv[i] === '--redblue-file') {
      withRedBlue = true;
      const f = argv[++i];
      if (!f) { console.error('--redblue-file 需要文件路径'); process.exit(1); }
      try {
        ownProduct = fs.readFileSync(f, 'utf8').trim();
      } catch (e) {
        console.error(`读取产品描述失败: ${e.message}`);
        process.exit(1);
      }
      continue;
    }
  }

  const outDirArgIdx = argv.indexOf('--out');
  const outDir = outDirArgIdx >= 0 ? argv[outDirArgIdx + 1] : path.join(__dirname, 'reports');
  const skipMd = argv.includes('--no-md');
  const noCache = argv.includes('--no-cache');
  const noDb = argv.includes('--no-db');

  const company = (() => {
    try { return new URL(url).hostname.replace(/^www\./, '').split('.')[0]; }
    catch { return 'unknown'; }
  })();

  console.log(`🔍 解剖 ${company} (${url}) ${withRedBlue ? '+ 红蓝对抗' : ''}...`);

  let result;
  try {
    result = await dissectOne(url, {
      ownProduct,
      withRedBlue,
      useCache: !noCache,
      writeFiles: { dir: outDir },
    });
  } catch (e) {
    console.error('解剖失败:', e.message);
    process.exit(1);
  }

  const { report, writtenFiles } = result;

  if (writtenFiles?.json) console.log(`✅ 报告 JSON: ${writtenFiles.json}`);
  if (writtenFiles?.md && !skipMd) console.log(`✅ 报告 Markdown: ${writtenFiles.md}`);

  // 持久化（Day 4 实施）
  if (!noDb) {
    try {
      const db = require('./lib/db');
      db.init();
      const id = db.saveReport({ ...report, source: 'cli' });
      console.log(`💾 已入库（id=${id}）`);
      db.close();
    } catch (e) {
      console.error(`⚠️ 入库失败（不影响主流程）: ${e.message}`);
    }
  }

  // 控制台摘要
  console.log('\n══════════ 摘要 ══════════');
  console.log(`技术栈: ${report.pillars.tech_stack.summary}`);
  console.log(`商业模式: ${report.pillars.business_model.summary}`);
  console.log(`团队规模: ${report.pillars.team_size.summary}`);
  if (report.pillars.redblue && report.pillars.redblue.present) {
    console.log(`红蓝对抗: ${report.pillars.redblue.summary}`);
  }
  if (report.data_gaps.length > 0) console.log(`数据不足: ${report.data_gaps.join('、')}`);
  console.log(`耗时: ${report.elapsed_ms}ms`);
  console.log('══════════════════════════');
}

main().catch((e) => { console.error('解剖失败:', e); process.exit(1); });
