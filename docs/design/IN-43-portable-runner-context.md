# 跨 Runner 通用「系统上下文 + 扩展/技能」配置设计

> Linear: [IN-43](https://linear.app/principle-intl/issue/IN-43)　·　状态：调研 + 方案（**先出文档，不落实现代码**）
> 关联：IN-42（统一 Session · 多 Channel）
> 来源：张博（Airbo ZH）飞书提出

## 0. TL;DR（先看结论）

- **现状**：系统上下文其实**已经有一个统一入口**——EdgeWorker 组装出一个 `systemPrompt` 字符串，`RunnerConfigBuilder` 把它塞进每个 runner config 的**同一个字段 `appendSystemPrompt`**，各 runner 再翻译成自己 CLI/SDK 的原生机制（Claude preset append / Codex `developer_instructions` / Gemini `GEMINI_SYSTEM_MD` 文件 / Cursor 前置拼进 user prompt）。技能也**已经有一层适配**——`skills` + `plugins` 两个中立字段，Claude 透传 SDK、Codex 用 `CodexSkillStager` 符号链接进 `.agents/skills/`。
- **真正不统一的是「文件载体」层**：`CLAUDE.md` / `AGENTS.md` / `GEMINI.md` 都**不是 Cyrus 读的**，而是各家 CLI/SDK 各自在 cwd 树里自动发现。切 runner 时，Cyrus 组装的 `appendSystemPrompt` 会带过去，但**各家自动发现的仓库内 memory 文件（`CLAUDE.md` vs `AGENTS.md`）互不相通**——这才是「切 agent 丢上下文」的根因。
- **提案**：不发明新运行时格式，而是定义一个中立的 **`context-bundle`**（系统上下文分层清单）+ 复用现有 `skills`/`plugins` 抽象，在 `RunnerConfigBuilder` 增加一层 **`ContextAdapter`**，把中立 bundle 渲染成各 runner 的原生载体（对 Claude 写/软链 `CLAUDE.md` 语义、对 Codex 写/软链 `AGENTS.md`、对 Gemini 并进 `GEMINI_SYSTEM_MD`）。技能沿用并补全 Gemini/Cursor 的降级路径。
- **切换保真**：会话历史保真由 IN-42 的统一 Session 负责（本文只负责「上下文/技能」保真）；系统上下文因为统一从 bundle 渲染，切 runner 天然一致；runner 独有能力（如某 runner 独有工具）无法平移的，走**显式降级 + 告知用户**。
- **飞书记忆**：`~/.cyrus/feishu-memory/` 是 **Claude SDK 原生 auto-memory** 按平台命名空间化，**建议保持独立子层**（跨会话持久记忆），但纳入统一 bundle 的「记忆层」抽象，以便未来给非 Claude runner 做降级。

---

## 1. 各 Runner 现状梳理（AC-1：逐 runner + 确切文件/符号引用）

### 1.1 系统上下文的统一入口与分发

**组装（一处）** — `packages/edge-worker/src/EdgeWorker.ts:6560-6596`：
1. `determineSystemPromptFromLabels()`（代理 `PromptBuilder.determineSystemPromptFromLabels`，`PromptBuilder.ts:82`）产出正文（label-based / `prompts/orchestrator.md` / `loadSharedInstructions()` fallback）。
2. 追加 `skillsPluginResolver.buildSkillsGuidance(...)`（`EdgeWorker.ts:6590`）。
3. 追加 `buildAgentContextBlock()`（`<agent_context>`，`EdgeWorker.ts:6596`）。

**分发（一处）** — `packages/edge-worker/src/RunnerConfigBuilder.ts`：
- issue 会话 `buildIssueConfig()` 在 `:484-486` 把上面的 `systemPrompt` 经 addendum 链（failure-mode / browser-use / cloud-runtime）包装后写入 **`config.appendSystemPrompt`**。
- chat 会话 `buildChatConfig()` 在 `:338-346` 同理（多一个 Feishu+Codex 的 Linear 路由 addendum）。
- 字段契约：`packages/core/src/agent-runner-types.ts:480` `appendSystemPrompt?: string`（**全 runner 共享的唯一系统指令字段**，语义为「追加到 runner 默认系统提示词」）。

> 注意：`<repository_routing_context>`（`PromptBuilder.ts:593` `generateRoutingContext`）进入的是 **userPrompt / issue-context**（`{{routing_context}}` 替换，`PromptBuilder.ts:455/495`），**不进 systemPrompt**。

### 1.2 各 runner 如何翻译 `appendSystemPrompt`

| Runner | 入口字段 | 底层机制（file:line） | 仓库内 memory 文件谁读 |
|---|---|---|---|
| **claude** | `systemPrompt`(替换) / `appendSystemPrompt`(追加) | SDK `query()` `options.systemPrompt = {type:"preset", preset:"claude_code", append}` — `ClaudeRunner.ts:696-702` | **Claude Code SDK 自动读 `CLAUDE.md`**，靠 `settingSources:["user","project","local"]`（`ClaudeRunner.ts:703-706`）；user/project/local 叠加顺序由 SDK 决定，**Cyrus 不拼** |
| **codex** | `appendSystemPrompt` → `developerInstructions` | `CodexConfigBuilder.ts:54-55` 映射为 `developerInstructions` → `AppServerCodexBackend.ts:249-251` 传 Codex `developer_instructions` | **Codex CLI 自己读 `AGENTS.md`**，仓库无任何引用 |
| **gemini** | `appendSystemPrompt` | 拼到内置 `prompts/system.md` 后落盘 `~/.cyrus/gemini-system-prompts/<ws>.md`，用 `GEMINI_SYSTEM_MD` 环境变量指向 — `GeminiRunner.ts:324-332` + `systemPromptManager.ts:31-52` | `GEMINI.md` 由 Gemini CLI 自读；Cyrus 只注入合成 system md |
| **cursor** | 无原生字段 | **丢弃 `appendSystemPrompt`**，把 system prompt 前置拼进 user prompt — `SimpleCursorRunner.ts:35-37` | 依赖 Cursor CLI 自身，Cyrus 不注入 |
| **simple-agent** | `systemPrompt` | 基类 `buildSystemPrompt()`（`SimpleAgentRunner.ts:150-166`）再分发到各底层 | 取决于底层 runner |

**关键结论**：`CLAUDE.md`/`AGENTS.md`/`GEMINI.md` 全靠各家 CLI/SDK **自动发现**，Cyrus 全仓库 grep 不到 `readFile(...CLAUDE.md)` / `AGENTS.md`。所以：
- Cyrus 组装的动态系统提示（`appendSystemPrompt`）**切 runner 会一致带过去**（除 Cursor 丢弃、改前置拼 prompt）。
- 仓库内**静态 memory 文件**（`CLAUDE.md` vs `AGENTS.md`）**互不相通**——切到 Codex 读不到 `CLAUDE.md`，切到 Claude 读不到 `AGENTS.md`。这是丢上下文的主因。
- 全局 `/root/.cyrus/CLAUDE.md`（硬约束、最高优先级）落在 Claude SDK 的 `user` scope 才会被拾取；**对 Codex/Gemini/Cursor 完全不可见**——这是最危险的丢失点（全局操作规程只有 Claude 看得到）。

### 1.3 技能（skills）现状

**中立抽象已存在**：`packages/core/src/agent-runner-types.ts` 上有两个跨 runner 字段——
- `plugins?: SdkPluginConfig[]`（`:513`）：提供技能的插件（`{type:"local", path}`）。
- `skills?: string[] | "all"`（`:525`）：作用域白名单。

**发现/解析** — `packages/edge-worker/src/SkillsPluginResolver.ts`：
- 两个插件源（都在 `~/.cyrus` 仓库外）：`user-skills-plugin`（CYHOST UI 管理，`:58-59`，**优先**）+ `cyrus-skills-plugin`（自带，`:57`）；`resolve()`（`:119-136`）用户覆盖内部。
- `discoverSkillNames()`（`:161-197`）：插件 `skills/` 目录名 ∪ 各参与仓库工作树的 `<repo>/.claude/skills/*`。
- 作用域过滤：每技能可带 `scope.json`（`repositoryIds`/`linearTeamIds`/`linearLabelIds`），`scopeMatches`（`:278-313`）按会话上下文过滤。
- `buildSkillsGuidance()`（`:324-351`）把技能名拼进系统提示 `## Skills` 段。

**门控** — `RunnerConfigBuilder.ts:573-575` `runnerSupportsManagedSkills()`：**只有 `claude` 和 `codex`**。`:495-502` 仅对支持的 runner 注入 `plugins`/`skills`。

**各 runner 技能能力**：
- **Claude**：原生 `Skill` 工具（`claude-runner/src/config.ts:42/94`）+ SDK `plugins`/`skills` 透传。
- **Codex**：无 Skill 工具，`CodexSkillStager`（`CodexSkillStager.ts:55-140`）把允许的技能**符号链接**进 `<cwd>/.agents/skills/<name>`，走 Codex 原生仓库发现，并把 `.agents/` 写进 git `info/exclude`。**这是「一份中立技能 → 适配到 runner 原生机制」的现成范本。**
- **Gemini / Cursor**：**不支持托管技能**（门控只放行 claude/codex）；只能收到系统提示里的文字 guidance，没有可调用工具或 staging。

**仓库内 canonical 技能同步** — `scripts/symlink-skills.sh`：`<repo>/skills/`（17 个，唯一源）→ 符号链接到 `.claude/skills`、`.codex/skills`、`.opencode/skills`（一份源 + 三份链接，**非两份副本**）。`.claude/skills` 额外含 harness 专属真实目录 `google/`、`release/`、`release-core-test/`。用户技能另一条路径：`config-updater/src/handlers/skills.ts` 把 CYHOST 传来的技能写成 `~/.cyrus/user-skills-plugin/skills/<name>/SKILL.md` + `scope.json`。

### 1.4 接入点评估（AC-2 前置）

| 接入点 | 职责 | 是否合适挂适配层 |
|---|---|---|
| `PromptBuilder`（`edge-worker/src/PromptBuilder.ts`） | 产出系统提示正文 + XML 上下文块 | ✅ **系统上下文正文来源**，中立 bundle 的「正文层」应在此汇聚 |
| `RunnerConfigBuilder`（`edge-worker/src/RunnerConfigBuilder.ts`） | 为 runnerType 组装 config、门控 skills/plugins/sandbox | ✅ **最佳适配接入点**：已是「中立输入 → runner 专有输出」的转换层（`appendSystemPrompt`/`skills`/`plugins`/`buildSandboxConfig` 都在这里按 runnerType 分叉） |
| `createRunnerForType`（`EdgeWorker.ts:5722`） | 纯 `switch(runnerType)` new 实例 | ❌ 仅实例化，不做上下文决策，不宜挂逻辑 |
| `RunnerSelectionService.determineRunnerSelection`（`RunnerSelectionService.ts:189`） | 裁决 runnerType/model（`[agent=]`/`[model=]`/label 优先级 `:366-371`） | ⭕ 适配层的**触发者**（知道"切成了哪个 runner"），但不承载渲染逻辑 |

---

## 2. 中立「系统上下文 + 扩展」Schema 提案（AC-2）

### 2.1 分层模型

把「系统上下文」拆成**四层**，优先级从高到低（高层覆盖/前置于低层）：

```
context-bundle (会话级组装结果)
├── L0 global      全局硬约束     /root/.cyrus/CLAUDE.md（最高优先级，硬约束）
├── L1 workspace   工作区/团队级   label-based prompt、orchestrator.md、shared-instructions
├── L2 repo        仓库级         仓库内 memory 文件（CLAUDE.md/AGENTS.md 的中立源）
└── L3 session     会话级动态     routing-context、agent-context、addendums（failure-mode 等）
```

配套的**扩展层**（复用现有抽象，不新造）：

```
extensions
├── skills    string[] | "all"        （已有：core agent-runner-types.ts:525）
└── plugins   SdkPluginConfig[]        （已有：core agent-runner-types.ts:513）
```

### 2.2 中立 schema（`SystemContextBundle`）

新增一个**纯数据**中立类型（放 `packages/core`），描述"要注入什么"，不含任何 runner 语义：

```ts
// packages/core/src/system-context-types.ts  （提案，非本次实现）
export interface ContextLayer {
  /** 稳定标识，用于日志/降级提示，如 "global", "workspace:orchestrator", "repo:CLAUDE.md" */
  id: string;
  /** 层级，决定叠加顺序 */
  level: "global" | "workspace" | "repo" | "session";
  /** 正文内容（已渲染成纯文本/markdown） */
  content: string;
  /** 是否为硬约束（渲染时必须无损保留，不允许被长度截断丢弃） */
  hard?: boolean;
  /** 来源提示（文件路径或合成来源），用于可观测性 */
  source?: string;
}

export interface SystemContextBundle {
  layers: ContextLayer[];               // 已按优先级排序（global → session）
  skills: string[] | "all" | undefined; // 复用现有语义
  plugins: SdkPluginConfig[];           // 复用现有语义
  memory?: { directory: string };       // 见 §5，跨会话记忆层
}
```

要点：
- **一份 bundle，多 runner 渲染**——bundle 本身零 runner 依赖。
- `layers` 已排序 + 带 `hard` 标记，让适配层能在遇到长度限制时**优先保留硬约束**（全局规程绝不截断）。
- `skills`/`plugins`/`memory` 直接复用现有字段，零迁移成本。

### 2.3 Runner 适配层（`ContextAdapter`）

在 `RunnerConfigBuilder` 内新增一个按 runnerType 分派的适配接口：

```ts
// packages/edge-worker/src/context-adapters/ContextAdapter.ts （提案）
export interface ContextAdapter {
  readonly runnerType: RunnerType;
  /** 把中立 bundle 渲染进该 runner 的 config（就地补 appendSystemPrompt/skills/plugins/文件） */
  apply(bundle: SystemContextBundle, config: AgentRunnerConfig, ctx: AdapterContext): AdapterReport;
}

export interface AdapterReport {
  /** 无法平移、已降级的能力，用于告知用户 */
  degraded: Array<{ what: string; reason: string; fallback: string }>;
}
```

每 runner 的渲染策略：

| Runner | 正文层渲染 | 静态 repo 层 | 技能 | 降级点 |
|---|---|---|---|---|
| **claude** | 拼进 `appendSystemPrompt`（现状） | 保持 SDK 自动读 `CLAUDE.md`；`settingSources` 已开 user/project/local | `plugins`+`skills` 透传 SDK（现状） | 无 |
| **codex** | 拼进 `appendSystemPrompt`→`developer_instructions`（现状） | **新增**：把 L0/L2 渲染成 `AGENTS.md` 语义（写临时 `AGENTS.md` 或把全局规程并进 `developer_instructions`） | `CodexSkillStager` 软链（现状） | 无（技能已有等效） |
| **gemini** | 拼进合成 `GEMINI_SYSTEM_MD`（现状） | **新增**：把 L0/L2 并进合成 system md | **降级**：无托管技能 → 把技能清单 + 关键 SKILL.md 摘要写进 system md 文字 guidance | 技能不可调用（仅文字） |
| **cursor** | **修复**：不再丢弃，前置拼进 prompt 或写 `.cursor` 规则文件 | **新增**：同上并进前置 | **降级**：同 Gemini | system prompt 无独立通道 + 技能不可调用 |

**核心修复项**（现状 bug 级）：
1. **全局规程可见性**：`/root/.cyrus/CLAUDE.md`（L0，硬约束）目前**只有 Claude 看得到**。适配层必须把 L0 强制并进**每个** runner 的正文通道（Codex 的 `developer_instructions`、Gemini 的合成 md、Cursor 的前置）。这是安全/合规红线。
2. **Cursor 丢弃系统提示**：`SimpleCursorRunner.ts:35-37` 目前丢 `appendSystemPrompt`、只在 simple 路径前置。issue 会话路径 Cursor 根本不消费该字段——需补齐。

### 2.4 接入点落位（回答 AC-2）

```
PromptBuilder（产出 L1/L3 正文 + XML 块）
        │
        ├─► [新] ContextBundleAssembler  收集 L0(全局CLAUDE.md) + L1 + L2(仓库memory) + L3
        │          输出 SystemContextBundle（中立、已排序、带 hard 标记）
        ▼
RunnerConfigBuilder.buildIssueConfig / buildChatConfig
        │   runnerType = RunnerSelectionService.determineRunnerSelection(...)
        │
        ├─► [新] ContextAdapterRegistry.get(runnerType).apply(bundle, config)
        │          渲染进 config.appendSystemPrompt / skills / plugins /（Codex/Gemini 文件）
        │          返回 AdapterReport.degraded
        ▼
createRunnerForType(runnerType, config)  →  new XxxRunner(config)
        │
        └─► degraded 非空 → 通过 ActivityPoster 在 Linear timeline 告知用户（见 §3.3）
```

新增两个类，**不改** `createRunnerForType`/`RunnerSelectionService` 的职责边界。

---

## 3. 切换保真与降级策略（AC-3）

### 3.1 三类要保真的东西，谁负责

| 保真对象 | 负责方 | 本设计如何保证 |
|---|---|---|
| **系统上下文**（提示词/规程） | **本设计** | 统一从 `SystemContextBundle` 渲染，切 runner 只是换 `ContextAdapter`，正文同源 → 天然一致；L0 硬约束强制注入每个 runner |
| **已加载技能** | **本设计** | `skills`+`plugins` 中立字段全 runner 复用；Claude/Codex 有等效机制，Gemini/Cursor 降级为文字 guidance（见 §3.2） |
| **会话历史 / 记忆** | **IN-42（统一 Session）** + §5 记忆层 | 本设计不重复实现历史搬运；只保证 `memory.directory` 在 bundle 里、切 runner 时（若目标 runner 支持）继续指向同一目录 |

### 3.2 切换时机（回答冲突点：turn 间 vs turn 中途）

- **只允许 turn 之间切 runner**，不允许 turn 中途切。理由：turn 中途各 runner 的内部工具调用状态、流式缓冲不可平移；`RunnerConfigBuilder` 已有「会话续跑一致性」保护（`:405-425`：已存在 `claudeSessionId`/`codexSessionId` 等冲突时强制沿用旧 runner），本设计与之对齐——**切 runner 发生在新 turn 组装 config 时**，由 `[agent=]`/label 触发，走完整 bundle→adapter 重渲染。
- turn 之间切时，历史由 IN-42 统一 Session 提供；上下文由 bundle 重新对新 runner 渲染，保证"新 runner 一上来就带着全部系统上下文 + 可见技能清单"。

### 3.3 runner 独有能力无法平移 → 显式降级 + 告知

`AdapterReport.degraded` 收集降级项，切换完成后由 `ActivityPoster`（`edge-worker/src/ActivityPoster.ts`，已负责路由活动上报）在 Linear timeline 落一条活动，例如：

> ⚠️ 已从 **Claude** 切换到 **Gemini**。以下能力降级：
> - 托管技能（investigate / debug…）：Gemini 无 Skill 工具，已改为在系统提示中提供技能清单与摘要，模型可参考但无法一键调用。
> - 全局操作规程（/root/.cyrus/CLAUDE.md）：已并入 Gemini 系统提示，保真。

降级矩阵（哪些能力 runner 特有）：

| 能力 | claude | codex | gemini | cursor | 无法平移时的降级 |
|---|---|---|---|---|---|
| 动态系统提示 | ✅ append | ✅ dev_instructions | ✅ GEMINI_SYSTEM_MD | ⚠️ 前置 prompt | Cursor 补前置/规则文件 |
| 仓库 memory 文件 | ✅ CLAUDE.md | ✅ AGENTS.md | ⚠️ GEMINI.md | ❌ | 适配层显式写对应文件 |
| 全局硬约束(L0) | ✅ user scope | ❌→修复 | ❌→修复 | ❌→修复 | **强制并进正文，红线** |
| 托管技能(可调用) | ✅ Skill 工具 | ✅ .agents/skills 软链 | ❌ | ❌ | 降级为文字 guidance + 告知 |
| 跨会话记忆 | ✅ auto-memory | ❌ | ❌ | ❌ | 见 §5，告知记忆只读/不写 |

### 3.4 逐条处理「冲突点/难点」（AC-3）

1. **格式与长度限制不同（CLAUDE.md vs AGENTS.md 语义差异，信息损失）**：bundle 用**纯 markdown 正文 + `hard` 标记**做中立表示；适配层渲染时若触发目标 runner 长度上限，**按 level 从低到高（先砍 L3 会话级、再 L2，永不砍 `hard`）**做有损压缩，并在 `degraded` 里记录被压缩的层。避免"整段丢"。
2. **技能机制差异（Claude Skill 工具 vs Codex 能力暴露，可能一一对应不上）**：已由现有 `skills`/`plugins` + `CodexSkillStager` 证明 Claude↔Codex 可等效；Gemini/Cursor 无机制 → 统一降级为「技能清单 + 关键 SKILL.md 摘要」写进系统提示，并明确告知不可一键调用。
3. **全局 vs 仓库级 vs 会话级叠加与优先级**：由 bundle 的 `level` 显式建模（global > workspace > repo > session 的覆盖/前置顺序），**Cyrus 自己掌控叠加顺序**，不再把叠加语义完全外包给各家 SDK 的自动发现（现状 Claude 的 user/project/local 顺序对其它 runner 不可复现）。L0 全局规程 `hard:true`，永远在最前、永不截断。
4. **切换时机（turn 间 vs turn 中途 + 历史带过去）**：见 §3.2——只 turn 间切，历史交 IN-42，上下文重渲染。

---

## 4. 与 PromptBuilder / 现有链路的兼容

- **渐进式**：`SystemContextBundle` 的 `layers` 可先只装现有 `systemPrompt`（一层），`ContextAdapter` 对 Claude 就是恒等变换（现状行为不变），先跑通 Codex/Gemini/Cursor 的 L0 注入与降级上报，再逐步把 L2 仓库 memory 纳入。
- **不破坏现有路由自描述**：按 CLAUDE.md 开发注记第 8 条，若改动路由自描述需同步更新 `PromptBuilder.ts` / `SlackChatAdapter.ts` / `ActivityPoster.ts`——本设计新增的是「上下文渲染」而非路由语义，路由自描述不变；但 §3.3 的降级告知落在 `ActivityPoster`，需在那里加一种活动类型。

---

## 5. 与飞书记忆的关系（AC-4）

**现状**：`~/.cyrus/feishu-memory/` 是 **Claude Agent SDK 原生 auto-memory** 按平台命名空间化，代码里无 `feishu-memory` 字面量（模板拼出）：
- `RunnerConfigBuilder.ts:305-311`：`autoMemoryDirectory = join(cyrusHome, ${platformName}-memory)`；`platformName="feishu"`（`FeishuChatAdapter.ts:83`）→ `~/.cyrus/feishu-memory`。同时并入 `allowedDirectories`（`:329-337`）。
- `ClaudeRunner.ts:747-751`：仅当 `config.autoMemoryDirectory` 存在时透传 SDK `settings.autoMemoryDirectory`，**读写/注入由 SDK 负责**（自动维护 `MEMORY.md` + 记忆文件）。
- **Claude 专属**：codex/gemini/cursor runner 均不消费 `autoMemoryDirectory`。飞书会话若走 Codex/Gemini，**当前没有共享记忆**。

**建议**：
- **保持为独立子层**（放进 bundle 的 `memory` 字段，而非揉进 L0-L3 正文层）。理由：auto-memory 是**跨会话可读写的持久存储**，语义与「本次会话注入的静态上下文」不同——它会被 agent 主动写入、跨线程累积，不该每次全量拼进 system prompt。
- **纳入统一抽象以便降级**：`SystemContextBundle.memory.directory` 作为中立字段，适配层决定：
  - Claude → 透传 `autoMemoryDirectory`（现状）。
  - Codex/Gemini/Cursor（暂无原生 auto-memory）→ **降级方案**：把 `MEMORY.md` 索引 + 相关记忆文件作为**只读**上下文，在 turn 开始时读入并作为一个 `repo`/`session` 级 layer 注入正文（标注"记忆为只读，本 runner 无法写回"），并在 `degraded` 告知用户。这样切到非 Claude runner 至少**不丢历史记忆的读**，只是失去写回能力。
- **与全局 CLAUDE.md 区分**：全局 `/root/.cyrus/CLAUDE.md` 是**静态硬约束**（L0，人工维护、每会话只读注入）；feishu-memory 是**动态持久记忆**（agent 读写、跨会话累积）。二者都属于「系统上下文」大层，但一个是 `hard` layer、一个是 `memory` 子层，不混。

---

## 6. 分阶段落地建议（AC-4）

> 全部为**后续实现**建议，本 issue 只交付本设计文档。

- **Phase 0（红线修复，最高优先，小改动）**
  - 让 L0 全局 `/root/.cyrus/CLAUDE.md` 对 **Codex/Gemini/Cursor** 可见：在 `RunnerConfigBuilder` 读取全局规程并强制并进各 runner 的正文通道（Codex `developer_instructions` / Gemini 合成 md / Cursor 前置）。
  - 修复 Cursor issue 会话丢弃 `appendSystemPrompt`（`SimpleCursorRunner.ts:35-37` 路径 + issue 路径）。
  - 价值：立刻消除"切到非 Claude 就丢全局操作规程"的合规风险，无需引入完整 schema。

- **Phase 1（中立 schema + 适配骨架）**
  - 在 `packages/core` 落 `SystemContextBundle`/`ContextLayer` 类型；`RunnerConfigBuilder` 增 `ContextBundleAssembler` + `ContextAdapterRegistry`；Claude adapter 做恒等（行为不变）作为回归基线。
  - 单测：同一 bundle 渲染到四个 runner，断言 L0 硬约束在每个 runner 的正文里、顺序正确、长度压缩优先砍低层。

- **Phase 2（技能降级 + 记忆只读平移）**
  - Gemini/Cursor 技能降级为文字 guidance（清单 + SKILL.md 摘要）。
  - 非 Claude runner 的 feishu-memory 只读注入 + `degraded` 告知。

- **Phase 3（切换保真联调，配合 IN-42）**
  - 与统一 Session 对接：turn 间切 runner 时，历史来自 IN-42、上下文由 bundle 重渲染；`AdapterReport.degraded` 经 `ActivityPoster` 上报 Linear。
  - F1 test drive 覆盖：`[agent=]` 切换场景、降级告知可见性、L0 在各 runner 保真。

- **Phase 4（可选，静态 memory 文件统一源）**
  - 探索用一份中立仓库 memory（如 `.agent/context.md`）作为 L2 唯一源，适配层为各 runner 生成/软链 `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`，彻底消除"仓库内 memory 文件互不相通"。风险：与各家自动发现约定的兼容性需逐一验证，故置于最后。

---

## 7. 关键文件/符号索引（便于评审复核）

- 系统提示组装：`packages/edge-worker/src/EdgeWorker.ts:6560-6596`（`buildSkillsGuidance` 6590 / `buildAgentContextBlock` 6596）
- 分发 `appendSystemPrompt`：`packages/edge-worker/src/RunnerConfigBuilder.ts:484-486`（issue）/`:338-346`（chat）
- 共享字段契约：`packages/core/src/agent-runner-types.ts:480`(appendSystemPrompt)/`:513`(plugins)/`:525`(skills)/`:496-502`(autoMemoryDirectory)
- Claude 注入：`packages/claude-runner/src/ClaudeRunner.ts:696-706`(system+settingSources)/`:747-751`(autoMemory)
- Codex 注入：`packages/codex-runner/src/config/CodexConfigBuilder.ts:54-55` + `backend/AppServerCodexBackend.ts:249-251`
- Gemini 注入：`packages/gemini-runner/src/GeminiRunner.ts:324-332` + `systemPromptManager.ts:31-52`
- Cursor 注入：`packages/cursor-runner/src/SimpleCursorRunner.ts:35-37`
- 技能解析/作用域：`packages/edge-worker/src/SkillsPluginResolver.ts:119-136/161-197/278-313/324-351`
- 技能门控：`packages/edge-worker/src/RunnerConfigBuilder.ts:495-502/573-575`
- Codex 技能 staging：`packages/codex-runner/src/CodexSkillStager.ts:55-140` + `CodexRunner.ts:65/164/260`
- 技能同步：`scripts/symlink-skills.sh`；用户技能写入：`packages/config-updater/src/handlers/skills.ts`
- runner 裁决/优先级：`packages/edge-worker/src/RunnerSelectionService.ts:189/366-371`；repo 路由：`RepositoryRouter.ts:141-149`
- 实例化：`packages/edge-worker/src/EdgeWorker.ts:5722`(createRunnerForType)
- 飞书记忆：`RunnerConfigBuilder.ts:305-337` + `FeishuChatAdapter.ts:83` + `ClaudeRunner.ts:747-751`
