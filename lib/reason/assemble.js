/**
 * 推理层（SPECS 第六节）：三件套组装 + 置信度 + 数据不足判断
 * ------------------------------------------------------------
 * 每个维度：结论 + 证据链（evidenceIds → pool 引用）+ 置信度。
 * 证据不足 → data_sufficient=false，进 data_gaps，不编数字。
 */

const { gradeConfidence, weightedScore } = require('../evidence');

/** 组装技术栈维度 */
function assembleTechStack(items, pool) {
  // 合并同名技术（多源命中 → 高置信度）
  const byName = new Map();
  for (const it of items) {
    if (!byName.has(it.name)) byName.set(it.name, { name: it.name, evidenceIds: [], version: null });
    byName.get(it.name).evidenceIds.push(...it.evidenceIds);
    if (!byName.get(it.name).version && it.version) byName.get(it.name).version = it.version;
  }

  const techItems = [];
  for (const [name, agg] of byName) {
    const { score, independentSources } = weightedScore(agg.evidenceIds, pool);
    techItems.push({
      name,
      version: agg.version,
      confidence: gradeConfidence(score, independentSources),
      evidence: pool.refs(agg.evidenceIds),
      score,
    });
  }
  // 按置信度 + 分数排序
  techItems.sort((a, b) => (b.confidence === 'high' ? 1 : 0) - (a.confidence === 'high' ? 1 : 0) || b.score - a.score);

  const allIds = techItems.flatMap((t) => t.evidence.map((r) => r.evidenceId));
  const { score, independentSources } = weightedScore(allIds, pool);

  return {
    items: techItems.map(({ score, ...rest }) => rest), // 保留 evidence 引用（SPECS 契约）
    confidence: techItems.length === 0 ? 'low' : gradeConfidence(score, independentSources),
    data_sufficient: techItems.length > 0,
    summary: techItems.length === 0
      ? '未能识别技术栈（页面不可达或无指纹命中）'
      : `识别到 ${techItems.length} 项技术：${techItems.slice(0, 6).map((t) => t.name).join(', ')}${techItems.length > 6 ? ' 等' : ''}`,
  };
}

/** 组装商业模式维度 */
function assembleBusinessModel(bm, pool) {
  const { score, independentSources } = weightedScore(bm.evidenceIds, pool);
  return {
    monetization: bm.monetization,
    pricing_page: bm.pricingPageUrl,
    pricing_hints: bm.priceHints,
    providers: bm.providers,
    llm_extract: bm.llmExtract && bm.llmExtract.available ? {
      plans: bm.llmExtract.plans,
      monetization_primary: bm.llmExtract.monetization_primary,
      monetization_secondary: bm.llmExtract.monetization_secondary,
      rule_monetization: bm.llmExtract.rule_monetization || null,
      confidence: bm.llmExtract.confidence,
      notes: bm.llmExtract.notes,
    } : null,
    confidence: bm.monetization === 'unknown' ? 'low' : gradeConfidence(score, independentSources),
    data_sufficient: bm.data_sufficient && bm.monetization !== 'unknown',
    summary: bm.monetization === 'unknown'
      ? '未能判断变现方式（未找到定价页或定价信号不足）'
      : `变现方式：${bm.monetization}（定价页：${bm.pricingPageUrl || '未找到'}）`,
  };
}

/** 组装团队规模维度 */
function assembleTeamSize(team, pool) {
  const signals = team.signals.map((s) => ({ ...s, evidence: [] })); // 简化：signal 自身即证据描述
  const confidence = 'low'; // SPECS：团队规模一律低置信度 + 区间输出
  const caveats = [];
  if (team.signals.some((s) => s.caveat === 'large-org')) caveats.push('large-org: 大型 GitHub org（repos≥50），招聘页推断可能严重低估');
  if (team.signals.some((s) => s.caveat === 'public-company')) caveats.push('public-company: SEC EDGAR 命中（上市公司），实际规模可能远大于非上市推断');
  let summary;
  if (team.range) {
    summary = caveats.length > 0
      ? `估算团队规模区间 ${team.range[0]}-${team.range[1]} 人（低置信度）⚠️ ${caveats.join('；')}`
      : `估算团队规模区间 ${team.range[0]}-${team.range[1]} 人（低置信度）`;
  } else {
    summary = '公开数据不足，无法估算团队规模（GitHub org 未找到且无招聘页岗位信号）';
  }
  return {
    range: team.range,
    signals,
    confidence,
    data_sufficient: team.data_sufficient,
    caveats,
    summary,
  };
}

/** 组装红蓝对抗维度（v1.5 新增 · 可选） */
function assembleRedBlue(redblueRes) {
  if (!redblueRes) {
    return { present: false, data_sufficient: false, attacks: [], summary: '未运行红蓝对抗' };
  }
  const attacks = redblueRes.attacks || [];
  let summary;
  if (redblueRes.meta?.error) {
    summary = `红蓝对抗生成失败：${redblueRes.meta.error.slice(0, 80)}`;
  } else if (attacks.length === 0) {
    summary = '红蓝对抗未生成攻击角度（LLM 返回为空）';
  } else {
    const angles = attacks.map((a) => `${a.angle}(${a.confidence})`).join(' / ');
    summary = `识别 ${attacks.length} 个攻击角度：${angles}`;
  }
  return {
    present: true,
    attacks,
    evidence_check: redblueRes.evidence_check || { used: [], missing: [], notes: [] },
    summary,
    confidence: redblueRes.confidence || 'low',
    data_sufficient: redblueRes.data_sufficient === true,
    meta: redblueRes.meta || {},
  };
}

/** 主组装：输入三个采集结果 + evidence 池 → Report 的 pillars + data_gaps */
function assemble(url, company, pool, tech, bm, team) {
  const techStack = assembleTechStack(tech.items, pool);
  const businessModel = assembleBusinessModel(bm, pool);
  const teamSize = assembleTeamSize(team, pool);

  const dataGaps = [];
  if (!techStack.data_sufficient) dataGaps.push('技术栈');
  if (!businessModel.data_sufficient) dataGaps.push('商业模式');
  if (!teamSize.data_sufficient) dataGaps.push('团队规模');

  return {
    target: url,
    company,
    pillars: {
      tech_stack: techStack,
      business_model: businessModel,
      team_size: teamSize,
    },
    data_gaps: dataGaps,
  };
}

module.exports = { assemble, assembleTechStack, assembleBusinessModel, assembleTeamSize, assembleRedBlue };
