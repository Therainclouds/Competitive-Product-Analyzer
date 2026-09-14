/**
 * 定价页 LLM 结构化抽取（v1.7 · A-MINT schema）
 * ------------------------------------------------------------
 * 规则引擎（pricing.js）给出 monetization 粗判断后，本模块用 LLM 把定价页
 * 文本抽成结构化 plans[]（名称/价格/周期/额度/卖点），高置信时可覆盖规则判断。
 *
 * 失败语义（与 redblue 同款优雅降级，绝不影响主报告）：
 *   - LLM 未配置 / 调用失败 / JSON 无效 / 结构不合 schema → { available: false, reason }
 *   - plans 中缺字段的条目保留（faithful to text 优先于结构完整）
 */

const { chat, isConfigured } = require('./client');
const { PRICING_EXTRACT_SYSTEM, buildPricingExtractPrompt } = require('./prompts');

const MONETIZATION_ENUM = new Set([
  'freemium', 'subscription', 'usage-based', 'ad-supported',
  'enterprise-quote', 'free-product', 'one-time', 'unknown',
]);

/** 去 HTML 标签 + 压空白（定价页文本给 LLM 前的最小清洗） */
function stripHtml(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 结构校验与归一（纯函数，便于单测）
 * 合法 → { available: true, plans[], monetization_primary, monetization_secondary, confidence, notes }
 * 非法 → { available: false, reason }
 */
function validateExtraction(parsed) {
  if (!parsed || typeof parsed !== 'object') return { available: false, reason: 'LLM 输出不是对象' };
  const mp = String(parsed.monetization_primary || '').toLowerCase();
  if (!MONETIZATION_ENUM.has(mp)) return { available: false, reason: `monetization_primary 非法值: ${mp}` };
  const conf = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low';
  const plansIn = Array.isArray(parsed.plans) ? parsed.plans : [];
  const plans = plansIn
    .filter((p) => p && typeof p === 'object' && p.name)
    .slice(0, 12)
    .map((p) => ({
      name: String(p.name).slice(0, 60),
      price: p.price === null || p.price === undefined ? null : String(p.price).slice(0, 20),
      currency: p.currency ? String(p.currency).slice(0, 8) : null,
      period: ['month', 'year', 'one-time'].includes(p.period) ? p.period : null,
      quota: p.quota ? String(p.quota).slice(0, 120) : null,
      key_features: Array.isArray(p.key_features) ? p.key_features.slice(0, 5).map((f) => String(f).slice(0, 100)) : [],
    }));
  if (plans.length === 0 && mp === 'unknown') return { available: false, reason: '既无套餐结构也认不出变现方式' };
  return {
    available: true,
    monetization_primary: mp,
    monetization_secondary: Array.isArray(parsed.monetization_secondary) ? parsed.monetization_secondary.slice(0, 3).map(String) : [],
    plans,
    confidence: conf,
    notes: String(parsed.notes || '').slice(0, 300),
  };
}

/**
 * 主入口
 * @param {string} pricingHtml  定价页 HTML
 * @param {object} identified   规则引擎初步判断 { monetization, priceHints, paywall }
 * @returns 同 validateExtraction 输出 + meta
 */
async function extractPricing(pricingHtml, identified) {
  if (!isConfigured()) return { available: false, reason: 'LLM 未配置（无 key），跳过结构化抽取' };
  const text = stripHtml(pricingHtml);
  if (text.length < 100) return { available: false, reason: '定价页文本过短，不值得调用 LLM' };

  const meta = { elapsed_ms: 0, error: null };
  const t0 = Date.now();
  let llmRes;
  try {
    llmRes = await chat({
      messages: [{ role: 'user', content: buildPricingExtractPrompt(text, identified) }],
      system: PRICING_EXTRACT_SYSTEM,
      temperature: 0.2,
      maxTokens: 2000,
      jsonMode: true,
    });
    meta.elapsed_ms = Date.now() - t0;
  } catch (e) {
    meta.error = e.message;
    return { available: false, reason: `LLM 调用失败: ${e.message}`, meta };
  }

  const result = validateExtraction(typeof llmRes.text === 'object' ? llmRes.text : null);
  return { ...result, meta: { ...meta, model: llmRes.model } };
}

module.exports = { extractPricing, validateExtraction, stripHtml, MONETIZATION_ENUM };
