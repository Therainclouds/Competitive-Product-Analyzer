# 竞品解剖器 (Competitor X-Ray)

给一个 URL 或一句话想法，产出一份**带证据链的竞品解剖报告**：技术栈、商业模式、团队规模三件套 + 红蓝对抗推演。零 npm 依赖，纯 Node 标准库实现。

## 特性

- 🔍 **竞品发现**：描述想法或上传 BP 文档，通过 grilling 式多轮澄清（最多 3 轮），收敛出竞品候选清单
- 🧬 **三路采集**：技术栈指纹（webappalyzer 社区规则源 + 自维护增量规则，7600+ 应用）/ 定价与支付信号（含 JS bundle 补采 + LLM 套餐结构化抽取）/ 团队规模推断（GitHub + 招聘页 + theorg + SEC/OpenCorporates/Crunchbase 可选），并行抓取、**共享网络预算**（慢站不再拖死管线）
- ⚔️ **红蓝对抗**：LLM 基于报告内证据推演「竞品会从哪三个角度打死你」，每条攻击强制引用证据 ID + 可验证攻击路径，不合格自动降级
- 🔗 **证据链**：每个结论可回溯到 `ev-N` 证据条目（来源、URL、抓取时间）
- 🎚️ **置信度体系**：所有输出标 high / medium / low；「数据不足」与「预算耗尽没来得及查」语义分离，后者带重跑引导
- 💾 **本地持久化**：Node 24 内置 `node:sqlite`，报告 / 反馈 / 信号源命中率三张表
- 🌓 **半人半机工作台**：报告浏览（筛选 / 排序 / 搜索）、Tab 化详情、人工精修反馈闭环、多版本对比、一键重跑、Markdown 导出

## 快速开始

要求：Node.js ≥ 24（用到内置 `node:sqlite` 与 `fetch` 级特性），无任何 npm 依赖。

```bash
# 方式一：CLI 单次解剖
node xray.js https://linear.app

# 带红蓝对抗（需 LLM API key）
node xray.js https://linear.app --redblue "我自己做 issue tracker，差异化是 AI 自动分类"

# 批量解剖（五站回归用；串行加 --concurrency 1）
node batch_xray_parallel.js --out ./reports

# 方式二：Web 工作台
node workbench/server.js
# 打开 http://127.0.0.1:3737 ，首次会引导配置大模型 API Key
```

### LLM 配置

三选一，优先级从高到低：

1. **工作台 ⚙️ 设置**（推荐）：界面内填，存 `settings.json`（已 gitignore）
2. **`.env` 文件**：复制 `.env.example` 为 `.env`，填 `LLM_API_KEY`（另可选 `OPEN_CORPORATES_KEY` / `CRUNCHBASE_KEY`）
3. **环境变量**：`LLM_PROVIDER` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_BASE_URL`

支持 Anthropic 兼容与 OpenAI 兼容两类接口（含 MiniMax、DeepSeek 等第三方代理）。**未配置 key 时所有 LLM 功能优雅跳过，规则引擎照常出完整报告。**

## 目录结构

```
xray/
├── xray.js                 # CLI 入口
├── batch_xray_parallel.js   # 批量解剖（唯一批处理入口，--concurrency 1 即串行）
├── rules/
│   ├── webappanalyzer/     # 社区规则源快照（enthec/webappanalyzer，MIT，7600+ 应用）
│   └── incremental/        # 自维护增量规则（语义明确、宁缺毋滥；合并策略见 rules_loader）
├── scripts/
│   └── update_rules.js     # 规则快照刷新（GitHub API 拉取，刷新后 git diff 审查）
├── lib/
│   ├── collect/            # 三路采集器（tech / pricing / team / company_info）
│   ├── tech/               # 规则引擎（rules_loader + detect，7 静态通道 + implies/requires/excludes）
│   ├── reason/             # 推理组装（assemble）
│   ├── render/             # Markdown 渲染
│   ├── llm/                # LLM 客户端 / 红蓝对抗 / 定价页抽取（A-MINT）/ 竞品发现
│   ├── shared/http.js      # 零依赖 HTTP（deadline 预算 + 空闲/硬双超时 + 截断即成功）
│   ├── env.js              # .env 加载单一真相源
│   ├── db.js               # SQLite 持久层（node:sqlite）
│   ├── evidence.js         # 证据池 + 来源权重表
│   ├── cache.js            # 文件缓存
│   ├── pipeline.js         # dissectOne 主管线（150s 采集预算 + 240s 兜底）
│   └── http_multipart.js   # 零依赖 multipart 解析（BP 上传）
├── workbench/              # Web 工作台（单文件 SPA + 零依赖 http server）
├── tests/                  # 6 个测试套件（全部离线可跑，零网络）
├── SPECS.md                # 报告契约规格（含 v1.7 增补验收标准）
└── DATA_SOURCES.md         # 数据源清单、命中率与合规姿态
```

## 文档

- [SPECS.md](SPECS.md) — 报告 JSON 契约、置信度规则、v1.0 + v1.7 验收标准
- [DATA_SOURCES.md](DATA_SOURCES.md) — 全部数据源、命中通道与已知差距（诚实清单）
- [TEST_REPORT.md](TEST_REPORT.md) — 实测验收报告（v1.0 + v1.7 两轮）

## 合规声明

仅抓取公开页面信息，使用真实 UA 标识，不绕过验证码 / 登录墙 / robots 禁区。报告为自动化推断，不构成商业决策依据。
