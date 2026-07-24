# Cyrus 重构路线图

> 前置阅读：`docs/design/PROJECT-OVERVIEW.md`（功能全景与结构问题诊断）。
> 决策基线：内部研发助手 / 与上游脱钩 / 保留 Linear+飞书+GitHub × Claude+Codex / 本仓重构。
> 与 IN-42 的关系：本路线图吸收 IN-42（`IN-42-unified-session-multi-channel.md`）的 P0–P6，其 P1/P2 对应本文阶段 2，P3–P6 对应阶段 3。origin 上 IN-45~51 分支若已有实现，阶段 2 开工前先评审取舍。

## 目标架构

```
apps/cli（启动入口，薄）
  └── packages/edge-worker（编排层）
        ├── 接入层：linear / feishu / github 三个 transport，统一显式 implements IAgentEventTransport
        ├── 会话层：SessionStore（单一存储 owner）+ 每 session 串行队列 + channel 关联表
        ├── 平台层：LinearHandler / GitHubHandler / FeishuChatHandler（从 EdgeWorker 拆出）
        ├── 执行层：RunnerRegistry 注册的 claude / codex，统一自有 AgentMessage 模型
        └── 支撑层：PromptBuilder / GitService / ConfigManager / EgressProxy / PersistenceManager
```

EdgeWorker 最终只剩「装配 + 生命周期 + 事件分发骨架」，目标 < 2000 行。

## 阶段 0：删减清场

删除不再维护的表面，让后续每一步面对更小的代码面。

- 删包：`gemini-runner`、`cursor-runner`、`slack-event-transport`、`gitlab-event-transport`
- 连带清理：
  - core：`RunnerTypeSchema` 枚举、`geminiDefaultModel`/`cursorDefaultModel` 配置字段、`CyrusAgentSession.geminiSessionId/cursorSessionId`（含 PersistenceManager 序列化）
  - edge-worker：GitLab 处理（`EdgeWorker.ts:2278-2794` ~500 行）、`SlackChatAdapter`、注册函数、`RunnerSelectionService`/`RunnerConfigBuilder`/`AgentSessionManager` 的对应分支
  - apps/cli：env 变量（`CYRUS_GEMINI_DEFAULT_MODEL` 等）
  - skills：`cyrus-setup-slack`、`cyrus-setup-gitlab`；docs：`GIT_GITLAB.md`；CHANGELOG 如实记录 Removed
- 验收：每删一个包 `pnpm build && pnpm test:packages:run && pnpm typecheck` 全绿；F1 冒烟一次

## 阶段 1：基础契约整顿

1. **消息模型去 Claude 化**：core 定义自有 `AgentMessage`（assistant/user/result/tool_use/tool_result/system 六类判别联合），claude/codex 各写 adapter；消灭伪造 Claude 形状的 null 填充（gemini `adapters.ts:33-58` 式代码随包删除，cursor 同理）。
2. **transport 接口收口**：`AgentEventTransportConfig` 联合扩展到 linear/feishu/github，三个实现显式 `implements`；抽公共基类消化 4 份重复样板（proxy/direct 切换、Bearer 校验、eventId TTL 去重）；飞书 webhook/WS 共用一份跨路去重。
3. **ConfigManager schema 驱动**：整份配置走 Zod parse 后替换（或按 schema key 自动 diff），消灭硬编码合并白名单与 `globalKeys` 手工登记（根除此类静默失效事故）。
4. **RunnerRegistry**：`type → { factory, 默认/回退模型, sessionId 字段名, streaming 能力 }` 一张表，替代散落在 9 处的 switch/分支（`EdgeWorker.createRunnerForType`、resume 链、session-id 锚定、`constructor.name` 字符串判断等）。
5. **core 减肥**：F1 测试基建（CLI 适配器 ~3500 行）迁出 core（移到 `apps/f1` 或独立 `cli-testing` 包），fastify 依赖归位。

## 阶段 2：拆 EdgeWorker + 总线接管（= IN-42 P1/P2）

1. **平台 handler 抽取**：`LinearHandler`（webhook 分发 + session 创建/续接）、`GitHubHandler`（`EdgeWorker.ts:1504-2278` ~770 行搬走）；`FeishuChatAdapter` 减负——Linear issue 解析器（`extractCreatedLinearIssues`）移到 Linear 域、runner 路由移到 RunnerSelectionService。
2. **Session 存储收敛**：升级 `GlobalSessionRegistry` 为 IN-42 的 `SessionCorrelationRegistry`（session + channel 关联表 + child→parent），废弃 `AgentSessionManager.sessions` 与各 `ChatSessionHandler` 私有内存态；持久化改由单一 owner 输出。
3. **总线接管**：实现 `handleMessage` 的 5 个 TODO handler；先影子模式（bus 与 legacy 双跑、比对日志），确认一致后切主链路，legacy `event` 订阅降级为 fallback；飞书 translator 的 `sessionKey` 改为稳定的 `chatId:threadRoot`（IN-42 明确要求）。
4. 完成标志：`EdgeWorker.ts` < 2000 行，事件入口单一。

## 阶段 3：IN-42 核心价值（按需排期）

- P3 跨渠道注入：飞书线程 ⇄ Linear agent session 同一逻辑 session，每 session 串行队列，注入在 Linear timeline 留痕
- P4 过程回流：`FeishuBackflowSink` 里程碑级回流（节流 + 幂等 + 防回环）
- P5 权限与去重加固（`UserAccessControl` 补 open_id 维度；注入前仓库权限校验红线）
- P6 清理 legacy 链路

## 与 Mission Control 的关系（2026-07-23 追加）

产品目标已升级为「CLI + Web 协作平台」（见 `docs/design/PRODUCT-GOAL.md`）：同仓新建 `apps/mission-control` 作为多用户控制面，edge-worker 退化为纯执行面，两者通过 **Worker API**（Mission 下发 / Session 查询 / Session 事件流 SSE）通信。对本路线图的影响：

- 阶段 1（消息模型）与阶段 2（SessionStore 收敛、EdgeWorker 拆分）是 Worker API 的地基，Mission Control M2 排在其后
- 阶段 2 拆 EdgeWorker 时，把「Worker API 端点」作为与平台 handler 平级的独立模块预留出来
- Mission Control M1（骨架 + 飞书 OAuth + CRUD + 文档评审）不依赖 edge-worker，可与本路线图并行开工

## 贯穿纪律

- 每阶段结束：`pnpm test:packages:run` + `pnpm typecheck` + F1 test-drive（AGENTS.md 强制）+ CHANGELOG 更新
- 每阶段独立可回滚，单独 PR；prompt 组装测试保持全量断言
- 不顺手做范围外清理；发现新坑记入本 roadmap 附录
