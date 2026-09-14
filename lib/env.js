/**
 * 零依赖 .env 加载（v1.7 从 llm/client.js 抽出为单一真相源）
 * ------------------------------------------------------------
 * 任何读取 process.env 中密钥的模块（llm/client、collect/company_info 等）
 * 顶部 require('./env') 即可，不依赖加载顺序的巧合。
 * 只在环境变量未设置时填入，真实 export 永远优先。
 */

const fs = require('fs');
const path = require('path');

let _loaded = false;

function loadEnv() {
  if (_loaded) return;
  _loaded = true;
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnv();

module.exports = { loadEnv };
