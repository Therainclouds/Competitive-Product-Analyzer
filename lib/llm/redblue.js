/**
 * 红蓝对抗生成器（v1.5 · V1.0 核心卖点）
 * ------------------------------------------------------------
 * 核心思路（来自 v2.0 审查意见 2.11）：
 *   攻击路径必须绑定报告内的真实证据，每条攻击后做「证据回查」防止套话。
 *
 * 接口：
 *   generateRedBlue({ ownProduct, targetUrl, report, pool })
 *     → {
 *       attacks: [{ angle, evidence, reasoning, attack_path, confidence }],
 *       evidence_check: { used, missing, notes },
 *       summary: string,
 *       data_sufficient: bool,
 *       confidence: 'high'|'medium'|'low',
 *       meta: { tokens, elapsed_ms, error? }
 *     }
 *
 * 失败语义：
 *   - LLM 调用失败 → 返回 { data_sufficient: false, error, attacks: [] }
 *   - 证据回查后无任何 attack 有有效 evidence → data_sufficient: false
 *   - 失败时不影响主报告（不抛异常）
 */

const { chat } = require('./client');
const { REDBLUE_SYSTEM, buildRedBlueUserPrompt } = require('./prompts');

/**
 * 证据回查：对每个 attack 的 evidence[] 做有效性校验
 *  - evidence id 必须在 pool.all() 里存在
 *  - 不存在的 id 进 missing，原 attack confidence 降为 low
 *  - 完全没有有效 evidence 的 attack 标 confidence=low + 备注
 */
function evidenceCheck(attacks, pool) {
  const validIds = new Set(pool.all().map((e) => e.id));
  const used = [];
  const missing = [];
  const notes = [];

  for (const atk of attacks) {
    if (!Array.isArray(atk.evidence)) {
      atk.evidence = [];
    }
    const valid = atk.evidence.filter((id) => validIds.has(id));
    const invalid = atk.evidence.filter((id) => !validIds.has(id));
    if (invalid.length > 0) {
      missing.push(...invalid);
      notes.push(`attack「${atk.angle}」引用了不存在的 evidence: ${invalid.join(', ')}（已降级为 low）`);
    }
    atk.evidence = valid;
    if (valid.length > 0) used.push(...valid);
    if (valid.length === 0 && atk.confidence !== 'low') {
      notes.push(`attack「${atk.angle}」无有效 evidence，confidence 强制为 low`);
      atk.confidence = 'low';
    }
    // v1.7 强化：缺可验证攻击路径（attack_path）的攻击同样降级——
    // 「视角」是产品卖点，没有具体路径的攻击是套话，按契约降级处理
    const pathOk = typeof atk.attack_path === 'string' && atk.attack_path.trim().length >= 20;
    if (!pathOk && atk.confidence !== 'low') {
      notes.push(`attack「${atk.angle}」缺少可验证攻击路径（attack_path 空或过短），confidence 强制为 low`);
      atk.confidence = 'low';
    }
  }

  return { used: [...new Set(used)], missing: [...new Set(missing)], notes };
}

/**
 * 综合 confidence（基于攻击角度的 evidence 加权）
 */
function aggregateConfidence(attacks) {
  if (attacks.length === 0) return 'low';
  const weights = { high: 1.0, medium: 0.6, low: 0.3 };
  const total = attacks.reduce((sum, a) => sum + (weights[a.confidence] || 0), 0);
  const avg = total / attacks.length;
  if (avg >= 0.8) return 'high';
  if (avg >= 0.5) return 'medium';
  return 'low';
}

/**
 * 主入口
 */
async function generateRedBlue({ ownProduct, targetUrl, report, pool }) {
  const meta = { tokens: null, elapsed_ms: 0, error: null };

  // 准备 prompt
  const userPrompt = buildRedBlueUserPrompt(report, ownProduct || '');

  let llmRes;
  try {
    llmRes = await chat({
      messages: [{ role: 'user', content: userPrompt }],
      system: REDBLUE_SYSTEM,
      temperature: 0.6,
      maxTokens: 3000,
      jsonMode: true,
    });
    meta.tokens = (llmRes.usage?.input_tokens || 0) + (llmRes.usage?.output_tokens || 0);
    meta.elapsed_ms = llmRes.elapsed_ms;
  } catch (e) {
    meta.error = e.message;
    return {
      attacks: [],
      evidence_check: { used: [], missing: [], notes: [`LLM 调用失败: ${e.message}`] },
      summary: '红蓝对抗生成失败（LLM 不可达）',
      data_sufficient: false,
      confidence: 'low',
      meta,
    };
  }

  // 解析 LLM 返回（client 已用 extractJson 处理过）
  let parsed;
  if (typeof llmRes.text === 'object') {
    parsed = llmRes.text;
  } else {
    // 兜底：理论上 jsonMode=true 不会到这里
    parsed = { attacks: [] };
  }

  const attacks = Array.isArray(parsed.attacks) ? parsed.attacks : [];
  const summary = parsed.summary || '';

  // 证据回查
  const check = evidenceCheck(attacks, pool);

  // 过滤：保留 confidence 非空的 attack；空 evidence 的保留但标 low
  const cleanAttacks = attacks.filter((a) => a && a.angle);

  // 数据充分性：至少 1 个 attack 有 ≥1 有效 evidence
  const dataSufficient = cleanAttacks.some((a) => a.evidence.length > 0);

  // 写 evidence 进 pool（红蓝对抗是 LLM 推理产物，本身产生新 evidence）
  for (const atk of cleanAttacks) {
    pool.add({
      source: 'llm_redblue',
      kind: 'attack',
      detail: `攻击「${atk.angle}」confidence=${atk.confidence} evidence=${atk.evidence.join(',') || 'none'}`,
      url: targetUrl,
    });
  }

  const confidence = aggregateConfidence(cleanAttacks);

  return {
    attacks: cleanAttacks,
    evidence_check: check,
    summary,
    data_sufficient: dataSufficient,
    confidence,
    meta: { ...meta, model: llmRes.model },
  };
}

module.exports = { generateRedBlue, evidenceCheck, aggregateConfidence };
