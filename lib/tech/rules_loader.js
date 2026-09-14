/**
 * webappanalyzer 规则源加载器（v1.7 · P0-2）
 * ------------------------------------------------------------
 * 快照来源：github.com/enthec/webappanalyzer（MIT License）
 *   src/technologies/*.json + src/categories.json + src/groups.json
 * 刷新方式：node scripts/update_rules.js
 *
 * 规则语义（wappalyzer driver 的子集，全部可静态判定）：
 *   - 各 pattern 字段（html / scriptSrc / headers / cookies / meta / url / dns）
 *     的值可以是 string 或 string[]，多个 pattern 之间是 OR
 *   - pattern 串用 `\;` 分隔语义段：`正则\;version:\1\;version>=5.0`
 *   - implies[] 传递 / requires[] 前提 / excludes 互斥（填应用名或正则）
 *   - js / dom / scripts / xhr 是浏览器侧通道，本静态管线不实现
 */

const fs = require('fs');
const path = require('path');

const RULES_DIR = path.join(__dirname, '..', '..', 'rules', 'webappanalyzer');

/** 把一条 wappalyzer pattern 编译成 {re, versionRe, constraints[]} */
function compilePattern(p) {
  if (typeof p !== 'string') return { re: null, versionRe: null, constraints: [] };
  if (p === '') return { re: /(?:)/i, versionRe: null, constraints: [] }; // 空 pattern = 存在即命中（cookie 名/头名）
  const segments = p.split('\\;').map((s) => s.trim()).filter(Boolean);
  let re = null, versionRe = null;
  const constraints = [];
  for (const seg of segments) {
    const ci = seg.search(/(?<!\\);/); // 段内残留的未转义 ';' 也作分隔（社区规则常见笔误）
    const parts = ci >= 0 ? [seg.slice(0, ci), seg.slice(ci + 1)] : [seg];
    for (const piece of parts) {
      if (!piece) continue;
      if (piece.startsWith('version:')) {
        versionRe = piece.slice(8).replace(/^>=/, '~~GTE~~');
      } else if (piece.startsWith('version_GE_')) {
        constraints.push({ op: 'gte', ver: piece.slice(11) });
      } else if (!re) {
        try { re = new RegExp(piece, 'i'); } catch (e) { re = null; }
      }
    }
  }
  return { re, versionRe, constraints };
}

/** 收集一个字段下所有 pattern 的编译结果 */
function compileField(val) {
  const arr = Array.isArray(val) ? val : [val];
  const out = [];
  for (const v of arr) {
    if (typeof v !== 'string') continue; // 对象形式（如 dom 的 {properties,textContent}）不支持，跳过
    const c = compilePattern(v);
    if (c.re) out.push(c);
  }
  return out;
}

/** implies / requires 数组 → {names:Set, regexes:[], any:bool} */
function compileRelations(val) {
  const r = { names: new Set(), regexes: [], any: false };
  if (!val) return r;
  const arr = Array.isArray(val) ? val : [val];
  for (const v of arr) {
    const s = String(v);
    if (s === '\\;version:') continue;
    if (s.startsWith('\\;')) { r.any = true; continue; }
    const seg = s.split('\\;')[0].trim();
    if (!seg) { r.any = true; continue; }
    // 纯应用名（不含正则元字符）直接进 names，否则当正则
    if (/^[A-Za-z0-9 .+#\-_]+$/.test(seg) && !/[\\^$\[\](){}*+?|]/.test(seg)) {
      r.names.add(seg);
    } else {
      try { r.regexes.push(new RegExp(seg, 'i')); } catch (e) { /* 坏正则跳过 */ }
    }
  }
  return r;
}

let cached = null;

/** 把增量规则 JSON 合入 apps 集合（同名应用按通道并集合并） */
function mergeIncremental(byName, incPath) {
  const data = JSON.parse(fs.readFileSync(incPath, 'utf8'));
  for (const [name, v] of Object.entries(data)) {
    if (name.startsWith('_')) continue; // 元信息键
    const inc = {
      html: v.html || [], scriptSrc: v.scriptSrc || [], url: v.url || [], dns: v.dns || [],
      headers: v.headers || {}, cookies: v.cookies || {}, meta: v.meta || {},
      implies: v.implies || [], requires: v.requires || [],
    };
    if (!byName.has(name)) {
      const app = buildApp(name, v);
      if (app) byName.set(name, app);
      continue;
    }
    const a = byName.get(name);
    a.html = a.html.concat(compileField(inc.html));
    a.scriptSrc = a.scriptSrc.concat(compileField(inc.scriptSrc));
    a.url = a.url.concat(compileField(inc.url));
    a.dns = a.dns.concat(compileField(inc.dns));
    a.headers = (a.headers || []).concat(Object.entries(inc.headers).map(([key, val]) => ({ key: key ? key.toLowerCase() : null, ...compilePattern(val) })).filter((h) => h.re));
    const cookieEntries = Object.entries(inc.cookies).map(([key, val]) => ({ key: key || null, comp: compilePattern(val) })).filter((c) => c.comp.re);
    a.cookies = (a.cookies || []).concat(cookieEntries);
    const metaEntries = Object.entries(inc.meta).map(([key, val]) => ({ key: key.toLowerCase(), comp: compilePattern(val) })).filter((m) => m.comp.re);
    a.meta = (a.meta || []).concat(metaEntries);
    // 约定：增量规则只补探测通道，不新增 implies/requires 关系（社区规则已含，避免破坏已编译结构）
  }
}

function buildApp(name, v) {
  const app = {
    name,
    cats: Array.isArray(v.cats) ? v.cats : [],
    headers: null,
    cookies: null,
    meta: null,
    html: compileField(v.html),
    scriptSrc: compileField(v.scriptSrc),
    url: compileField(v.url),
    dns: compileField(v.dns),
    implies: compileRelations(v.implies),
    requires: compileRelations(v.requires),
    excludes: typeof v.excludes === 'string' ? v.excludes : Array.isArray(v.excludes) ? v.excludes.join('\\;') : null,
  };
  if (v.headers) {
    const headers = typeof v.headers === 'string' ? { '': v.headers } : v.headers;
    app.headers = Object.entries(headers).map(([key, val]) => {
      const c = compilePattern(val);
      return { key: key ? key.toLowerCase() : null, ...c };
    }).filter((h) => h.re);
  }
  if (v.cookies) {
    const cookies = typeof v.cookies === 'string' ? { '': v.cookies } : v.cookies;
    app.cookies = Object.entries(cookies).map(([key, val]) => ({ key: key || null, comp: compilePattern(val) })).filter((c) => c.comp.re);
  }
  if (v.meta) {
    const meta = typeof v.meta === 'string' ? { '': v.meta } : v.meta;
    app.meta = Object.entries(meta).map(([key, val]) => ({ key: key.toLowerCase(), comp: compilePattern(val) })).filter((m) => m.comp.re);
  }
  const hasSignal = app.headers || app.cookies || app.meta ||
    app.html.length || app.scriptSrc.length || app.url.length || app.dns.length;
  return hasSignal ? app : null;
}

function loadRules() {
  if (cached) return cached;
  const apps = [];
  const files = fs.readdirSync(RULES_DIR).filter((f) => /^[_.a-z]\.json$/.test(f));
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(RULES_DIR, f), 'utf8'));
    for (const [name, v] of Object.entries(data)) {
      const app = buildApp(name, v);
      if (app) apps.push(app);
    }
  }
  const byName = new Map(apps.map((a) => [a.name, a]));

  // ---- 合并自维护增量规则 ----
  const INC_DIR = path.join(__dirname, '..', '..', 'rules', 'incremental');
  if (fs.existsSync(INC_DIR)) {
    for (const f of fs.readdirSync(INC_DIR).filter((x) => x.endsWith('.json'))) {
      mergeIncremental(byName, path.join(INC_DIR, f));
    }
  }
  cached = { apps: [...byName.values()], byName };
  return cached;
}

module.exports = { loadRules, compilePattern };
