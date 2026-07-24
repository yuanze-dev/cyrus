# Cyrus 目标重定义：Mission 协作平台

> 前置阅读：`PROJECT-OVERVIEW.md`（现状盘点）、`REFACTOR-ROADMAP.md`（代码侧重构路线）。
> 本文档重新定义产品的最终目标，并回答「Web 后台是新建还是改造」。决策日期：2026-07-23。

## 1. 一句话愿景

把 Cyrus 从「单人 CLI 工具」升级为**团队级 AI 研发协作平台**：人在 Web 后台与飞书中发起、评审、观察 Mission，agent 在隔离 worktree 中执行，全过程可见、可协作、可追溯。

定位演进：
- 之前：Linear/飞书事件驱动 agent 干活的自动化 worker（内部工具）
- 现在：worker 之上加一个**多用户控制面**——Mission 的发起、评审、观察、协作都在这里发生

## 2. 用户与核心场景

角色：小团队成员，飞书账号体系，无复杂 RBAC（发起者 / 协作者 / 观察者三种语义即可）。

核心场景：

1. **直接执行**：A 在后台创建 Mission（选项目、写清需求），点执行 → agent 立即开工。
2. **评审后执行**：A 创建 Mission 并撰写方案文档 → 指定 B 评审 → B 在后台（或飞书里）通过/打回 → 通过后 agent 开工。项目配置可设「默认需要评审」。
3. **飞书协作闭环**：A 发布 Mission 时若项目配置要求协作或 A 明确指定 B → 系统通过飞书给 B 发协作卡片（Mission 摘要 + 方案要点 + 同意/打回）→ B 在飞书内完成处理，结果同步回后台。
4. **实时观察**：任何人可以打开执行中的 Mission，像看 Claude Code 一样实时看到 agent 的会话输出（thought/tool_use/result 流）。
5. **总览**：所有 Mission 的列表与状态（待评审 / 排队 / 执行中 / 完成 / 失败），可按项目、人、状态过滤。

## 3. 领域模型

- **Project（项目）**：一组仓库 + 配置（默认 runner/模型、是否需要评审、协作人映射）。约等于现有 `RepositoryConfig` 的上层分组。
- **Mission（使命）**：核心工作单元。字段：标题、需求描述、关联 Project、状态机（`draft → pending_review → approved/rejected → queued → running → succeeded/failed/canceled`）、创建人、协作人、**可关联 Linear Issue**（identifier + url，双向）。
- **Doc（方案文档）**：挂在 Mission 下的 Markdown 文档，支持评论与历史版本（轻量协同，不做 CRDT 实时共编）。评审的对象就是它。
- **Review（评审）**：Doc/Mission 上的审批记录（通过/打回 + 意见），可来自后台或飞书卡片。
- **Session（执行会话）**：agent 的一次执行，事件流（thought/action/response/error）可实时订阅；与现有 `CyrusAgentSession` 对应。
- **User（用户）**：飞书 OAuth 登录，open_id 为身份锚点，显示名/头像同步自飞书；团队白名单控制准入。

## 4. 功能范围

**V1 范围**：
- 飞书 OAuth 登录 + 团队白名单
- Project / Mission CRUD，Mission 状态机，任务总览列表
- 方案文档：Markdown 编辑、评论、历史版本
- 评审流：后台内评审 + 飞书卡片评审（按钮回调）
- 执行：Mission 下发到 edge-worker 执行；支持关联/派生 Linear Issue
- 实时 Session 流：Web 端实时渲染 agent 输出
- 执行结果通知：飞书私聊/线程回告发起人与协作人

**明确非目标（V1 不做）**：
- 多租户 / 复杂权限体系 / 对外开放注册
- 实时协同编辑（CRDT）
- 取代 Linear 的全功能 issue 管理（Mission 只做轻量关联）
- 移动端适配

## 5. 关键判断：新建 vs 改造

**选项 A：嵌进 edge-worker 同进程**
- 优点：session 数据零距离；复用 fastify；单进程部署
- 缺点：edge-worker 已是 7900 行 god class，再塞多用户 Web 后台（认证、DB、协同）雪上加霜，与重构方向（拆分减负）直接冲突；worker 重启会拖垮后台可用性；单用户 daemon 与多用户控制面的生命周期诉求根本不同

**选项 B：同 monorepo 新建独立应用 `apps/mission-control`（推荐）**
- 控制面（Web、认证、DB、协同）与执行面（edge-worker）分离——这正是上游 cyrus 自己的演进方向（edge-proxy 架构），也是行业通行形态
- 代码复用靠 monorepo workspace 依赖：`feishu-event-transport`（token、消息、用户目录）、`cyrus-core`（类型）直接引用
- edge-worker 只需长出一层薄 **Worker API**，这个 API 反过来倒逼重构期收敛出清晰边界（依赖阶段 1 消息模型、阶段 2 session 存储）
- 独立部署、独立迭代，技术栈自由选择（见 §6.1）
- 代价：要定义并维护 Worker API 契约；部署变为两个进程（内部工具可接受）

**选项 C：全新仓库**
- 完全自由，但失去 workspace 代码复用（飞书包与 core 类型要发布或拷贝），对内部工具是不必要的仪式，排除

**结论：选 B**——同仓新建 `apps/mission-control` 作为控制面，edge-worker 退化为纯执行面，两者通过 Worker API 契约通信。

## 6. 推荐架构

```
┌─ apps/mission-control（控制面，新）────────────────────┐
│  React SPA（Vite + MobX + Dexie/IndexedDB）           │
│  后端服务（Fastify + GraphQL + PostgreSQL + Redis）： │
│    飞书 OAuth / Mission·Doc·Review·Project CRUD /     │
│    Session 流聚合转发（SSE 到前端）                   │
│    飞书机器人交互（复用 feishu-event-transport 包，   │
│    扩展 card.action.trigger 卡片回调）                │
└──────────────┬───────────────────────────────────────┘
               │ Worker API（HTTP + SSE，新增契约）
┌──────────────▼───────────────────────────────────────┐
│  packages/edge-worker（执行面，重构收敛后）           │
│    Worker API：Mission 下发 / Session 列表·详情 /    │
│    Session 事件流（SSE）/ 状态回调                   │
│  （内部：SessionStore 单一存储 ← 重构阶段 2 产出）    │
└──────────────────────────────────────────────────────┘
```

关键机制：

- **Mission 下发**两条路：① 关联 Linear 的 Mission → 走现有成熟链路（建 Linear issue + assign，edge-worker 原生接管）；② 纯后台 Mission → Worker API 直接下发（edge-worker 新增入口，复用与 F1 的 `platform:"cli"` 相同的「非 Linear 触发」模式——F1 已证明这条路的可行性）
- **实时 Session 流**两个来源：短期可复用已有先例 `HttpSessionStore`（claude-runner 已会把 transcript 镜像到控制面 SessionStore，实现接收端即可，Claude 可用）；正解是 Worker API 的 SSE 流（依赖重构阶段 2 的 SessionStore 收敛，Claude/Codex 统一）
- **飞书卡片评审**：控制面复用 `feishu-event-transport` 的 token/消息能力发交互卡片；卡片按钮回调（`card.action.trigger`）是该包需要扩展的新事件类型
- **身份**：飞书 OAuth 网页授权 → open_id 锚定；与 `UserAccessControl` 的 open_id 维度（IN-42 P5）对齐

### 6.1 技术选型（2026-07-23 已定：方案 A 完全自研，学习价值最大）

| 层 | 选型 | 理由 |
|---|---|---|
| 后端运行时 | Node.js + TypeScript | 与仓内主体一致，前后端共享类型 |
| HTTP 框架 | Fastify | 轻量、性能好、TypeScript 友好；仓内已有使用先例 |
| API | GraphQL（Pothos + Yoga） | 对标 Linear 的 GraphQL-only；schema 驱动、类型贯通 |
| 实时层 | **SSE（不用 WebSocket）** | 推送以服务端→客户端单向为主（session 流、状态变更通知），SSE 足够且更简；无双向高频交互需求 |
| 数据库 | PostgreSQL | 主存储；Mission/Doc/Review/User 等关系型数据 |
| 缓存/队列 | Redis | pub/sub 做变更广播（多实例/进程间通知），后续可扩展为队列 |
| 前端 | React + TypeScript + MobX | 对标 Linear 前端（MobX），可观测状态驱动 UI |
| 本地存储 | IndexedDB（Dexie 封装） | 客户端本地副本，为 local-first 打基础 |

补充说明：

- **local-first 分期实施**：IndexedDB 本地副本 + 增量同步是全方案复杂度最高的部分（Linear 的 sync engine 级别）。建议 V1 先做「服务端权威 + MobX 内存态 + SSE 失效通知」，本地持久化副本作为后续增强，不阻塞主线
- **Worker API 不受 GraphQL 约束**：mission-control ↔ edge-worker 之间的内部契约保持普通 HTTP + SSE，不进 GraphQL schema
- ORM/迁移工具待定（Drizzle / Prisma，动工时按仓内现状与团队熟悉度选）

## 7. 与重构路线图的关系（互相依赖，不是先后阻塞）

- Mission Control 的 **Worker API** 应建立在重构阶段 1（消息模型）与阶段 2（SessionStore 收敛、EdgeWorker 拆分）的产出之上 → 建议 M2 排在重构阶段 2 之后
- 但 **M1（骨架 + 登录 + CRUD + 文档评审）完全不依赖 edge-worker**，可与重构阶段 0/1 并行开工
- 重构路线图需增补一条：阶段 2 的 EdgeWorker 拆分时，把「Worker API 端点」作为平台 handler 之外的独立模块预留出来
- 评审流与 IN-42 的跨渠道注入天然衔接：B 在飞书批复的「按这个方案做」本质就是一次跨渠道 prompt 注入

## 8. 里程碑

| 里程碑 | 内容 | 依赖 |
|---|---|---|
| M1 骨架 | apps/mission-control：React+Vite 前端、Fastify + GraphQL 后端、PostgreSQL、飞书 OAuth、Project/Mission CRUD、总览列表 | 无（可与重构并行） |
| M2 执行打通 | Worker API（下发 + session 查询 + SSE 流）、实时会话查看、结果通知 | 重构阶段 1–2 |
| M3 评审流 | 文档（Markdown+评论+版本）、评审状态机、飞书卡片评审 | M1 |
| M4 Linear 关联 | Mission ↔ Linear Issue 双向关联、派生执行 | M2 |
| M5 打磨 | 过滤搜索、通知完善、部署脚本（并入 DEPLOY.md） | 全部 |

## 9. 待决问题（实现前再定，不阻塞文档）

1. ~~后端框架与 ORM 选型~~ → 框架已定（Fastify + GraphQL/Pothos+Yoga + PostgreSQL + Redis，见 §6.1）；ORM/迁移工具仍待选（Drizzle / Prisma）
2. Session 流短期是否先用 `HttpSessionStore` 镜像方案顶（Claude-only），还是等 Worker API
3. 飞书应用形态：复用现有 cyrus 飞书应用 vs 为控制面单独建应用（影响 OAuth 回调与卡片域名配置）
4. Mission 与 Linear Issue 的关联是创建时必选还是可选
