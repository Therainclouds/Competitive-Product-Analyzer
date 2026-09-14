/**
 * 文件持久化 LRU 缓存（v1.5 · Day 5 完整实现）
 * ------------------------------------------------------------
 * 缓存 URL 的抓取结果（首页响应），避免验证期反复跑同一站。
 *
 * 设计：
 *   - key = URL（normalize 后）
 *   - value = { status, headers, body, fetched_at }
 *   - 存储位置：xray/.cache/cache.json（启动时载入，结束时落盘）
 *   - TTL：默认 24 小时（可配）
 *   - LRU：超过 maxEntries 自动淘汰最旧（按 last_used_at）
 *
 * 接口：
 *   init({ ttlMs?, maxEntries?, cachePath? })
 *   get(url)              → { status, headers, body, fetched_at } | null
 *   set(url, data)
 *   invalidate(url)
 *   clear()
 *   stats()               → { hits, misses, size, hits_rate }
 *
 * 注意：body 可能很大（首页 100KB-1MB），缓存 200 条 = 200MB 磁盘。
 *       maxEntries 默认 200，可下调。
 */

const fs = require('fs');
const path = require('path');

let _cache = new Map(); // url → { data, expires_at, last_used_at }
let _stats = { hits: 0, misses: 0, writes: 0 };
let _cfg = {
  ttlMs: 24 * 60 * 60 * 1000,
  maxEntries: 200,
  cachePath: path.join(__dirname, '..', '.cache', 'cache.json'),
  enabled: true,
};

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

function init(opts = {}) {
  _cfg = { ..._cfg, ...opts };
  _stats = { hits: 0, misses: 0, writes: 0 };
  _cache = new Map();
  if (!_cfg.enabled) return;

  // 加载磁盘缓存
  try {
    if (fs.existsSync(_cfg.cachePath)) {
      const raw = JSON.parse(fs.readFileSync(_cfg.cachePath, 'utf8'));
      const now = Date.now();
      const expiresFromNow = now + _cfg.ttlMs;
      for (const [url, entry] of Object.entries(raw)) {
        // 用当前 ttlMs 重新计算过期时间（而不是用磁盘里的 expires_at）
        const lastUsed = entry.last_used_at || entry.fetched_at || now;
        const newExpiresAt = lastUsed + _cfg.ttlMs;
        if (newExpiresAt > now) {
          _cache.set(url, { ...entry, expires_at: newExpiresAt });
        }
      }
    }
  } catch (e) {
    // 加载失败，忽略
  }
}

function persist() {
  if (!_cfg.enabled) return;
  try {
    fs.mkdirSync(path.dirname(_cfg.cachePath), { recursive: true });
    const obj = Object.fromEntries(_cache);
    fs.writeFileSync(_cfg.cachePath, JSON.stringify(obj), 'utf8');
  } catch (e) {
    // 写失败忽略
  }
}

function get(url) {
  if (!_cfg.enabled) { _stats.misses++; return null; }
  const key = normalizeUrl(url);
  const entry = _cache.get(key);
  if (!entry) { _stats.misses++; return null; }
  if (entry.expires_at <= Date.now()) {
    _cache.delete(key);
    _stats.misses++;
    return null;
  }
  entry.last_used_at = Date.now();
  _stats.hits++;
  return entry.data;
}

function set(url, data) {
  if (!_cfg.enabled) return;
  const key = normalizeUrl(url);
  const now = Date.now();
  _cache.set(key, {
    data,
    expires_at: now + _cfg.ttlMs,
    last_used_at: now,
  });
  _stats.writes++;
  evictIfNeeded();
  persist();
}

function evictIfNeeded() {
  if (_cache.size <= _cfg.maxEntries) return;
  // 按 last_used_at 排序，淘汰最旧的
  const entries = Array.from(_cache.entries())
    .sort((a, b) => a[1].last_used_at - b[1].last_used_at);
  const toRemove = entries.slice(0, _cache.size - _cfg.maxEntries);
  for (const [k] of toRemove) _cache.delete(k);
}

function invalidate(url) {
  const key = normalizeUrl(url);
  _cache.delete(key);
  persist();
}

function clear() {
  _cache.clear();
  persist();
}

function stats() {
  const total = _stats.hits + _stats.misses;
  return {
    ..._stats,
    size: _cache.size,
    hit_rate: total === 0 ? 0 : Math.round((_stats.hits / total) * 1000) / 1000,
  };
}

module.exports = { init, get, set, invalidate, clear, stats, persist };
