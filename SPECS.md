# 竞品解剖器（Competitor X-Ray）· 第一版 SPECS（V1.0-alpha）

> 依据：v2.0 计划 + 审查意见（22 点）+ 开源调研（4 份报告）+ 全球性定位修正（已执行）
> 状态：第一版可测试原型 ✅ 已实现并通过 5 站真实测试（见 TEST_REPORT.md）
> 原则：**只做能验证「用户会不会为它掏钱」的最小闭环**，不做完美产品

---

## 一、产品定义

**一句话**：输入一个竞品网站 URL，输出「技术栈 + 商业模式 + 团队规模」三件事的判断，每条带**证据链 + 置信度**；数据不足就直说，绝不编数字。

**第一版明确不做**（对应审查意见）：
- ❌ 红蓝对抗报告（V1.0 核心卖点，但第一版先验证三件套管线，红蓝对抗下个迭代）
- ❌ 开发成本估算 / 公司寿命预测 / 国内公司画像
- ❌ 竞品监控订阅 / 想法查重
- ❌ 登录/支付系统（第一版用命令行跑，验证期再用 Stripe Payment Links）
- ❌ 多语言 UI（第一版英文输出，中文注释代码）

## 二、输入输出契约

```
输入: URL（如 https://linear.app）
输出: 解剖报告（JSON + Markdown 双格式）

Report = {
  target: string,              // 输入 URL
  company: string,             // 归一化公司名（域名推断）
  generated_at: ISO8601,
  pillars: {
    tech_stack: {              // 技术栈识别（期望置信度：高）
      items: TechItem[],
      confidence: high|medium|low,
      data_sufficient: bool,
      summary: string
    },
    business_model: {          // 商业模式判断（期望置信度：中高）
      monetization: string,    // subscription|freemium|usage-based+subscription|enterprise-quote|ad-supported|free-product|unknown
      pricing_hints: PriceHint[],  // 定价信号（套餐/价格/周期）
      confidence: high|medium|low,
      data_sufficient: bool,
      summary: string
    },
    team_size: {               // 团队规模估算（期望置信度：低，明示）
      range: [min, max] | null,
      signals: TeamSignal[],   // 各来源区间
      confidence: low,
      data_sufficient: bool,
      summary: string
    }
  },
  data_gaps: string[],         // 明确「数据不足」的维度
  budget_exhausted: bool,      // v1.7：部分探测因网络预算耗尽未完成（≠ 数据不足，可重跑补全）
  evidence: Evidence[],        // 全报告证据池（可溯源）
  disclaimer: string
}

TechItem = { name, version?, confidence, evidence: EvidenceRef[] }
Evidence = { id, source, kind, detail, url?, fetched_at }
EvidenceRef = { evidenceId }
PriceHint = { plan?, price?, period?, raw }
TeamSignal = { source, raw, estimate_range?, weight }
// v1.7 business_model 扩展字段：
//   pricing_page: string | null
//   providers: [{ provider, confidence, via?: 'bundle' }]  // 支付指纹（HTML 层 + bundle 补采层）
//   llm_extract: {                                        // LLM 定价页结构化抽取（无 key 时 null）
//     plans: [{ name, price, currency, period, quota, key_features[] }],
//     monetization_primary, monetization_secondary[],
//     rule_monetization,  // 与规则引擎判断不一致时的原值（high 置信时 LLM 覆盖）
//     confidence, notes }
```

## 三、数据模型核心：evidence 对象（护城河）

- **每条结论必须能回溯到 ≥1 条 evidence**（来源 + 细节 + 抓取时间）
- 展示层允许用户点开证据详情（第一版 JSON 里即可见，Markdown 里列出）
- 证据不足 → 该维度标 `data_sufficient: false` + 进 `data_gaps`，**不编数字**

## 四、置信度建模（第一版简化规则，展示公式用）

```
置信度 = 信号数量 × 来源权重 × 时效因子（第一版时效恒为 1）

来源权重：headers=1.0, html=0.9, js_paths=0.8, dns=0.8,
          cookies=0.9, meta=0.9, url=0.6, implies=0.5,   ← v1.7 规则引擎通道
          pricing_page=1.0, pricing_signal=0.9, paywall=0.7,
          payment_fingerprint=0.6（SSR 盲区；v1.7 起 bundle 补采提升命中）,
          github=0.8, careers=0.5, company_info=0.8,
          llm_redblue=0.7, llm_pricing=0.7                ← LLM 层（可回原文核对）

分级（按维度累计加权分）：
  high   ≥ 2.0 且至少 2 个独立来源
  medium ≥ 1.0
  low    < 1.0
```

**各维度判定规则**：
- 技术栈：每条技术 = 命中的信号源数；多源命中 → high
- 商业模式：定价页存在 + 定价信号数 + 付费墙信号 → 综合；支付指纹命中加分但已知盲区
- 团队规模：GitHub org 成员 + 招聘页岗位数 + OpenCorporates（若可用）区间投票，**一律 low 置信度 + 区间输出**

## 五、采集层模块（复用 probes/ + 新增团队规模）

| 模块 | 数据源 | 方法 | 合规 |
|---|---|---|---|
| tech_stack | webappalyzer 社区规则源（v1.7）+ 自维护增量规则 | `lib/tech/detect.js` 规则引擎（scriptSrc/headers/cookies/meta/html/url/dns 静态通道 + implies/requires/excludes）；快照 `rules/webappanalyzer/`（enthec/webappanalyzer@main，MIT），刷新 `node scripts/update_rules.js`；增量 `rules/incremental/`（收录标准：语义明确，宁缺毋滥） | ✅ 真实 UA |
| tech_stack | DNS CNAME 判断 CDN | 规则源无 CNAME 通道，保留自实现补充 | ✅ |
| business_model | 定价页 /pricing /plans | 复用 `probes/pricing`（定价页发现 + 支付指纹 + 付费墙 + 定价信号）；v1.7：HTML 未命中支付商时补采 ≤4 个 JS bundle 搜支付特征（P2 盲区）；v1.7：LLM 结构化抽取（A-MINT schema，`lib/llm/pricing_extract.js`，未配 key 自动跳过） | ✅ 不绕验证码 |
| team_size | GitHub API（org 成员数） | `https://api.github.com/orgs/{org}`（免费 60req/h，无需 key） | ✅ 官方 API |
| team_size | 招聘页 /careers /jobs /about | 抓取 + 岗位关键词计数 | ✅ 公开页面 |
| team_size | OpenCorporates（公益项目申请中） | API（配 `OPEN_CORPORATES_KEY` 即启用，未配置自动跳过并记入证据） | ✅ 开放数据 |

**GitHub org 推断**：从 URL 域名 → 猜 org 名（如 linear.app → linearapp/linear）→ 探测 GitHub org 存在性；失败则记 evidence「org 未找到」不算缺陷。

## 六、推理层

- 技术栈 → 直接透传采集结果 + 去重 + 多源置信度提升
- 商业模式 → 规则引擎（复用 pricing_probe 的 monetization_guess 逻辑，输出到契约）；v1.7 LLM 结构化抽取接入规则层：LLM `confidence=high` 且与规则不一致时覆盖 monetization（规则原值留痕 `llm_extract.rule_monetization`）；规则为 unknown 且 LLM 非 low 时采纳 LLM
- 团队规模 → **区间投票**：
  - GitHub public members（若 org 存在）→ 区间 [members, members×1.5]
  - 招聘页岗位数 n → 经验系数区间 [n×2.5, n×6]（v0.1 同款推断：8 岗 → 15-25 人）
  - 多源区间取并集 → 输出 [min, max]；只有单源 → 输出该源区间 + low
  - 无任何源 → data_sufficient=false
- **红蓝对抗（v1.7 强化验收）**：LLM 攻击输出经 `evidenceCheck` 双重校验——引用不存在的 evidence ID → 剔除引用并降 low；`attack_path` 缺失或 <20 字（套话）→ 强制降 low 并记 note

## 七、呈现层（第一版）

- `report.json`：完整结构化数据（机器可读）
- `report.md`：人类可读 Markdown（三件套 + 证据链列表 + 数据不足标注 + 免责声明；v1.7 起含 LLM 套餐表、budget 重跑引导）
- 命令行：`node xray.js <url> --out ./reports/`

## 八、验收标准

### 第一版（v1.0，2026-08-20 实测通过，见 TEST_REPORT.md）

| # | 标准 | 目标 |
|---|---|---|
| 1 | 对 5 个真实站点（Vercel/Linear/Notion/Figma/Stripe）跑通完整管线 | 5/5 |
| 2 | 技术栈核心识别与事实一致（人工核对） | ≥4/5 站 |
| 3 | 商业模式变现判断与事实一致 | ≥4/5 站 |
| 4 | 团队规模输出区间 + low 置信度（不追求准确，追求诚实） | 5/5 |
| 5 | 每条结论有 ≥1 条 evidence | 5/5 |
| 6 | 数据不足维度明确标注（不编数字） | 5/5 |
| 7 | 单命令可跑完一站（含重试，网络波动容忍） | 5/5 |
| 8 | 全流程合规：真实 UA、不绕验证码、不碰 LinkedIn | 5/5 |

### v1.7 增补（2026-09-14 实测通过，详见 TEST_REPORT.md v1.7 节）

| # | 标准 | 实测 |
|---|---|---|
| 9 | 技术栈 0 误报（旧 P3 类：id="app"→Vue、字符串巧合→Angular） | ✅ 五站 0 误报 |
| 10 | 社区规则快照 + 自维护增量规则 + 刷新脚本进仓库（运行时零网络） | ✅ rules/ + scripts/update_rules.js |
| 11 | 慢站单管线 ≤ 60s 完成（含慢网重试；旧基线 240s 超时） | ✅ figma 15.4s / 最慢站 11.8s |
| 12 | 预算耗尽 ≠ 数据不足：budget_exhausted 证据 + CLI/工作台重跑引导 | ✅ |
| 13 | 定价页 LLM 结构化抽取：真实 LLM 端到端出套餐表，无 key/失败自动降级不伤主报告 | ✅ linear 4 套餐 high |
| 14 | 红蓝对抗：无效 evidence 引用降级 + 无攻击路径降级（契约测试覆盖） | ✅ test_redblue Test 5 |

## 九、技术栈

- Node.js ≥ 24（零依赖；`node:sqlite` 持久化 + 内置 fetch/dns/https）
- 无需 LLM 即可出完整三件套报告（规则引擎）；LLM 层 v1.7 启用：定价页 A-MINT 结构化抽取 + 红蓝对抗 + 竞品发现（无 key 全部优雅跳过）
- 技术栈识别：webappalyzer 社区规则源（enthec/webappanalyzer，MIT）+ 自维护增量规则，浏览器通道（js/dom/bundle 内容）为已知差距

## 十、目录结构

见 README.md「目录结构」节（v1.7 起以 README 为单一维护版本，避免两处漂移）。
