# Cyrus 项目功能全景（fork 现状盘点）

> 目的：为「重构 vs 重写」决策与后续体系化改造提供事实基线。
> 数据截至 2026-07-23（HEAD `c3a51f6`），由全仓代码盘点生成，行数为约数。

## 0. Fork 身份与上游关系

- 本仓是 [ceedaragents/cyrus](https://github.com/ceedaragents/cyrus) 的 fork，基点 `b0c6702`（2026-07-02），fork 仅约 3 周。
- fork 独有 18 个非 merge 提交，**几乎全部围绕飞书（Lark）集成**：新增 `feishu-event-transport` 包、飞书↔Linear 联动、运维 runbook（DEPLOY.md）、IN-42 设计文档。GitLab 支持来自上游，非本 fork 添加。
- 上游仍在高频迭代（CYPACK-13xx 系列），本 fork 最近一次同步上游是 2026-07-06。是否继续跟随上游，是重构自由度的最大变量。
- 上游已搭好但未完成的「统一消息总线」（`InternalMessage`）+ 本 fork 的 IN-42 设计文档（`IN-42-unified-session-multi-channel.md`）是当前最重要的既有路线图。

## 1. 项目定位

把各平台（Linear / GitHub / GitLab / Slack / 飞书）的 issue 与聊天事件，接入各家 AI coding agent（Claude / Gemini / Codex / Cursor），在隔离的 git worktree 中自动完成研发任务，并把过程实时回写到来源平台。

## 2. 总体架构与数据流

```
平台 webhook/WS ──► SharedApplicationServer（Fastify 单端口，可挂 Cloudflare Tunnel）
   │
   ├─ XxxEventTransport（验签/解密/去重/归一化）
   │     ├─ legacy "event" 事件 ──► EdgeWorker.handleWebhook（真正干活的主链路）
   │     └─ 统一 "message" 总线 ──► EdgeWorker.handleMessage（半成品，5/6 是 TODO）
   │
   ▼
EdgeWorker（编排总控）
   ├─ RepositoryRouter：label / 描述 tag [repo=name#branch] / team / project / 用户选择
   ├─ UserAccessControl 白名单、blocked-by 依赖阻塞（park 唤醒）
   ├─ GitService：每 issue 建 git worktree（跑 cyrus-setup.sh / cyrus-teardown.sh）
   ├─ PromptBuilder：系统 prompt（builder/debugger/…）+ skills + issue context + 评论
   ├─ RunnerSelectionService + RunnerConfigBuilder：选 runner/模型、装配权限/沙箱/MCP
   ├─ IAgentRunner（claude/gemini/codex/cursor）：跑会话、支持流式注入与 resume
   ├─ AgentSessionManager：runner 消息 → 活动条目（per-session 串行队列）
   └─ IActivitySink / ChatPlatformAdapter：回写 Linear 时间线 / 飞书·Slack 线程
```

## 3. 功能清单（按领域）

### 3.1 事件接入层（6 个 transport + CLI 测试模式）

| 平台 | 包 | 入口方式 | 鉴权 | 下行能力 |
|---|---|---|---|---|
| Linear | `linear-event-transport` | webhook | HMAC + IP 白名单 / proxy Bearer | 全量 `IIssueTrackerService`（issue/comment/agentSession/agentActivity/上传） |
| GitHub | `github-event-transport` | webhook | HMAC-SHA256 | PR/issue 评论、reaction、App token 自铸 |
| GitLab | `gitlab-event-transport` | webhook | token 明文比对 | MR note、讨论回复、emoji |
| Slack | `slack-event-transport` | webhook | HMAC-SHA256 | 回帖、表情、线程拉取 |
| 飞书（自研） | `feishu-event-transport` | **webhook + WebSocket 双通道** | AES 解密 + 签名 / WS 免验签 | 回复（Markdown 卡片/纯文本）、表情、图片下载、tenant token 自铸、用户目录 |
| CLI（测试） | core 内 adapters | JSON-RPC `/cli/rpc` | — | 内存 issue tracker，供 F1 使用 |

统一抽象存在但薄弱：`IAgentEventTransport`（core）只有 Linear 显式 implements；所有 transport 都会产出统一 `InternalMessage`，但上层消费只完成 1/6。

### 3.2 会话编排核心（`edge-worker`，~24k 行）

- 事件路由：routingLabels → 描述 tag → teamKeys/projectKeys → 多候选挂起等用户选择。
- 会话生命周期：创建（拉 issue → 置 started → 建 worktree → 注册 session）→ 首 prompt → 后续评论注入（流式 `addStreamMessage` 或 `--continue` resume）→ stop/unassign/终态清理（停 runner、回帖、删 worktree）。
- 父子编排：子 session 完成后结果回流父 session（`GlobalSessionRegistry`）。
- 依赖阻塞：issue 被阻塞时 park，阻塞解除自动唤醒。
- 聊天会话：`ChatSessionHandler`（Slack/飞书共用）维护 thread↔session 映射、追问排队、busy 提示。
- 配置热更新：`ConfigManager` watch config.json，diff 出 repo 增删改与全局字段变化（**字段合并靠硬编码白名单**，CYHOST-967 事故根源）。
- 持久化：`PersistenceManager`（v4 schema）序列化 session/repoCache/父子映射/飞书绑定，重启恢复。
- 沙箱：`EgressProxy`（出口代理 + CA 证书）+ 文件系统沙箱配置，与工具权限构成双权限体系。

### 3.3 多 runner 层（4 个 runner + simple 抽象）

统一接口 `IAgentRunner`（core），但消息类型 `AgentMessage = SDKMessage` 直接别名 Claude SDK——**最大抽象泄漏**，其他 runner 被迫伪造 Claude 消息形状。

| runner | 驱动方式 | 流式输入 | 权限模型 | 特点 |
|---|---|---|---|---|
| claude | 进程内 Agent SDK | ✅ 真流式 | allowedTools + canUseTool + home 目录 deny | 原生 runner，唯一支持 warm session/interrupt |
| gemini | spawn CLI，stdout JSON | ❌（假流式） | **完全忽略 allowedTools，无条件 --yolo** | Zod 校验事件、delta 聚合 |
| codex | app-server JSON-RPC | ✅（turn/steer） | approvalPolicy + 沙箱 profile | 结构最现代：传输抽象 + 事件中间表示 |
| cursor | @cursor/sdk | ❌ | 权限翻译层 + hook 脚本 + sandbox.json | 直接改 `process.env`（并发污染风险） |

`simple-agent-runner` 提供「受限枚举应答」抽象（用于分类），但 4 份 SimpleXxxRunner 实现近乎逐行重复，且目前在生产链路无调用点。

新增一个 runner 需改动 **9 处**（core 枚举/session 字段、EdgeWorker switch、选择器、配置装配、session-id 锚定、resume 链、AgentSessionManager 三分支等），无注册表机制。

### 3.4 Prompt 体系与子程序

- `PromptBuilder`（1553 行）：按 label 选系统 prompt（builder/debugger/scoper/orchestrator/graphite-orchestrator，均为 `prompts/*.md`），组装 skills guidance、`<agent_context>`、issue context（mention/label/fallback 三种）、`<user_comment>`。
- **子程序不是代码机制**，是系统 prompt 里的流程文本（coding-activity → verifications → git-gh → concise-summary）。
- prompt 组装测试要求**全量断言**（`.expectUserPrompt()` 完整字符串），是本项目最强的回归安全网之一。

### 3.5 飞书特色能力（本 fork 自研，重构重点保护对象）

- 双 ingress（webhook + WS 长连接，免公网部署）；thread↔session 身份对齐（thread_id > root_id > messageId，别名归并防会话分裂）。
- @提及路由 + `/claude`、`/codex` 引擎前缀 + p2p 免 @。
- 上下文增强：发送者真人姓名注入、被回复消息补读、thread 分页拉取、跨 thread 近期回合 fallback。
- 图片解析：下载到本地并注入 `<feishu_attached_images>` manifest。
- 文档读取（mcp-tools 内 `feishu_read_document`）：docx/wiki raw_content、Bitable 表/字段/记录。
- 渲染：Markdown 检测 → interactive card；纯文本直接 text；失败降级。
- 表情反馈：OnIt 收条 → 完成 DONE + 移除 OnIt。
- **飞书→Linear 派生联动**（单向）：agent 用 `save_issue` 建 Linear issue → 捕获绑定 → Linear 完成时回帖飞书线程；`[agent=]` 标签保证引擎一致。
- `FEISHU_FULL_ACCESS` 全权限模式；F1 测试入口 `dispatchFeishuTestEvent`。

### 3.6 CLI 应用（`apps/cli`，npm 包 `cyrus-ai`）

命令：`start`（默认）、`auth`、`check-tokens`、`refresh-token`、`self-auth-linear`、`self-add-repo`。
配置：`~/.cyrus/config.json`（EdgeConfig，含迁移逻辑）+ `~/.cyrus/.env`；支持热重载。
另有 setup-waiting / idle 两种过渡模式（auth 后等云端下发配置）。

### 3.7 F1 端到端测试框架（`apps/f1`）

真实 EdgeWorker（`platform: "cli"`）+ 内存 issue tracker + JSON-RPC，16 个命令驱动 issue/session/chat 全链路；41 篇 test-drive 记录。是无外部依赖下验证核心逻辑的核心资产，AGENTS.md 强制重大改动走 F1 验证。

### 3.8 其他设施

- `mcp-tools`：内嵌 cyrus-tools MCP server（linear_* 8 工具 + feishu_read_document + Sora/图像生成 + failure-mode 上报）。
- `config-updater`：本地管理 API（改配置、增删 repo、MCP 测试、skills 管理）。
- `cloudflare-tunnel-client`：隧道 + onboarding 配置拉取。
- `skills/`：16 个共享 skill（工作流 6 个 + cyrus-setup 系列 10 个），单一 canonical 源 symlink 到各 harness。

## 4. 结构问题诊断（按严重度排序）

### P0 级（架构性，决定改造主线）

1. **`EdgeWorker.ts` 7910 行 god class**：~40 个字段、120+ 方法，混杂 ≥8 类职责（transport 注册、GitHub/GitLab/Feishu 平台编排、OAuth、持久化、MCP endpoint、prompt 组装、sandbox）。GitHub/GitLab 的平台编排（~1800 行）长在 EdgeWorker 里，而 Linear 有独立 transport 包——层间泄漏不对称。
2. **统一消息总线半成品**：所有 transport 双 emit（legacy + bus），但 bus 侧 6 个 handler 5 个是 TODO；同一事件两条路径「处理」两次（一次干活一次打日志）。IN-42 已把「激活总线」列为核心。
3. **Session 状态四处存储**：`AgentSessionManager.sessions`、`GlobalSessionRegistry.sessions`（目前只当 child→parent map 用）、EdgeWorker 的多个 map（sessionRepositories/activitySinks/parkedSessions…）、`ChatSessionHandler` 私有内存态。持久化靠手工拼装，易漏。
4. **`AgentMessage = Claude SDKMessage` 抽象泄漏**：非 Claude runner 全部伪造 Claude 形状（填 14 个 null 占位、手工合成 result），SDK 升级连锁破坏。

### P1 级（结构性，局部手术可解）

5. **transport 抽象名存实亡**：`IAgentEventTransport` 配置联合只覆盖 linear+cli；4 份近乎相同的 proxy/direct 切换、Bearer 校验、去重 TTL 样板。
6. **飞书双通道缺跨路去重**：webhook 与 WS 各自独立去重 map，两种投递都配时会重复处理。
7. **`FeishuChatAdapter` 1205 行职责混杂**：内含 Linear issue 解析器（`extractCreatedLinearIssues`）和 runner 路由知识，越界。
8. **runner 重复代码**：4 份 SimpleXxxRunner、codex/cursor formatter 逐字重复、日志设施三套、双份 `IMessageFormatter` 定义。
9. **ConfigManager 硬编码字段白名单**：新增配置字段不改两处就静默失效（已咬过人，CYHOST-967）。
10. **core 夹带 F1 测试基建**：CLI 适配器 3478 行占 core 32%，且 fastify 依赖错位（devDep 当被运行时依赖用）。

### P2 级（卫生性，顺手清理）

11. deprecated 字段残留（linearToken/defaultModel/webhookPort…）、重复类型定义（`IssueMinimal`×2、`PromptType`×2）、透传委托未清理、`runner.constructor.name` 字符串判断、`GeminiRunner` 权限空转、`CursorRunner` 改 `process.env`。

## 5. 规模统计

| 模块 | 文件数 | 行数 | 备注 |
|---|---|---|---|
| core | 35 | ~11,000 | 32% 是 F1 测试基建 |
| edge-worker | 42 | ~24,200 | EdgeWorker 单文件占 33%；74 个测试文件 |
| 4 runner + simple | 42 | ~13,700 | 测试 ~9,600 行 |
| 6 transport + tunnel/config-updater/mcp-tools | 55 | ~19,300 | 飞书包 ~4,300 行 |
| apps/cli | 24 | ~5,800（含测试） | |
| apps/f1 | 22 | ~2,600 | + 41 篇 test-drive |

## 6. 与 IN-42 方案的关系

IN-42 设计文档（本 fork 已立项，origin 上 IN-45~51 分支与其 P0–P6 阶段一一对应）覆盖了 P0 问题的 2、3 两项（总线激活、session 存储收敛）以及飞书↔Linear 双向 session 打通，但**不覆盖** EdgeWorker 拆分（1）、消息模型去 Claude 化（4）、runner 注册表等。任何重构计划都应把 IN-42 作为既有路线图的组成部分，而不是另起炉灶。

## 7. 决策记录（2026-07-23 已拍板）

1. **定位**：内部研发助手（自用/团队用，不产品化）。
2. **上游策略**：脱钩自立，不再 merge 上游 → 重构无冲突顾虑，可动大手术。
3. **平台范围**：保留 Linear + 飞书（核心）+ GitHub；砍 Slack、GitLab。
4. **Runner 范围**：保留 Claude + Codex；砍 Gemini、Cursor。
5. **路线**：在本仓重构（不新起项目）→ 见 `docs/design/REFACTOR-ROADMAP.md`。
6. **目标升级（2026-07-23 追加）**：定位从「CLI 工具」演进为「CLI + Web 协作平台」——新增 Mission 协作控制面（同仓新建 `apps/mission-control`，edge-worker 退化为执行面）→ 见 `docs/design/PRODUCT-GOAL.md`。
