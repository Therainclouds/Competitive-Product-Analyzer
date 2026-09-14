# 半人半机工作台（v1.5）

> 让验证期操作者在 1.5 小时内完成一份报告的人工精修。

## 启动

```bash
node xray/workbench/server.js
# 打开 http://localhost:3737
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `WORKBENCH_PORT` | 3737 | HTTP 端口 |
| `WORKBENCH_HOST` | 127.0.0.1 | 监听地址 |
| `LLM_API_KEY` | - | 红蓝对抗需要 |
| `LLM_PROVIDER` | anthropic | `anthropic` 或 `openai` |

## 三屏功能

### 屏幕 1：报告列表
- 表格视图：所有入 SQLite 库的报告
- 字段：ID / 公司 / URL / 生成时间 / 耗时 / 三件套置信度 / 反馈数 / 来源
- 操作：点行 → 进精修界面

### 屏幕 2：单报告精修
- 顶部：报告元信息 + 数据不足提醒
- 三大维度区块（技术栈 / 商业模式 / 团队规模）：
  - 原始报告内容
  - 每个 pillar 下方的反馈按钮（correct / partial / wrong / unclear）
  - 可选文本备注
- 红蓝对抗区块（如已生成）：
  - 每个攻击角度展示引用证据 + 攻击路径
  - 同样的反馈按钮
- 证据池：列出全部 evidence 详情（点击 URL 直接跳转）

### 屏幕 3：信号源统计
- 各信号源（headers / html / pricing_page / ...）的命中 / 未命中 / 命中率
- 最近反馈列表（点公司名跳转回精修界面）

## 新建报告

点右上「➕ 新建解剖」→ 弹窗：
- 必填：目标 URL
- 选填：启用红蓝对抗 + 自家产品描述
- 异步执行，前端轮询进度

## 错误反馈闭环（v2.0 审查意见 2.0 红线）

每条反馈写入 SQLite `feedbacks` 表：

| 字段 | 说明 |
|---|---|
| `report_id` | 关联 reports 表 |
| `pillar` | tech_stack / business_model / team_size / redblue |
| `item_ref` | 可选，定位具体子项（如 `tech:Next.js`） |
| `verdict` | correct / wrong / partial / unclear |
| `note` | 自由文本 |
| `created_at` | 自动 |

后续可基于 feedbacks 表做：
- 置信度模型校准（哪个 pillar 错得最多？）
- 信号源命中率统计（已实现，见屏幕 3）

## API（供外部脚本调用）

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/reports` | 列出报告 |
| GET | `/api/reports/:id` | 单份报告 + 反馈 |
| POST | `/api/reports` | 触发新解剖（异步，返回 taskId） |
| GET | `/api/tasks/:id` | 查询任务进度 |
| POST | `/api/reports/:id/feedback` | 提交反馈 |
| GET | `/api/stats` | 信号源命中率 |

## 不做的事

- ❌ 无用户认证（验证期单机用）
- ❌ 无报告分享/导出 PDF
- ❌ 无实时协作
- ❌ 无 WebSocket（轮询 2s 已够用）

## 已知限制

- SQLite 单文件 → 多进程并发不安全（Node 单进程足够）
- 任务进度在内存 → 服务重启后丢失（v1.6 可改持久化）
