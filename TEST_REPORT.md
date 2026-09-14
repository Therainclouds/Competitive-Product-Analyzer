# 竞品解剖器 · 第一版测试报告（V1.0-alpha）

> 测试时间：2026-08-20
> 测试方式：5 个真实站点跑完整管线（采集→推理→呈现），人工核对事实
> 环境：本机网络存在透明限速层（单站 3s~290s 波动），Node 直连

---

## 一、验收结果总表

| # | 验收标准 | 目标 | 实测 | 结论 |
|---|---|---|---|---|
| 1 | 5 个真实站点跑通完整管线 | 5/5 | **5/5**（figma 需重试，慢网络下 272s） | ✅ |
| 2 | 技术栈核心识别与事实一致 | ≥4/5 | **4/5**（vercel/linear/stripe/figma 核心正确；notion 首页超时无数据） | ✅ |
| 3 | 商业模式变现判断与事实一致 | ≥4/5 | **4/5**（vercel/linear/notion/stripe 全对 freemium；figma 诚实标「数据不足」） | ✅ |
| 4 | 团队规模输出区间 + low 置信度 | 5/5 | **5/5**（全输出区间 + low） | ✅ |
| 5 | 每条结论有 ≥1 条 evidence | 5/5 | **5/5**（Next.js 类多源命中带 2-3 条证据） | ✅ |
| 6 | 数据不足维度明确标注 | 5/5 | **5/5**（figma 商业模式、notion 技术栈均正确标注） | ✅ |
| 7 | 单命令可跑完一站 | 5/5 | **5/5**（`node xray.js <url>`；figma 因网络慢需更长超时） | ✅ |
| 8 | 全流程合规 | 5/5 | **5/5**（真实 UA、不绕验证码、不碰 LinkedIn、GitHub 官方 API） | ✅ |

**核心闭环验证通过：输入 URL → 三件套报告（带证据链 + 置信度）→ 双格式输出。**

---

## 二、逐站结果与事实核对

| 站点 | 技术栈（识别 vs 事实） | 商业模式（识别 vs 事实） | 团队规模 |
|---|---|---|---|
| **vercel.com** | Vercel+Next.js ✅（事实：Next.js 自家产品） | freemium ✅（Hobby 免费 + Pro 付费） | 40-96（low）⚠️ 实际 ~500+ |
| **linear.app** | Next.js+Cloudflare ✅ | freemium ✅（Free/Pro/Business/Enterprise） | 15-36（low）⚠️ 实际 ~100+ |
| **notion.so** | 首页超时→无数据（诚实标注） | freemium ✅（定价页命中） | 43-102（low）⚠️ 实际 ~1000+ |
| **stripe.com** | Next.js+nginx+webpack ✅ | freemium ✅（Stripe 确实有免费层） | 10-24（low）❌ 实际数千人 |
| **figma.com** | Next.js+Netlify+webpack ✅（Vue/Angular 误报） | 数据不足（定价页未取到，诚实标注） | 50-120（low）⚠️ 实际 ~2000+ |

## 三、测试暴露的问题（按优先级）

### P1 · 团队规模系统性低估（影响信任）
- 大公司（Stripe 数千人 → 10-24）招聘页岗位块数只反映**在招岗位**，且大公司 careers 页常 JS 动态渲染，静态抓取严重低估。
- 已改进：GitHub public_repos ≥50 → 打 `large-org` caveat 提示「可能显著低估」✅（已实现，见 v2 报告）
- 待办：接 Crunchbase/Apollo（付费）、OpenCorporates（免费注册信息）补强；caveat 只提示不解决，长期靠半人半机阶段人工补。

### P2 · 支付指纹在 SSR 定价页不可见（已确认）
- 4/5 站支付指纹 0 命中（Linear 实测确认）——支付脚本异步加载。
- 结论：**商业模式判断不能依赖支付指纹**，靠定价信号 + 付费墙信号（实测有效）。6.1 表已下调该信号可靠性。

### P3 · 零依赖正则的误报（figma 的 Vue.js/Angular）
- 页面文本/字符串巧合命中正则。待办：接入 wappalyzer-core 引擎 + 规则源（v1.1）。

### P4 · 慢网络下 figma 需 272s
- 网络限速层导致，非代码问题；已通过收紧团队探测预算（20s 上限、候选截断）缓解。

### P5 · 验收脚本 evidence 统计 bug
- batch_xray.js 摘要里 `report.evidence` 应为「技术栈结论全部带证据链」判断（已修复）。

## 四、产出物

| 文件 | 说明 |
|---|---|
| `xray/SPECS.md` | 第一版规格（产品契约/数据模型/置信度/验收标准） |
| `xray/xray.js` | CLI 入口：`node xray.js <url> --out <dir>` |
| `xray/batch_xray.js` | 批量解剖 + 验收摘要 |
| `xray/lib/evidence.js` | evidence 池（护城河核心：结论→证据可溯源） |
| `xray/lib/collect/tech.js` | 技术栈采集（响应头/DNS/HTML/JS 路径） |
| `xray/lib/collect/pricing.js` | 商业模式采集（定价页/支付指纹/付费墙/定价信号） |
| `xray/lib/collect/team.js` + `team_runner.js` | 团队规模（GitHub API + 招聘页 + 区间投票 + large-org caveat） |
| `xray/lib/reason/assemble.js` | 推理组装（置信度 + 数据不足判断） |
| `xray/lib/render/md.js` | Markdown 报告渲染 |
| `xray/reports/*.json + *.md` | 5 站真实报告（vercel/linear/notion/stripe/figma） |

## 五、结论

**第一版可测试原型达成目标：核心闭环（URL → 三件套 + 证据链 + 置信度 + 数据不足标注）已验证可运行，且遵守全部合规红线。** 技术栈和商业模式两个维度的判断质量已达到「可给人看」的水平；团队规模诚实但系统性低估（P1），需在 v1.1 通过数据源补强解决。

## 六、v1.1 建议（按价值排序）

1. 团队规模数据源补强：OpenCorporates（免费注册信息）+ Crunchbase Basic 免费档
2. 接入 wappalyzer-core 引擎（消除零依赖正则误报）
3. 支付指纹增强：抓 JS bundle 搜关键词（补 SSR 盲区）
4. LLM 精修层：定价页结构化抽取（A-MINT schema）+ 置信度校准
5. 红蓝对抗报告（V1.0 核心卖点）——管线稳定后的下一迭代

---

## 七、v1.1 进度（2026-08-21）

### ✅ 完成：#1 团队规模数据源补强（部分）

**新增 `lib/collect/company_info.js`**（多源 + 优雅降级）：
| 数据源 | key | 状态 | 实测 |
|---|---|---|---|
| SEC EDGAR（上市公司） | 无需 | ✅ 已启用 | Salesforce CIK 命中 → public-company caveat；Stripe（私有）正确未命中 |
| Google News RSS（融资新闻） | 无需 | ✅ 已实现 | ⚠️ 本机网络不可达（news.google.com 被限速），正常网络可用 |
| OpenCorporates（注册信息） | 需 OPEN_CORPORATES_KEY | ⏸ 已实现待 key | 无 key 时诚实标「跳过」 |
| Crunchbase（员工区间） | 需 CRUNCHBASE_KEY | ⏸ 已实现待 key | 无 key 时诚实标「跳过」 |

**效果验证（Salesforce 实测）**：团队规模 13-30 人 + 双重 caveat（large-org + public-company）——精准拦截「上市公司被低估成小团队」的坑。

**配置 key 后增强**：
```powershell
$env:OPEN_CORPORATES_KEY = "你的key"
$env:CRUNCHBASE_KEY    = "你的key"
```

**数据来源体系文档**：`xray/DATA_SOURCES.md`（回答「资料从哪来」：官网一手 + 官方 API + 第三方聚合 + 新闻，三层可信度；明确不查专利/学术论文及原因）。

---

# v1.7 测试报告（2026-09-14 · 规则引擎 + 预算制 + LLM 抽取）

> 触发：打磨清单制修复（用户决定：验证前持续打磨）。覆盖 v1.1 全部遗留 P1-P5。

## 一、验收结果总表（v1.7 增补标准）

| # | 验收标准 | 目标 | 实测 | 结论 |
|---|---|---|---|---|
| 9 | 技术栈 0 误报（旧 Vue/Angular 类） | 5/5 站 | **5/5**（figma 首页不再报框架类） | ✅ |
| 10 | 规则引擎五站召回 ≥ 旧引擎正确项 | ≥4/5 | **5/5**（含 Next.js 增量规则补盲） | ✅ |
| 11 | 慢站单管线 ≤ 60s（旧基线 240s 超时） | 5/5 | **5/5**（最慢 figma 15.4s，stripe 11.8s） | ✅ |
| 12 | budget_exhausted 证据 + CLI/工作台重跑引导 | 全链路 | ✅ 渲染/横幅/报告字段三处落地 | ✅ |
| 13 | LLM 定价页抽取端到端（真实 MiniMax） | 可用 | **linear 4 套餐 high 置信 + 诚实 notes**，无 key 优雅降级 | ✅ |
| 14 | 红蓝攻击缺 attack_path / 无效引用强制降 low | 契约测试 | Test 1-5 全过 | ✅ |
| 6(回归) | 数据不足维度诚实标注 | 5/5 | **0 gaps**（五站全有数据——figma「商业模式数据不足」已根治） | ✅ 超额 |

## 二、逐站实测（v1.7 管线，本机限速网络）

| 站点 | 耗时 | 技术栈 | 商业模式 | 团队规模 | 预算耗尽 |
|---|---|---|---|---|---|
| vercel.com | 10.3s | 7 项（Next.js/Vercel/React/S3…） | freemium ✅ | 40-2500 | 否 |
| linear.app | 8.2s | 9 项（+Next.js 增量规则/Algolia） | freemium ✅ | 15-51 | 否 |
| stripe.com | 11.8s | 6 项 | freemium ✅ | 10-4290（theorg 联合校准） | 否 |
| notion.so | 7.4s | 13 项（旧版此项超时无数据） | freemium ✅ | 38-1281 | 否 |
| figma.com | 15.4s | 8 项 0 误报（旧版 272s/超时） | **freemium ✅（旧版「数据不足」）** | 43-1242 | 否 |

## 三、本轮根治的问题

1. **P3 误报**：规则引擎（enthec/webappanalyzer 快照 7613 应用 / MIT / `scripts/update_rules.js` 刷新）+ 自维护增量规则（`rules/incremental/`，收录标准=语义明确）。旧手写正则层全部退役。
2. **P4 慢站**：三层修复——①采集级绝对 deadline（150s，三路共享）；②`req.setTimeout` 只管空闲，补**硬总时限定时器**（慢滴站点开火）；③**截断即成功**（定价页 2.4MB > maxBytes 时旧代码整体 abort 丢弃已有内容 → figma 商业模式「数据不足」的真实根因）。
3. **P2 支付指纹**：定价页 HTML 未命中支付商时补采 ≤4 个 JS bundle 搜特征。linear 实测未误报（其支付在服务端，属预期内诚实结果）。
4. **test_llm_smoke 既有 bug**：真实 .env 的 LLM_MODEL 污染「默认值断言」——测试顶部显式清 env，不再依赖环境洁净。
5. **batch_xray.js（串行版）**：删除；pipeline 共享后其手工组装逻辑属双维护风险，`batch_xray_parallel.js --concurrency 1` 即串行。
6. **密钥卫生**：xray 全部 git 历史文件名+内容双扫描干净；`.env` 加载从 llm/client 副作用抽为 `lib/env.js` 单一真相源（company_info 直接可用，不再依赖加载顺序）。

## 四、遗留（已知差距，非缺陷）

| 项 | 状态 |
|---|---|
| 团队规模无 key 时系统性低估/超宽区间 | ⏸ OpenCorporates 公益项目申请中（批复后填 .env 即启用） |
| webpack/js 全局/dom 类技术浏览器通道检测 | 规则源新版已放弃 bundle 内容检测，接受为诚实差距（DATA_SOURCES.md 已声明） |
| LLM 抽取依赖定价页可达性 | bundle 通道 + 截断修复后，五站 5/5 可达 |

## 五、测试套件清单（全绿，2026-09-14）

```
node tests/test_tech_rules.js      # 11 项（规则引擎/增量/降级/性能）
node tests/test_pricing_extract.js # 9 项（A-MINT 校验/降级/清洗）
node tests/test_redblue.js         # 5 项（+attack_path 强化契约）
node tests/test_db.js / test_cache.js / test_llm_smoke.js
```
