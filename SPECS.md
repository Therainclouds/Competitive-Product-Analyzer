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
  evidence: Evidence[],        // 全报告证据池（可溯源）
  disclaimer: string
}

TechItem = { name, version?, confidence, evidence: EvidenceRef[] }
Evidence = { id, source, kind, detail, url?, fetched_at }
EvidenceRef = { evidenceId }
PriceHint = { plan?, price?, period?, raw }
TeamSignal = { source, raw, estimate_range?, weight }
```

## 三、数据模型核心：evidence 对象（护城河）

- **每条结论必须能回溯到 ≥1 条 evidence**（来源 + 细节 + 抓取时间）
- 展示层允许用户点开证据详情（第一版 JSON 里即可见，Markdown 里列出）
- 证据不足 → 该维度标 `data_sufficient: false` + 进 `data_gaps`，**不编数字**

## 四、置信度建模（第一版简化规则，展示公式用）

```
置信度 = 信号数量 × 来源权重 × 时效因子（第一版时效恒为 1）

来源权重：headers=1.0, html=0.9, js_paths=0.8, dns=0.8,
          pricing_page=1.0, pricing_signal=0.9, paywall=0.7,
          payment_fingerprint=0.6（已知 SSR 盲区）, github=0.8, careers=0.5

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
| tech_stack | 响应头/DNS/HTML/JS 路径 | 复用 `probes/tech_stack`（零依赖正则层；wappalyzer-core 引擎列为 v1.1） | ✅ 真实 UA |
| business_model | 定价页 /pricing /plans | 复用 `probes/pricing`（定价页发现 + 支付指纹 + 付费墙 + 定价信号） | ✅ 不绕验证码 |
| team_size | GitHub API（org 成员数） | `https://api.github.com/orgs/{org}`（免费 60req/h，无需 key） | ✅ 官方 API |
| team_size | 招聘页 /careers /jobs /about | 抓取 + 岗位关键词计数 | ✅ 公开页面 |
| team_size | OpenCorporates（v1.1 可选） | API（免费 200req/月） | ✅ 开放数据 |

**GitHub org 推断**：从 URL 域名 → 猜 org 名（如 linear.app → linearapp/linear）→ 探测 GitHub org 存在性；失败则记 evidence「org 未找到」不算缺陷。

## 六、推理层

- 技术栈 → 直接透传采集结果 + 去重 + 多源置信度提升
- 商业模式 → 规则引擎（复用 pricing_probe 的 monetization_guess 逻辑，输出到契约）
- 团队规模 → **区间投票**：
  - GitHub public members（若 org 存在）→ 区间 [members, members×1.5]
  - 招聘页岗位数 n → 经验系数区间 [n×2.5, n×6]（v0.1 同款推断：8 岗 → 15-25 人）
  - 多源区间取并集 → 输出 [min, max]；只有单源 → 输出该源区间 + low
  - 无任何源 → data_sufficient=false

## 七、呈现层（第一版）

- `report.json`：完整结构化数据（机器可读）
- `report.md`：人类可读 Markdown（三件套 + 证据链列表 + 数据不足标注 + 免责声明）
- 命令行：`node xray.js <url> --out ./reports/`

## 八、验收标准（第一版测试）

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

## 九、技术栈

- Node.js（零依赖实现，复用 probes/；已有共享 http.js 带重试）
- 无需 LLM 即可出第一版（规则引擎）；LLM 精修列为 v1.1（A-MINT schema + 置信度校准）

## 十、目录结构

```
xray/
├── xray.js            # CLI 入口
├── lib/
│   ├── evidence.js    # evidence 池 + 引用
│   ├── confidence.js  # 置信度计算
│   ├── collect/
│   │   ├── tech.js    # 技术栈（调 probes 逻辑）
│   │   ├── pricing.js # 商业模式（调 probes 逻辑）
│   │   └── team.js    # 团队规模（GitHub + 招聘页）
│   ├── reason/
│   │   └── assemble.js# 三件套组装 + 数据不足判断
│   └── render/
│       ├── json.js    # report.json
│       └── md.js      # report.md
├── reports/           # 输出
└── SPECS.md（本文件）
```
