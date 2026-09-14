/**
 * 呈现层（SPECS 第七节）：Markdown 报告渲染
 * ------------------------------------------------------------
 * 输出人类可读报告：三件套 + 证据链 + 数据不足标注 + 免责声明。
 */

/** 单元格转义：防 | 破坏表格、防超长 */
function escapeCell(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 160);
}

function renderMarkdown(report, evidencePool) {
  const L = [];
  const { pillars, data_gaps, company, target, generated_at } = report;

  L.push(`# 竞品解剖报告：${company}`);
  L.push('');
  L.push(`> 目标：\`${target}\``);
  L.push(`> 生成时间：${generated_at}`);
  L.push(`> ⚠️ 本报告基于公开信息推断，仅供参考，不构成任何商业决策依据。`);
  L.push('');

  // 数据不足总览（v1.7：区分「公开数据没有」与「网络没来得及查」）
  if (data_gaps.length > 0) {
    L.push(`## ⚠️ 数据不足维度`);
    L.push('');
    L.push(`以下维度公开数据不足，无法给出判断：**${data_gaps.join('、')}**`);
    L.push('');
    if (report.budget_exhausted) {
      L.push(`> 🔁 部分采集因网络预算耗尽未完成（非数据缺失）。网络存在波动，建议 **24 小时内重跑一次**再下「数据不足」结论。`);
      L.push('');
    }
  } else if (report.budget_exhausted) {
    L.push(`> 🔁 本次报告部分探测因网络预算耗尽被跳过（结论已基于可得证据，重跑可补全弱信号维度）。`);
    L.push('');
  }

  // 一、技术栈
  L.push('## 一、技术栈识别');
  L.push('');
  L.push(`**置信度：${pillars.tech_stack.confidence}**`);
  L.push('');
  L.push(pillars.tech_stack.summary);
  L.push('');
  if (pillars.tech_stack.items.length > 0) {
    L.push('| 技术 | 置信度 | 证据 |');
    L.push('|---|---|---|');
    for (const it of pillars.tech_stack.items) {
      const evDesc = it.evidence.map((r) => `[${r.evidenceId}]`).join(' ');
      L.push(`| ${it.name} | ${it.confidence} | ${evDesc} |`);
    }
    L.push('');
  }

  // 二、商业模式
  L.push('## 二、商业模式判断');
  L.push('');
  L.push(`**置信度：${pillars.business_model.confidence}**`);
  L.push('');
  L.push(pillars.business_model.summary);
  L.push('');
  if (pillars.business_model.pricing_page) {
    L.push(`- 定价页：${pillars.business_model.pricing_page}`);
  }
  if (pillars.business_model.pricing_hints.length > 0) {
    L.push('- 定价信号：');
    for (const h of pillars.business_model.pricing_hints) L.push(`  - ${h.raw} (${h.period})`);
  }
  if (pillars.business_model.providers.length > 0) {
    L.push(`- 支付服务痕迹：${pillars.business_model.providers.map((p) => p.provider + (p.via === 'bundle' ? '(bundle)' : '')).join(', ')}`);
  }
  const llmEx = pillars.business_model.llm_extract;
  if (llmEx && llmEx.plans.length > 0) {
    L.push('');
    L.push(`**套餐结构（LLM 从定价页原文抽取，置信 ${llmEx.confidence}）**${llmEx.rule_monetization && llmEx.rule_monetization !== pillars.business_model.monetization ? `　_规则引擎原判 ${llmEx.rule_monetization}，LLM 高置信覆盖为 ${llmEx.monetization_primary}_` : ''}`);
    L.push('');
    L.push('| 套餐 | 价格 | 周期 | 额度/限制 | 关键卖点 |');
    L.push('|---|---|---|---|---|');
    for (const p of llmEx.plans) {
      L.push(`| ${escapeCell(p.name)} | ${p.price ? `${p.price} ${p.currency || ''}`.trim() : '—'} | ${p.period || '—'} | ${escapeCell(p.quota || '—')} | ${escapeCell((p.key_features || []).join('；') || '—')} |`);
    }
    if (llmEx.notes) L.push(`\n> 抽取备注：${llmEx.notes}`);
  }
  L.push('');

  // 三、团队规模
  L.push('## 三、团队规模估算');
  L.push('');
  L.push(`**置信度：${pillars.team_size.confidence}**（团队规模基于公开信号推断，区间仅供参考）`);
  L.push('');
  L.push(pillars.team_size.summary);
  L.push('');
  if (pillars.team_size.signals.length > 0) {
    L.push('| 信号源 | 原始信号 | 估算区间 |');
    L.push('|---|---|---|');
    for (const s of pillars.team_size.signals) {
      L.push(`| ${s.source} | ${s.raw} | ${s.estimate_range ? s.estimate_range.join('-') : '—'} |`);
    }
    L.push('');
  }

  // 四、红蓝对抗（v1.5 · 可选，仅当存在时输出）
  if (pillars.redblue && pillars.redblue.present) {
    L.push('## 四、红蓝对抗（竞品会从哪三个角度打死你）');
    L.push('');
    L.push(`**置信度：${pillars.redblue.confidence}**`);
    L.push('');
    L.push(pillars.redblue.summary);
    L.push('');
    if (pillars.redblue.attacks && pillars.redblue.attacks.length > 0) {
      for (let i = 0; i < pillars.redblue.attacks.length; i++) {
        const atk = pillars.redblue.attacks[i];
        L.push(`### 攻击 ${i + 1}：${atk.angle}（${atk.confidence}）`);
        L.push('');
        if (Array.isArray(atk.evidence) && atk.evidence.length > 0) {
          L.push(`**引用证据**：${atk.evidence.map((id) => `[${id}]`).join(' ')}`);
        } else {
          L.push(`**引用证据**：⚠️ 无有效证据`);
        }
        L.push('');
        if (atk.reasoning) {
          L.push(`**为什么**：${atk.reasoning}`);
          L.push('');
        }
        if (atk.attack_path) {
          L.push(`**攻击路径**：${atk.attack_path}`);
          L.push('');
        }
      }
    }
    if (pillars.redblue.evidence_check && pillars.redblue.evidence_check.notes && pillars.redblue.evidence_check.notes.length > 0) {
      L.push('### 证据回查备注');
      L.push('');
      for (const n of pillars.redblue.evidence_check.notes) L.push(`- ${n}`);
      L.push('');
    }
    if (pillars.redblue.meta && pillars.redblue.meta.error) {
      L.push(`> ⚠️ LLM 调用失败：${pillars.redblue.meta.error.slice(0, 200)}`);
      L.push('');
    }
  }

  // 证据池
  L.push('## 证据池');
  L.push('');
  L.push('> 每条结论可回溯到以下证据（来源 + 细节 + 抓取时间）。');
  L.push('');
  for (const ev of evidencePool.all()) {
    L.push(`- **[${ev.id}]** (${ev.source}) ${ev.kind} — ${ev.detail}${ev.url ? ` \`${ev.url}\`` : ''}（${ev.fetched_at}）`);
  }
  L.push('');
  L.push('---');
  L.push('*免责声明：本报告基于公开可访问信息自动生成，技术栈/商业模式/团队规模均为推断，可能与实际情况存在偏差。请勿将其作为投资或商业决策的唯一依据。*');

  return L.join('\n');
}

module.exports = { renderMarkdown };
