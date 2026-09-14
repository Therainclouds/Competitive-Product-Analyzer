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

function fetchOnce(url, timeoutMs, maxBytes, redirects) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'CompetitorXRay-Probe/0.1 (public-info-research)',
        'Accept': 'text/html,application/xhtml+xml,application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'close', // 避免 keep-alive 卡死
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        try {
          const next = new URL(res.headers.location, url).toString();
          fetchOnce(next, timeoutMs, maxBytes, redirects - 1).then(resolve, reject);
        } catch (e) { reject(e); }
        return;
      }
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > maxBytes) req.destroy(); });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body,
        finalUrl: res.url || url,
        redirectsUsed: 3 - redirects,
      }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** 带重试的抓取：超时/连接错误重试 up to retries 次 */
async function fetchUrl(url, timeoutMs = 40000, maxBytes = 2 * 1024 * 1024, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchOnce(url, timeoutMs, maxBytes, 3);
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 1500 * (i + 1))); // 退避
    }
  }
  throw lastErr;
}

module.exports = { fetchUrl };
