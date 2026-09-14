/**
 * wappalyzer 规则匹配引擎（v1.7 · P0-2）
 * ------------------------------------------------------------
 * 输入静态可得的页面信号，输出命中技术（含版本、类别、传递关系）。
 * 通道（静态子集）：scriptSrc / headers / cookies / meta / html / url / dns(TXT)
 * 浏览器通道（js / dom / scripts / xhr）不实现——这是与官方引擎的已知差距。
 *
 * 关系语义：
 *   - implies：命中 A 且 A implies B → B 也算命中（带父应用作依据）
 *   - requires：B 只有被 implies 带出时，需 requires 的应用也在最终集合中
 *   - excludes：A 命中且其 excludes 模式匹配到 B → B 被剔除
 */

const { loadRules } = require('./rules_loader');

/** 提取页面里的 script src 列表 */
function extractScriptSrcs(html) {
  const out = [];
  const re = /<script[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 80) out.push(m[1]);
  return out;
}

/** 提取 <meta name= content=> 映射（两种属性顺序都兼容） */
function extractMetas(html) {
  const map = {};
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const name = (tag.match(/name=["']([^"']+)["']/i) || [])[1];
    const content = (tag.match(/content=["']([^"']*)["']/i) || [])[1];
    if (name && content !== undefined) map[name.toLowerCase()] = content;
  }
  return map;
}

/** Set-Cookie 头 → [{name, value}] */
function parseSetCookies(headerVal) {
  if (!headerVal) return [];
  const arr = Array.isArray(headerVal) ? headerVal : String(headerVal).split(/,(?=\s*[a-z0-9_.-]+=)/i);
  return arr.map((c) => {
    const [pair] = c.trim().split(';');
    const eq = pair.indexOf('=');
    return eq > 0 ? { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() } : null;
  }).filter(Boolean);
}

/** 从编译好的 pattern + 实际匹配串提取版本号 */
function extractVersion(comp, matchedStr) {
  if (!comp.versionRe && !comp.constraints.length) return null;
  const m = comp.re.exec(matchedStr);
  if (!m) return null;
  if (comp.versionRe) {
    if (comp.versionRe.startsWith('~~GTE~~')) return comp.versionRe.slice(7);
    let v = comp.versionRe;
    for (let i = 9; i >= 1; i--) v = v.split(`\\${i}`).join(m[i] || '');
    if (v.startsWith('(') || v.includes('(.+')) v = (m[1] || '').trim();
    v = v.trim();
    return v && v.length <= 20 && !/[\\^$[\](){}|*+]/.test(v) ? v : null;
  }
  return null;
}

/**
 * 主检测入口
 * ctx: { url, headers: {}, html, dnsTxt: string[] }
 * 返回 [{ name, version, cats, channel, evidencePattern, impliedBy }]
 */
function detect(ctx) {
  const { apps, byName } = loadRules();
  const { html = '', headers = {}, url = '', dnsTxt = [] } = ctx;
  const normHeaders = {};
  for (const [k, v] of Object.entries(headers)) normHeaders[k.toLowerCase()] = String(v);
  const scriptSrcs = extractScriptSrcs(html).join(' ');
  const metas = extractMetas(html);
  const cookies = parseSetCookies(headers['set-cookie'] || headers['Set-Cookie']);

  const hits = new Map(); // name → { app, channel, pattern, version }

  const hit = (app, channel, pattern, evidenceStr, version) => {
    if (!hits.has(app.name)) hits.set(app.name, { app, channel, pattern, version: version || null });
    else if (!hits.get(app.name).version && version) hits.get(app.name).version = version;
  };

  for (const app of apps) {
    // 1. scriptSrc
    if (scriptSrcs && app.scriptSrc) {
      for (const c of app.scriptSrc) {
        const m = c.re.exec(scriptSrcs);
        if (m) { hit(app, 'scriptSrc', c, m[0], extractVersion(c, scriptSrcs)); break; }
      }
      if (hits.has(app.name)) continue;
    }
    // 2. headers
    if (app.headers) {
      for (const h of app.headers) {
        const val = h.key ? normHeaders[h.key] : Object.values(normHeaders).join(' ');
        if (!val) continue;
        const m = h.re.exec(val);
        if (m) { hit(app, 'headers', h, val, extractVersion(h, val)); break; }
      }
      if (hits.has(app.name)) continue;
    }
    // 3. cookies
    if (app.cookies && cookies.length) {
      for (const ck of app.cookies) {
        const target = cookies.filter((c) => !ck.key || c.name.toLowerCase() === ck.key.toLowerCase());
        let matched = null;
        for (const c of target) {
          const m = ck.comp.re.exec(ck.key ? c.value : c.name);
          if (m) { matched = m; break; }
        }
        if (matched) { hit(app, 'cookies', ck.comp, matched[0], extractVersion(ck.comp, matched[0])); break; }
      }
      if (hits.has(app.name)) continue;
    }
    // 4. meta
    if (app.meta) {
      for (const mt of app.meta) {
        const val = mt.key ? metas[mt.key] : Object.values(metas).join(' ');
        if (!val) continue;
        const m = mt.comp.re.exec(val);
        if (m) { hit(app, 'meta', mt.comp, val, extractVersion(mt.comp, val)); break; }
      }
      if (hits.has(app.name)) continue;
    }
    // 5. html
    if (html && app.html.length) {
      for (const c of app.html) {
        const m = c.re.exec(html);
        if (m) { hit(app, 'html', c, m[0], extractVersion(c, m[0])); break; }
      }
      if (hits.has(app.name)) continue;
    }
    // 6. url
    if (app.url.length) {
      for (const c of app.url) if (c.re.test(url)) { hit(app, 'url', c, url); break; }
    }
    // 7. dns TXT
    if (dnsTxt.length && app.dns.length) {
      const txt = dnsTxt.join(' ');
      for (const c of app.dns) { const m = c.re.exec(txt); if (m) { hit(app, 'dns', c, m[0]); break; } }
    }
  }

  // ---- implies 传递闭包（迭代到不动点，上限 5 轮）----
  for (let round = 0; round < 5; round++) {
    const current = [...hits.keys()];
    let added = false;
    for (const name of current) {
      const parent = hits.get(name).app;
      const impliedList = [];
      for (const rel of parent.implies.names) if (!hits.has(rel) && byName.has(rel)) impliedList.push(byName.get(rel));
      for (const rx of parent.implies.regexes) {
        for (const [appName] of hits) if (rx.test(appName)) { /* 名称再匹配场景罕见，跳过 */ }
      }
      for (const app of impliedList) {
        hits.set(app.name, { app, channel: 'implies', pattern: `implied by ${name}`, version: null, impliedBy: name });
        added = true;
      }
    }
    if (!added) break;
  }

  // ---- requires 校验：被 implies 带出的应用，其 requires 必须在最终集合中 ----
  for (const [name, h] of [...hits]) {
    if (h.channel !== 'implies') continue;
    const reqs = h.app.requires;
    const unsatisfied = [...reqs.names].some((r) => !hits.has(r) && !reqs.any)
      || reqs.regexes.some((rx) => ![...hits.keys()].some((k) => rx.test(k)));
    if (unsatisfied) hits.delete(name);
  }

  // ---- excludes 剔除：A 命中且 A.excludes 匹配到 B → B 出局 ----
  for (const [nameA, hA] of hits) {
    if (!hA.app.excludes) continue;
    let re;
    try { re = new RegExp(hA.app.excludes.split('\\;')[0], 'i'); } catch (e) { continue; }
    for (const [nameB] of [...hits]) {
      if (nameB !== nameA && re.test(nameB)) hits.delete(nameB);
    }
  }

  return [...hits.values()].map((h) => ({
    name: h.app.name,
    version: h.version,
    cats: h.app.cats,
    channel: h.channel,
    pattern: h.pattern && h.pattern.re ? String(h.pattern.re) : String(h.pattern),
    impliedBy: h.impliedBy || null,
  }));
}

module.exports = { detect, extractScriptSrcs, extractMetas, parseSetCookies };
