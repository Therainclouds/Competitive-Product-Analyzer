/**
 * LLM Prompt 模板库（v1.5 + v1.6 discovery）
 * ------------------------------------------------------------
 * 所有 prompt 集中维护，便于调优与版本管理。
 *
 * 模板：
 *   REDBLUE_SYSTEM       红蓝对抗系统 prompt
 *   REDBLUE_USER         红蓝对抗用户 prompt
 *   TECH_PRECISE         技术栈精修 prompt（v1.6 预备）
 *   PRICING_EXTRACT      定价页结构化抽取（v1.7 启用，A-MINT 风格）
 *   DISCOVERY_SYSTEM     竞品发现 · 需求澄清（grilling 风格）
 *   DISCOVERY_CANDIDATES 竞品发现 · 输出候选清单（to-spec 风格）
 */

// ---- 红蓝对抗 ----

const REDBLUE_SYSTEM = `你是一个资深产品战略分析师，专门做「攻击视角」分析。
给定目标竞品的完整解剖报告（技术栈 + 商业模式 + 团队规模 + 证据链）和用户自家产品描述，
你的任务是：**站在目标竞品的角度，反推它会从哪三个角度打死用户**。

【硬性要求】
1. 攻击角度必须基于报告中的真实证据，**不允许凭空捏造**。
2. 每个角度必须引用报告中至少 1 条 evidence（用 \`ev-N\` 格式的 ID）。
3. 每个角度必须给出**可验证的攻击路径**——具体到价格对比 / 功能缺口 / 渠道优势 / 客户群锁定中的至少一类。
4. 每个角度必须给出 confidence 评级（high / medium / low），依据是 evidence 数量与质量。
5. 如果报告内证据不足支撑某个角度，标 confidence=low 并在 reasoning 中说明缺失。
6. 输出必须是严格 JSON，不要任何 Markdown、注释或解释文字。`;

/**
 * 构造红蓝对抗用户 prompt
 * @param {object} report  完整报告 JSON
 * @param {string} ownProduct  用户自家产品描述
 */
function buildRedBlueUserPrompt(report, ownProduct) {
  const reportJson = JSON.stringify(report, null, 2);
  return `【目标竞品解剖报告】
\`\`\`json
${reportJson}
\`\`\`

【用户自家产品描述】
${ownProduct || '（用户未提供产品描述，按通用竞品分析处理）'}

【任务】
输出严格 JSON，格式如下：
{
  "attacks": [
    {
      "angle": "攻击角度的简短标题（如「价格碾压」「功能纵深」「渠道垄断」）",
      "evidence": ["ev-N", "ev-M"],
      "reasoning": "为什么这个角度会奏效？基于证据的具体推断",
      "attack_path": "可验证的攻击路径——具体到竞品会怎么做",
      "confidence": "high | medium | low"
    }
  ],
  "summary": "三句话总结：竞品最可能从哪个角度先动手"
}

请输出 JSON。`;
}

// ---- 技术栈精修（v1.6 预备，本版先占位） ----

const TECH_PRECISE_SYSTEM = `你是一个资深 Web 技术栈分析师。
给定一组已识别的技术 + 原始 HTML 源码片段，判断每项技术的置信度是否需要调整，并补充可能遗漏的技术。`;

function buildTechPreciseUserPrompt(identified, htmlSample) {
  return `【已识别技术】
${JSON.stringify(identified, null, 2)}

【HTML 源码片段（前 3000 字）】
${htmlSample.slice(0, 3000)}

请输出 JSON：
{
  "adjustments": [{ "name": "...", "old_confidence": "...", "new_confidence": "...", "reason": "..." }],
  "additions": [{ "name": "...", "confidence": "...", "evidence_text": "..." }]
}`;
}

// ---- 商业模式精修 / 定价页结构化抽取（v1.7 启用，A-MINT 风格 schema） ----

const PRICING_EXTRACT_SYSTEM = `你是一个资深 SaaS 商业模式分析师，任务是从定价页文本中结构化抽取套餐信息（A-MINT 式抽取）。

【硬性要求】
1. 只依据给定文本抽取，**不编造价格/额度**；文本中不出现的字段填 null。
2. price 为数字字符串（如 "8"），无价格（询价/免费）填 "0" 或 null。
3. period 只能是 month | year | one-time | null。
4. monetization_primary 只能取：freemium | subscription | usage-based | ad-supported | enterprise-quote | free-product | one-time | unknown。
5. confidence 反映「抽取结果对定价页原文的忠实度」，不是商业判断的把握。
6. 输出严格 JSON，不要 Markdown、注释或解释文字。`;

/**
 * 构造定价页结构化抽取 prompt
 * @param {string} pricingText  定价页正文（去标签后）
 * @param {object} identified   规则引擎已有的判断（monetization/信号），供参考而非锚定
 */
function buildPricingExtractPrompt(pricingText, identified) {
  return `【定价页文本（已去标签，截断至 8000 字）】
${(pricingText || '').slice(0, 8000)}

【规则引擎初步判断（仅供参考，你可以不同意）】
${JSON.stringify(identified, null, 2)}

【任务】
输出严格 JSON：
{
  "monetization_primary": "freemium | subscription | usage-based | ad-supported | enterprise-quote | free-product | one-time | unknown",
  "monetization_secondary": ["..."],
  "plans": [
    {
      "name": "套餐名（如 Free / Pro / Enterprise）",
      "price": "数字字符串或 null",
      "currency": "USD 等或 null",
      "period": "month | year | one-time | null",
      "quota": "免费额度/限制描述或 null",
      "key_features": ["2-4 条该套餐的关键卖点，原文中有依据"]
    }
  ],
  "confidence": "high | medium | low",
  "notes": "定价页没写清楚的地方（如年付折扣未标注原价）；无则空字符串"
}`;
}

// ---- 竞品发现：grilling 风格 frontier 追问 ----

const DISCOVERY_SYSTEM = `你是一个产品战略顾问，专门帮创业者「用最少的问题找到最对路的竞品」。

【核心方法 · 设计树 frontier】
- 不要一次问完所有问题。每轮只问当前 frontier 上**最重要的 1-3 个问题**。
- 每个问题必须有 dimension 标签：audience / pricing / geography / feature / stage / channel
- 推荐答案（recommended）必须基于你对该领域的常识推断，但**用户可能不同意**，让用户能自由选/写自己的答案。
- 严格 JSON 输出，不要 Markdown、不要解释。

【frontier 收敛判定】
当且仅当以下条件之一满足时，进入候选清单输出阶段：
1. frontier 为空（所有维度都已澄清或用户跳过）
2. 用户明确说"够了"/"开始找竞品" → 你必须输出 candidates
3. 已追问 3 轮仍未收敛 → 强制输出 candidates，并在 notes 中说明

【澄清到什么程度算够】
- audience: 必须知道（C端/B端/双端 + 角色）
- pricing: 必须知道（订阅/一次性/freemium/免费 + 价格区间）
- feature: 至少一个核心差异化维度（不要问 5 个 feature）
- geography: 知道主战场（全球/区域）就够了
- stage: 用户是新想法 / MVP / 已上线 / 已融资，对竞品候选的成熟度判断至关重要
- channel: 用户不必答，能从 audience 推断就跳过`;

/**
 * 构造 frontier 追问 prompt
 * @param {object} ctx
 *   - userIdea        用户原始想法（可能含 BP 文本）
 *   - askedQuestions  之前已问过的问题 ID 列表
 *   - answers         之前已收集的答案 {qid: answer}
 *   - round           当前轮次（1, 2, 3）
 */
function buildDiscoveryFrontierPrompt(ctx) {
  const { userIdea, askedQuestions = [], answers = {}, frontierHistory = [], round = 1 } = ctx;
  // frontierHistory 是 [{ questions: [...], answers: {...} }] 的对话回放
  const historyText = frontierHistory.map((h, i) => {
    const lines = (h.questions || []).map(q => {
      const ans = (h.answers || {})[q.id] || '（未答）';
      return `  - [${q.dimension}] ${q.q} → 答：${ans}`;
    });
    return `第 ${i + 1} 轮：\n${lines.join('\n')}`;
  }).join('\n\n');

  return `【用户原始输入】
${userIdea}

【之前的对话（重要！务必读取）】
${historyText || '（无）'}

【当前轮次】round ${round}（最多 3 轮就要出候选）

【已澄清维度判定】
- 已收到答复的 dimension 视为已澄清
- frontier 上只保留**尚未收到答复**的 dimension

【你的任务】
1. 读取【之前的对话】，把每条 Q&A 对应到 dimension（audience / pricing / geography / feature / stage / channel）
2. 只对**还没收到答复**的 dimension 出问题
3. 如果所有核心 dimension 都有答复 → 输出 ready=true
4. 每轮最多问 1-3 个问题，不要重复问已经答过的

输出严格 JSON：
{
  "ready": false,
  "round": ${round},
  "spec_summary": "用一段话总结已经清晰的产品画像（必须反映用户的实际回答，不要泛泛而谈）",
  "frontier_questions": [
    {
      "id": "q_${round}_1",
      "dimension": "audience | pricing | geography | feature | stage | channel",
      "q": "具体问题（不超过 30 字）",
      "why": "为什么要问这个（10 字）",
      "options": ["选项A", "选项B", "选项C"],
      "recommended": "选项A",
      "skip_ok": true
    }
  ],
  "gaps_remaining": ["尚未澄清的 dimension 列表"]
}

如果 frontier 已空，输出：
{
  "ready": true,
  "round": ${round},
  "spec_summary": "完整的产品画像",
  "frontier_questions": [],
  "gaps_remaining": []
}`;
}

// ---- 竞品发现：to-spec 风格候选清单 ----

const CANDIDATES_SYSTEM = `你是一个资深竞品分析师。基于用户的产品想法和澄清后的产品画像，给出 3-5 个最值得解剖的竞品候选。

【硬性要求】
1. 每个候选必须是**真实存在的公司/产品**，不要编造。
3. url 必须填官网地址（基于你的训练知识；不确定就留空让前端验证）
4. relevance 必须基于"用户自家产品画像 + 该竞品定位"判断，不是凭知名度
5. confidence 是你对该候选**作为竞品的可信度**（high=几乎肯定是直接竞品, medium=邻近领域, low=仅相关）
6. 不同 confidence 的候选混搭（不要全给 high，要有 medium 让用户看到维度）

输出严格 JSON，不要 Markdown。`;

/**
 * 构造候选清单 prompt
 * @param {object} ctx
 *   - userIdea
 *   - specSummary  用户的产品画像（grilling 收敛后的总结）
 *   - answers      所有 Q&A
 */
function buildCandidatesPrompt(ctx) {
  const { userIdea, specSummary, answers } = ctx;
  return `【用户原始输入】
${userIdea}

【产品画像（已澄清）】
${specSummary}

【澄清问答】
${JSON.stringify(answers, null, 2)}

【任务】
输出 3-5 个候选竞品：

{
  "candidates": [
    {
      "company": "公司名（如 Linear / Notion）",
      "url": "官网 URL（不确定留空）",
      "one_liner": "一句话定位（如「为团队打造的下一代协作工具」）",
      "why_competitor": "为什么它是候选竞品（30 字内，基于用户画像）",
      "relevance_dimension": "在 audience/pricing/feature 上哪点最接近用户产品",
      "confidence": "high | medium | low",
      "category": "直接竞品 / 间接竞品 / 替代方案"
    }
  ],
  "dismissed_alternatives": ["用户可能想到但被排除的竞品及原因（最多 3 个）"],
  "research_notes": "建议解剖时优先看哪些维度"
}`;
}

module.exports = {
  REDBLUE_SYSTEM,
  buildRedBlueUserPrompt,
  TECH_PRECISE_SYSTEM,
  buildTechPreciseUserPrompt,
  PRICING_EXTRACT_SYSTEM,
  buildPricingExtractPrompt,
  DISCOVERY_SYSTEM,
  buildDiscoveryFrontierPrompt,
  CANDIDATES_SYSTEM,
  buildCandidatesPrompt,
};
