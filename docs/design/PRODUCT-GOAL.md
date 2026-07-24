# Xight（Cyrus 目标重定义）：Mission 协作平台

> 项目命名：**Xight** = cyrus fork + 自研需求（飞书深度集成 + Mission 协作控制面）的整体项目名；营销站见 `apps/website`（`xight-website`）。

> 前置阅读：`PROJECT-OVERVIEW.md`（现状盘点）、`REFACTOR-ROADMAP.md`（代码侧重构路线）。
> 本文档重新定义产品的最终目标，并回答「Web 后台是新建还是改造」。决策日期：2026-07-23。
> 2026-07-23 二轮修订：任务与流程自承载（Linear 降级为可选集成）、新增执行中人工介入与验收环节（V1）、多 agent 协同（V2），对标分析参考飞书 CodeM。
> 2026-07-23 三轮修订：新增「自动化」功能（触发条件 + 输入 + 固定 prompt → 自动生成 Mission，M4）。

## 1. 一句话愿景

把 Cyrus 从「单人 CLI 工具」升级为**团队级 AI 研发协作平台**：人在 Web 后台与飞书中发起、评审、观察 Mission，agent 在隔离 worktree 中执行，全过程可见、可协作、可追溯。

定位演进：
- 之前：Linear/飞书事件驱动 agent 干活的自动化 worker（内部工具）
- 现在：worker 之上加一个**多用户控制面**——Mission 的发起、评审、观察、协作都在这里发生
- **任务与流程自承载**：Mission 本身是一等公民，流程（状态机/评审/验收）由平台自己承载；Linear 仅作为可选的外部同步目标，不再是任务源（Linear 满足不了流程需求，但也不做完整的 Linear 式工作流引擎——Mission 流程保持固定而精简）

### 1.1 分层原则：流程引擎 ≠ 执行档案

「Linear 满足不了需求」与「完全自研太重」的解法是分层，不是二选一：

- **流程引擎（轻量自研）**：Linear 的 agent 能力模型只有 issue 固定状态 + 评论 + activity 时间线，承载不了评审/介入/验收。自研范围严格收窄为三样——一个**固定**状态机（8 态，不可自定义）、Review/Approval/Acceptance 三张记录表、后台 SSE + 飞书卡片双通道通知。这是 CRUD + 状态机 + 通知，不是工作流引擎
- **执行档案（Linear 继续担任）**：cyrus 与 Linear 的深度集成（AgentSession API、activity timeline）继续服务「任务怎么执行」；Mission 下发走 Worker API 直连 edge-worker 后，Linear 从必经之路退为可选同步出口
- **防蠕变红线**：未来出现「我们项目想要不一样的流程」类需求，只用项目级配置开关解决（是否需要评审、默认验收人、高风险动作清单、超时策略），**绝不做用户自定义节点流**——配置 ≠ 工作流引擎。若某天真的需要完整工作流，再评估自托管开源 tracker（如 Plane）或迁移飞书项目，现在不做

## 2. 用户与核心场景

角色：小团队成员，飞书账号体系，无复杂 RBAC（发起者 / 协作者 / 观察者三种语义即可）。

核心场景：

1. **直接执行**：A 在后台创建 Mission（选项目、写清需求），点执行 → agent 立即开工。
2. **评审后执行**：A 创建 Mission 并撰写方案文档 → 指定 B 评审 → B 在后台（或飞书里）通过/打回 → 通过后 agent 开工。项目配置可设「默认需要评审」。
3. **飞书协作闭环**：A 发布 Mission 时若项目配置要求协作或 A 明确指定 B → 系统通过飞书给 B 发协作卡片（Mission 摘要 + 方案要点 + 同意/打回）→ B 在飞书内完成处理，结果同步回后台。
4. **实时观察**：任何人可以打开执行中的 Mission，像看 Claude Code 一样实时看到 agent 的会话输出（thought/tool_use/result 流）。
5. **执行中人工介入**：agent 执行到高风险动作（push、建 PR、删文件等）时自动暂停并请求确认，相关人在后台或飞书批准/拒绝后，agent 才继续。
6. **验收**：agent 完工后提交验收报告（变更摘要 + 测试/构建证据 + PR），发起人/协作人验收通过则 Mission 完成；打回则带意见返修。
7. **总览**：所有 Mission 的列表与状态（待评审 / 排队 / 执行中 / 待验收 / 完成 / 失败），可按项目、人、状态过滤。
8. **自动化**：定义「触发条件 + 输入 + 固定 prompt」的自动化工作流——发版 webhook + 公告 prompt = 上线通知；每天定时 + 总结 prompt = 反馈日报；用户反馈 webhook + 研发 prompt = 反馈直达研发；Sentry webhook + 研发 prompt = 自动修 bug。

## 3. 领域模型

- **Project（项目）**：一组仓库 + 配置（默认 runner/模型、是否需要评审、协作人映射、高风险动作确认规则、审批超时策略）。
- **Mission（使命）**：核心工作单元。字段：标题、需求描述、关联 Project、验收标准（可选 checklist）、状态机、创建人、协作人、来源（手动创建 / 某 Automation 触发）。状态机：`draft → pending_review → approved/rejected → queued → running → pending_acceptance → succeeded/failed/canceled`（验收打回：`pending_acceptance → running` 返修回路）。**可选**关联外部系统（Linear Issue 等）作为同步目标。
- **Automation（自动化）**：可编程的 Mission 生成器。组成 = 触发条件（webhook / cron / 手动）+ 输入映射（payload → 模板变量）+ 固定 prompt 模板 + 目标项目。每次触发实例化一个 Mission，自动继承整条流水线；评审由目标项目的既有配置决定（与手动创建的 Mission 一致），去重/限流等策略不作为系统功能、写进 prompt 由 agent 处理——系统保持最简（详见 §6.5）。
- **Doc（方案文档）**：挂在 Mission 下的 Markdown 文档，支持评论与历史版本（轻量协同，不做 CRDT 实时共编）。评审的对象就是它。
- **Review（评审）**：Doc/Mission 上的审批记录（通过/打回 + 意见），可来自后台或飞书卡片。
- **Approval（执行中审批）**：agent 执行过程中的高风险动作确认记录（动作描述、请求人可见上下文、批准/拒绝、耗时），全部留痕。
- **Acceptance（验收）**：agent 完工提交的验收报告（变更摘要 + 机器验证结果 + 产出链接）+ 人工验收结论（通过/打回 + 意见）。
- **Session（执行会话）**：agent 的一次执行，事件流（thought/action/response/error）可实时订阅；与现有 `CyrusAgentSession` 对应。
- **User（用户）**：飞书 OAuth 登录，open_id 为身份锚点，显示名/头像同步自飞书；团队白名单控制准入。

## 4. 功能范围

**V1 范围**：
- 飞书 OAuth 登录 + 团队白名单
- Project / Mission CRUD，Mission 状态机，任务总览列表
- 方案文档：Markdown 编辑、评论、历史版本
- 评审流：后台内评审 + 飞书卡片评审（按钮回调）
- **执行中人工介入**：高风险动作确认（后台 SSE 弹窗 + 飞书卡片双通道，详见 §6.2）
- **验收环节**：验收标准 + 验收报告 + 通过/打回返修（详见 §6.3）
- 执行：Mission 下发到 edge-worker 执行
- 实时 Session 流：Web 端实时渲染 agent 输出
- 执行结果通知：飞书私聊/线程回告发起人与协作人

**M4 自动化（紧随 V1 核心链路稳定后）**：
- **自动化工作流**：webhook / cron 触发 + 输入映射 + prompt 模板 → 自动生成 Mission（详见 §6.5）

**V2 展望**：
- **多 agent 协同**：角色化子 agent（需求拆解 / 实现 / 校验）并行或串行协作，基于现有父子 session 编排（详见 §6.4）
- Linear 等外部系统的双向同步（可选集成，优先级下调）

**明确非目标（V1 不做）**：
- 多租户 / 复杂权限体系 / 对外开放注册
- 实时协同编辑（CRDT）
- 完整的 Linear 式工作流引擎（自定义字段、自定义状态流）——Mission 流程固定而精简
- 人的广义任务管理（需求池、bug 跟踪、迭代规划、看板）——自研边界是「agent 任务的流程引擎」，人的任务管理留在 Linear 或飞书项目
- 组织资产管理（知识库/技能/工具市场）——参考 CodeM 但现阶段不做
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
│    审批与验收流（Approval / Acceptance）/             │
│    自动化引擎（webhook 接入 / cron 调度 / 模板渲染）/ │
│    Session 流聚合转发（SSE 到前端）                   │
│    飞书机器人交互（复用 feishu-event-transport 包，   │
│    扩展 card.action.trigger 卡片回调）                │
└──────────────┬───────────────────────────────────────┘
               │ Worker API（HTTP + SSE，新增契约）
┌──────────────▼───────────────────────────────────────┐
│  packages/edge-worker（执行面，重构收敛后）           │
│    Worker API：Mission 下发 / Session 列表·详情 /    │
│    Session 事件流（SSE）/ 审批请求上行·决议下行 /    │
│    状态回调                                          │
│  （内部：SessionStore 单一存储 ← 重构阶段 2 产出）    │
└──────────────────────────────────────────────────────┘
```

关键机制：

- **Mission 下发**：Mission → Worker API 直接下发（edge-worker 新增入口，复用与 F1 的 `platform:"cli"` 相同的「非 Linear 触发」模式——F1 已证明这条路的可行性）；若配置了外部同步（如 Linear），同步动作由控制面负责，不作为执行的前提
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

### 6.2 执行中人工介入（HITL）机制

代码侧已有两处可复用的地基，此功能不是从零发明：

- **Claude**：`AskUserQuestionHandler` 已实现完整闭环——agent 的 AskUserQuestion 工具调用 → promise 挂起 → elicitation 发给用户 → 用户回答 → resolve 恢复执行。本功能 = 把这套「挂起-询问-恢复」模式从 Linear elicitation 通道泛化为多通道，并把触发点从 AskUserQuestion 扩展到 `canUseTool` 权限回调
- **Codex**：app-server 协议原生有 approval 请求通道，当前 `approvalPolicy: "never"` + 防御性自动 accept（`appServerProcess.ts:198`）。开启 `askForApproval` 并把 approval 请求接到审批通道即可

机制设计：

1. **触发规则（项目级配置）**：按动作类型匹配高风险清单——`git push`、创建 PR/MR、删除或覆写 worktree 外文件、安装依赖、部署/发布、其他管理员自定义的 Bash 模式。规则匹配复用 Claude 风格的工具词表（`Bash(git push:*)` 等），Codex 侧经其权限 profile 翻译
2. **挂起**：命中规则 → runner 在 `canUseTool`（Claude）/ approval 请求（Codex）处阻塞，等待决议；session 事件流中可见「等待人工确认」状态
3. **双通道通知**：控制面收到审批请求上行 → 后台 SSE 实时弹出 + 飞书卡片（动作描述 + 上下文 + 批准/拒绝/附言按钮）推送给发起人/协作人
4. **决议下行**：批准（可附言）→ runner 继续执行；拒绝（可附理由）→ 作为用户反馈注入 session，agent 换路径继续
5. **超时策略（项目级）**：默认超时自动拒绝（安全取向）；可配置为自动批准但强制留痕
6. **全部留痕**：谁、何时、批了什么动作、附言内容，记入 Mission 的 Approval 记录，时间线可查

### 6.3 验收机制

回答「验收怎么做」——机器验证 + 人工确认两段式：

1. **验收标准**：Mission 创建时可填 checklist（可选）；若经过评审流，评审通过时标准即冻结，作为验收依据
2. **验收报告（agent 强制产出）**：完工时 agent 必须提交——变更摘要、自验证据（测试/构建/lint 输出）、产出链接（PR、预览地址）。这是现有 `concise-summary` subroutine 的结构化升级，靠系统 prompt + 结构化输出约束
3. **机器验证自动跑**：worktree 内执行 verifications（test / lint / typecheck / build），结果附在报告中；任一失败则不允许进入 `pending_acceptance`，直接打回 agent 返修
4. **人工验收**：发起人/协作人在后台或飞书卡片「通过 / 打回」：
   - 通过 → Mission `succeeded`，飞书通知相关人
   - 打回（附意见）→ 意见作为新 prompt 注入**同一 session** 继续返修（复用现有续接/`--continue` 机制），Mission 回到 `running`
5. 验收记录（报告、证据、结论、耗时）全部留在 Mission 时间线

### 6.4 多 agent 协同（V2 方向）

- 复用现有**父子 session 编排**：`GlobalSessionRegistry` 的 child→parent 映射、orchestrator 系统 prompt、子 session 完成结果回流父 session 的机制均已存在（当前用于 Linear 子 issue 场景）
- 角色化：父 agent 作为编排者，按角色拆出子 agent——需求拆解 / 风险扫描 / 实现 / 校验（对标 CodeM 的四 agent 形态），子 agent 可以是不同 runner（如 Claude 拆解 + Codex 实现）
- 控制面呈现：Mission 详情页展示 agent 树（父 + 各子 agent 状态），每个子 agent 的 session 流可独立围观
- 前置条件：单 agent 链路（下发/介入/验收）稳定后再做，排 V2

### 6.5 自动化机制

**定位：Automation = 可编程的 Mission 生成器。** 它完全长在控制面，不发明第二条执行路径——触发后实例化一个标准 Mission，自动继承评审/介入/验收/围观整条流水线；edge-worker 无感（只收到标准 Mission 下发），这是控制面/执行面分离的直接红利。

组成与机制：

1. **触发条件**（三选一）：
   - **Webhook**：每个 automation 生成独立 URL + secret；支持按 payload 字段过滤（如仅 Sentry `level=error` 才触发）；payload 原文留存可查
   - **定时**：cron 表达式，控制面进程内调度（部署多实例时用 Redis 锁防重复触发）
   - **手动**：后台「立即运行」按钮，用于调试与临时触发
2. **输入映射**：payload 字段 → prompt 模板变量（如 `{{payload.release.version}}`、`{{payload.issue.title}}`）；payload 全文可作为上下文附件注入；定时触发无 payload 时注入时间窗参数（如「昨天」的日期范围）
3. **prompt 模板**：固定文本 + 变量插值，渲染结果即 Mission 的需求描述；每条 automation 绑定目标 Project（决定仓库、runner、评审规则）
4. **保持最简（明确不做的系统功能）**：执行模式、去重、限流都不内建——是否需要评审由目标 Project 的既有配置决定（与手动创建的 Mission 一致，不另设开关）；「同 bug 不重复开工」「发公告前先找人确认」这类诉求写进 prompt，由 agent 自己查 Mission 列表、按 prompt 要求发起人工确认来处理。系统只做：触发 → 渲染 → 建 Mission
5. **留痕**：Mission 记录来源（automationId + 触发快照），automation 有触发历史（触发时间、生成的 Mission 链接）

四个典型配置的映射：

| 场景 | 触发条件 | 输入 | prompt 模板 |
|---|---|---|---|
| 上线通知 | 部署/发版 webhook | 版本、变更列表、环境 | 发布公告 prompt（生成公告并发飞书群，prompt 内约定先确认再外发） |
| 反馈日报 | cron（每天上午） | 昨日反馈集合（时间窗参数；反馈数据可由另一条 webhook automation 落库） | 总结 prompt |
| 反馈直达研发 | 用户反馈 webhook | 反馈内容、用户信息 | 研发 prompt（分析→定位→修复） |
| 自动修 bug | Sentry webhook | 异常堆栈、频次、影响面 | 研发 prompt（复现→修复→验证；prompt 内约定已有进行中任务时追加而非重复开工） |

## 7. 与重构路线图的关系（互相依赖，不是先后阻塞）

- Mission Control 的 **Worker API** 应建立在重构阶段 1（消息模型）与阶段 2（SessionStore 收敛、EdgeWorker 拆分）的产出之上 → 建议 M2 排在重构阶段 2 之后
- 但 **M1（骨架 + 登录 + CRUD + 文档评审）完全不依赖 edge-worker**，可与重构阶段 0/1 并行开工
- 重构路线图需增补一条：阶段 2 的 EdgeWorker 拆分时，把「Worker API 端点」作为平台 handler 之外的独立模块预留出来；**审批通道（请求上行/决议下行）是 Worker API 的一等端点**，重构时一并规划
- 评审流与 IN-42 的跨渠道注入天然衔接：B 在飞书批复的「按这个方案做」本质就是一次跨渠道 prompt 注入
- 自动化完全长在控制面，对 edge-worker 的唯一依赖是 Mission 下发端点（M2）；它不改变重构路线的任何排期

## 8. 里程碑

| 里程碑 | 内容 | 依赖 |
|---|---|---|
| M1 骨架 | apps/mission-control：React+Vite 前端、Fastify + GraphQL 后端、PostgreSQL、飞书 OAuth、Project/Mission CRUD、总览列表 | 无（可与重构并行） |
| M2 执行打通 | Worker API（下发 + session 查询 + SSE 流）、实时会话查看、**执行中人工介入（审批通道）**、结果通知 | 重构阶段 1–2 |
| M3 评审与验收 | 文档（Markdown+评论+版本）、评审状态机、飞书卡片评审、**验收环节（报告 + 机器验证 + 人工验收/返修）** | M1、M2 |
| M4 自动化 | webhook/cron 触发器、输入映射与 prompt 模板、触发历史 | M2 |
| M5 外部同步（可选） | Mission ↔ Linear Issue 双向关联、派生执行（优先级下调，按需） | M2 |
| M6 打磨 | 过滤搜索、通知完善、部署脚本（并入 DEPLOY.md） | 全部 |
| M7 多 agent（V2） | 角色化子 agent 编排、agent 树呈现、跨 runner 组合 | M2–M3 稳定后 |

## 9. 待决问题（实现前再定，不阻塞文档）

1. ~~后端框架与 ORM 选型~~ → 框架已定（Fastify + GraphQL/Pothos+Yoga + PostgreSQL + Redis，见 §6.1）；ORM/迁移工具仍待选（Drizzle / Prisma）
2. Session 流短期是否先用 `HttpSessionStore` 镜像方案顶（Claude-only），还是等 Worker API
3. 飞书应用形态：复用现有 cyrus 飞书应用 vs 为控制面单独建应用（影响 OAuth 回调与卡片域名配置）
4. 高风险动作清单的默认集（项目级可配，但需要一个合理的默认）
5. 自动化的 webhook 入口域名/网关形态（与飞书卡片回调、OAuth 回调是否共用同一公网入口）
