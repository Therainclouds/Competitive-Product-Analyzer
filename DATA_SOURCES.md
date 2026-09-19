# 竞品解剖器 · 数据来源与真实性分析

> 用途：回答「竞品解剖器到底是从哪里分析出真实资料的」——每个维度查了什么、没查什么、为什么，以及可信度分层。
> 版本：v1.8（OpenCorporates 免费 API 被拒后的替代源体系：Companies House + SEC 10-K 员工数硬数据）

---

## 一、一句话总览

**解剖器不查询专利信息，不查学术论文，不靠「感觉」**。它的资料全部来自**公开可访问的信息**，按「官方一手 > 第三方聚合 > 推断信号」三层组织，且每一条输出都带 evidence（来源 + 细节 + 抓取时间）可回溯。

```
你输入竞品 URL
   ↓
三层采集（全部公开、合规）
   ├─ 第一层：产品官网本身（最核心）
   │    响应头 / HTML / JS 路径 / DNS → 技术栈
   │    定价页 /pricing /plans → 商业模式
   │    招聘页 /careers → 团队规模（弱信号）
   ├─ 第二层：官方 API（公司自身公开数据）
   │    GitHub API → org 规模 / 仓库数量
   │    SEC EDGAR → 上市公司财报（若有）
   ├─ 第三层：第三方聚合（商业数据，需 key）
   │    OpenCorporates → 注册信息/成立年
   │    Crunchbase → 员工区间/融资/成立年
   └─ 第四层：公开新闻（辅助信号）
        Google News RSS → 融资/新闻标题
   ↓
每条结论 = 证据链（evidence 对象）+ 置信度
查不到 = 明确标「数据不足」，不编数字
```

---

## 二、逐维度：到底查了什么？

### 维度 1：技术栈识别（置信度高）

**v1.7 起由 webappalyzer 规则引擎驱动**（社区规则源 enthec/webappanalyzer，MIT，7600+ 应用快照在 `rules/webappanalyzer/`，`node scripts/update_rules.js` 刷新）+ **自维护增量规则**（`rules/incremental/`，收录标准：语义明确的事实信号，宁缺毋滥）。替代了 v1.1 的手写零散正则（P3 误报根因）。

| 检测通道 | 查什么 | 规则数 | 实测 |
|---|---|---|---|
| scriptSrc（JS 路径指纹） | 脚本 src 匹配规则 pattern | 3881 | ✅ 主通道 |
| headers（响应头） | 专有头/值 pattern | 666 | ✅ |
| cookies / meta / url / dns(TXT) | NEXT_LOCALE、generator 等 | 372/755/85/137 | ✅ |
| html（页面标记） | 框架专属标记 | 345 | ✅ |
| DNS CNAME（自维护补充） | CDN 判断（规则源无此通道） | 7 | ✅ 与 TXT 互补 |
| implies / requires / excludes | 传递推断 + 前提校验 + 互斥剔除 | 1010 | ✅ |

**已知差距（诚实声明）**：规则的 `js`（浏览器全局变量）、`dom`（运行时 DOM 特征）、`scripts`（bundle 内容）、`xhr` 四个通道需要浏览器或 JS bundle 抓取，静态管线不实现。影响：纯 CSR 应用的 React/Vue 只能靠 implies 链带出（如 Next.js→React）；webpack 类需 bundle 内容确认 → 列入打磨清单 item 8。

**误报治理效果**：figma.com 实测——旧引擎报 Vue.js/Angular（`id="app"` 巧合命中），新引擎 0 误报，且独立复现旧引擎的正确结论（Next.js/Netlify），新增 Sanity CMS、Amazon CloudFront 等一手证据支撑项。五站对比全部通过。

### 维度 2：商业模式判断（置信度中高）

| 数据源 | 具体查什么 | 一手/二手 | 实测 |
|---|---|---|---|
| **产品官网 · 定价页** `/pricing` `/plans` | 页面存在性 + 套餐名（Free/Pro/Business/Enterprise）+ 价格 + 周期 + 免费额度 | 一手 | 4/4 站命中 |
| **产品官网 · 付费墙信号** | "Start free trial"、"Login to view"、免费额度 CTA、企业询价 | 一手 | 3/4 站 |
| **产品官网 · 支付痕迹** | 页面 JS 里的 Stripe/Paddle/RevenueCat 特征 | 一手 | ⚠️ 0/4（SSR 盲区） |
| **融资信息**（v1.1 部分实现） | Google News RSS 搜「公司名 + funding/raised/valuation」 | 二手（新闻） | 待验证 |

**回答你的问题**：商业模式**主要来自产品官网的定价页**（套餐/价格是公司自己公布的一手信息），辅以付费墙信号。**融资情况**（Crunchbase）是 v1.1 新增但需要 key；**学术论文完全不查**（SaaS 公司很少用论文揭示商业模式）。

### 维度 3：团队规模估算（置信度低，明示）

| 数据源 | 具体查什么 | 一手/二手 | 实测 |
|---|---|---|---|
| **SEC EDGAR · 10-K 员工数**（v1.8 硬数据） | company_tickers.json 定位 CIK → 最近 10-K 抽 "approximately/had N employees" | 一手（官方年报） | ✅ Salesforce 83,334（filing 2026-03-02）实测命中，区间 [75000, 108335] 主导输出、置信度升 medium |
| **UK Companies House**（v1.8，免费 key） | 注册状态/成立年/账户类型——micro-entity（法定 ≤10 人）/small company（法定 ≤50 人）是**法定规模上限**，可裁剪区间 max | 一手（官方注册库） | ⏸ 接口就绪待 key（免费注册即发） |
| **GitHub API** | org 是否存在、public_repos 数、public_members 数 | 一手（官方 API） | 稳定 |
| **产品官网 · 招聘页** | 岗位块数（"Senior Engineer" 等标题计数） | 一手 | 命中但低估（弱信号，硬数据出现时仅作旁证） |
| **theorg.com** | 公开组织档案员工数 + 多源联合校准 | 二手聚合 | 已启用（v1.2.2） |
| **Crunchbase** | ~~Basic 免费档~~ ⚠️ **2025 起免费 API 已取消**（最低约 $49/月 Pro） | 二手聚合 | ⏸ 接口保留，是否订阅待定 |
| ~~OpenCorporates~~ | ~~注册信息/成立年~~ | — | ❌ **2026-09 免费 API 申请被拒**，角色由 Companies House + SEC 接替，代码已移除 |

**回答你的问题**：团队规模 v1.8 起**上市公司有硬数据**（SEC 10-K 一手年报，区间主导 + medium 置信）；非上市公司靠 GitHub/招聘页/theorg 弱推断（低置信 + 区间 + caveat）；UK 注册公司可加 Companies House 法定上限裁剪（注册 key 即启用）。**不查专利**。

---

## 三、你提到的几个来源：查不查？为什么？

| 来源 | 是否查询 | 原因 |
|---|---|---|
| **专利信息** | ❌ 不查（v1.x） | ① 专利检索（USPTO/Google Patents）返回的是法律文书，需要解析权利要求/引文，工程量大；② 专利数量与「技术栈/商业模式/团队规模」三件套相关性弱——大部分 SaaS 公司不公开专利组合；③ 隐私合规风险低但价值低。**留 v2+ 可选维度**（若做「技术护城河分析」可加） |
| **学术论文** | ❌ 不查 | ① 学术论文揭示的是研究能力（AI 公司可能相关），但不是三件套的信号；② 论文数据库（Semantic Scholar/arXiv）对 SaaS 公司覆盖极低。**仅对 AI 技术型公司（如 Anthropic）有意义**，可作 v2 的「技术深度」维度 |
| **产品官网** | ✅ **核心来源** | 公司自己公布的一手信息：定价、技术、招聘——可信度最高，无合规风险 |
| **融资情况** | 🟡 部分查 | Crunchbase（需 key，v1.1 已实现未启用）+ Google News RSS（免费，已实现）。融资额/估值是「商业模式」和「公司规模」的佐证，但**不是三件套的必要条件**——查不到就标数据不足 |
| **招聘信息** | ✅ 查 | 招聘页岗位数 + GitHub org，团队规模的免费信号（有低估局限，已加 caveat） |
| **财务数据** | 🟡 仅上市公司 | SEC EDGAR 免费可查（10-K/10-Q 员工数），私有公司查不到——所以私有大公司团队规模必然低估，靠 caveat 兜底 |

---

## 四、可信度分层（用户该怎么信）

```
一手官方数据（官网/官方 API）      ★★★★  技术栈、定价、SEC
第三方聚合（Crunchbase/OpenCorp） ★★★   员工区间、成立年（需 key）
推断信号（招聘页岗位数→规模）      ★★    团队规模（低置信度，明示）
搜索/新闻（Google News）          ★★    融资标题（辅助）
未查到                            —      明示「数据不足」，不编数字
```

**核心信任设计**：每条输出带 evidence（可点击回溯到来源 URL + 抓取时间）；查不到就直说「数据不足」——这是产品定位里的信任护城河，不是缺陷。

---

## 五、当前局限（诚实清单）

1. **私有小公司团队规模仍是弱推断**（招聘页岗位数低估）——上市公司已由 SEC 10-K 硬数据解决（v1.8）；非上市免费源查不到，半人半机人工补或等 Companies House key 覆盖 UK
2. **支付指纹在 SSR 定价页不可见**（0/4 命中）——v1.7 已加 JS bundle 补采通道
3. ~~零依赖正则的误报~~ ✅ **v1.7 已解决**（规则引擎 + 增量规则，figma 实测 Vue/Angular 误报消除）
4. **融资/新闻信号尚未验证**（Google News RSS 刚接入）
5. **专利/学术论文维度未做**——设计上排除，非缺陷
6. **Wikidata P1128 员工数**——调研后弃用：P856 官网反查对新兴 SaaS 覆盖空缺（linear/figma/notion 实测无条目），名称搜索有同名歧义，不符合证据质量红线

---

## 六、配置 key 后能增强什么

```bash
# Windows PowerShell（临时设置，仅当前窗口生效）
$env:OPEN_CORPORATES_KEY = "你的key"   # https://opencorporates.com 免费注册
$env:CRUNCHBASE_KEY    = "你的key"   # https://www.crunchbase.com 免费 Basic 档
```

| Key | 增强 |
|---|---|
| OPEN_CORPORATES_KEY | 团队规模+成立年+法律形态（免费 200 req/月） |
| CRUNCHBASE_KEY | 员工区间（101-250 等）+ 融资 + 成立年（Basic 免费档） |
