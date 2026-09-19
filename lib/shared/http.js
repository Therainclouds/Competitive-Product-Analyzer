/**
 * 共享 HTTP 抓取工具（零依赖）
 * ------------------------------------------------------------
 * 供 tech_stack_probe.js / pricing_probe.js 复用。
 * 合规姿态：真实 UA + 明示公开信息抓取，不伪装、不绕验证码。
 *
 * 网络说明：本机存在透明限速/波动层（TLS 握手和传输时快时慢，
 * 实测 386ms ~ 12s+ 波动），故内置 2 次自动重试 + 长超时。
 */

const https = require('https');
const http = require('http');

function fetchOnce(url, timeoutMs, maxBytes, redirects, extraHeaders) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(hardTimer); fn(arg); } };
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'CompetitorXRay-Probe/0.1 (public-info-research)',
        'Accept': 'text/html,application/xhtml+xml,application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'close', // 避免 keep-alive 卡死
        ...(extraHeaders || {}),
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        try {
          const next = new URL(res.headers.location, url).toString();
          fetchOnce(next, timeoutMs, maxBytes, redirects - 1).then((v) => finish(resolve, v), (e) => finish(reject, e));
        } catch (e) { finish(reject, e); }
        return;
      }
      let body = '';
      res.on('data', (c) => {
        if (settled) return;
        body += c;
        if (body.length >= maxBytes) {
          // 截断即成功：超大页面（现代营销页常 >2MB）前段已含全部有效信号，
          // 慢滴传输等 end 只会白耗预算。销毁连接停止读取。
          finish(resolve, {
            status: res.statusCode,
            headers: res.headers,
            body,
            truncated: true,
            finalUrl: res.url || url,
            redirectsUsed: 3 - redirects,
          });
          req.destroy();
        }
      });
      res.on('end', () => finish(resolve, {
        status: res.statusCode,
        headers: res.headers,
        body,
        truncated: false,
        finalUrl: res.url || url,
        redirectsUsed: 3 - redirects,
      }));
      res.on('aborted', () => finish(reject, new Error('aborted')));
    });
    // 空闲超时：连接建立后无数据流动
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    // v1.7 硬总时限（慢站根治）：透明限速层「滴字节」会让空闲超时不断重置，
    // 此定时器覆盖整个请求生命周期（含传输），到点开火不可恢复。
    const hardTimer = setTimeout(() => {
      req.destroy(new Error(`hard-timeout >${timeoutMs}ms: ${url}`));
    }, timeoutMs);
    req.on('error', (e) => finish(reject, e));
  });
}

/**
 * 带重试的抓取：超时/连接错误重试 up to retries 次
 * v1.7 新增 deadline（绝对时间戳）：每次尝试的超时取 min(timeoutMs, deadline-now)；
 * 剩余预算 < 3000ms 时直接抛 budget-exhausted（不消耗重试），用于管线级预算控制。
 * budget-exhausted ≠ 无信号：调用方应记录为「采集未完成」证据（可重采），而非数据缺失。
 */
async function fetchUrl(url, timeoutMs = 15000, maxBytes = 2 * 1024 * 1024, retries = 1, deadline = 0, extraHeaders = null) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    if (deadline && Date.now() > deadline - 3000) {
      const e = new Error(`budget-exhausted: ${url}`);
      e.budgetExhausted = true;
      throw e;
    }
    const budget = deadline ? Math.min(timeoutMs, deadline - Date.now()) : timeoutMs;
    try {
      return await fetchOnce(url, budget, maxBytes, 3, extraHeaders);
    } catch (e) {
      lastErr = e;
      if (i < retries && deadline && Date.now() > deadline - 3000) break; // 预算尽不再重试
      if (i < retries) await new Promise((r) => setTimeout(r, 1500 * (i + 1))); // 退避
    }
  }
  throw lastErr;
}

module.exports = { fetchUrl };
