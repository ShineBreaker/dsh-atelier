# atelier → dsh 插件移植计划（dsh-atelier）

> **补记（2026-10-19）**：移植已完成并实测；落地与本文的一处偏差——主工具名
> 由计划的 `subagent` 改为 **`peer`**，与 dsh 原生 subagent 互补共存而非遮蔽
> （决策与机制存档见 ../AGENTS.md）。下文凡写 `subagent` 工具处即指 `peer` 工具。

> 状态：**可行性已验证，待执行**。本文档自包含：评估结论、资产盘点、API 映射、
> 分阶段执行计划、风险与验证标准，可直接交予第三方 agent 独立评估或执行。
>
> 调查日期：2026-10-15。调查环境：dsh 0.2.0-rc.2（CLI 树经 pnpm store 于
> `~/.local/share/agents/dsh`，运行时 home 为 `~/.local/share/dsh`）、
> Node v24.18.0、herdr 0.9.4。
>
> 复审记录（2026-10-15，同一环境逐条对源核对）：修正 §2 论据（补
> dsh-agent-extensions 移植先例、dsh-jobs 三件套组合）、§3.1（`.ts`
> 原样复制的 type stripping 前提、herdr 0.9.4 命令面核对）、§3.2（补
> typebox schema 迁移遗漏、frontmatter/node:sqlite 实测）、§4（subagent
> 嗅探映射纠错、dsh-tool-jobs 通知机制纠偏）、§5.1/§5.2（manifest 双
> 版本字段、peer 目录与配置根路径、TOML 表述）、§6（Phase 0 补 TOML
> 探针、Phase 1/3/5 同步）、§7（部署形态补对照实证、semver 字段分离、
> structor 错位修正）。所有「实证来源」列的本机核对路径见 §10。

---

## 1 目标

把 atelier（当前形态：pi 扩展，`pi-atelier`）重写为 dsh（DeepSeek Harness）
插件，保留全部核心能力。**重点保留项：经 herdr 多路复用器调用其他 CLI
harness（claude/codex/hermes/pi/mcode/任意 TUI agent）的能力**——分屏 pane
编排、外部 harness 路由链、文件契约、持久 peer + harness 原生 resume。

非目标：不做 dsh 原生 subagent（进程内 spawn/fork）的替代品；不重写
harness 适配层；不改 Return Header 协议与模型时段 DSL。

## 2 可行性结论

**可行，无硬阻塞。** 三条核心论据（均有源码/实证支撑）：

1. **herdr 调用链完全 harness 无关。** `runtime/multiplexer/` 全层
   （`herdr.ts`/`tmux.ts`/`detect.ts`/`types.ts`）只依赖
   `node:child_process` 的 `execFileSync("herdr", args)` 与环境变量检测
   （`HERDR_ENV=1`/`$TMUX`），零 pi import。dsh 插件运行在宿主 Node 进程，
   `spawnSync` 调 CLI 已被用户自己的 dsh-agenote 插件实证（TTL 缓存控制
   下的周期性 `spawnSync("agenote", ...)`，非裸每轮）。herdr 层可原样搬迁，
   行为不变。
2. **dsh 宿主 API 与 atelier 依赖的 pi API 几乎一一对应**，且有两层现成
   实证：(a) dsh-agenote 存在 pi 版（agenote-pi）与 dsh 版对照，
   `sendUserMessage`/`systemPrompt` 注入/命令注册等通道已完成过一次移植
   验证（agenote 卡片 20260921-113519「dsh plugin 行为治理」，合并自
   20260919-234709「DSH 插件注入通道选型」）；
   (b) 本机 `$DSH_HOME/profiles/agent-extensions/`（包名
   `dsh-agent-extensions`）就是「pi/omp 扩展 → dsh bundle」的完整移植
   实例：gate（命令/文件策略）、global-context（system-prompt 注入）、
   lifecycle 三半边 + web client half（`dsh.client` 声明），其 index.js 的
   `inject`/`apply(ctx, config)` 分层与 cordis.patch.yml 挂载形态可直接
   照搬。
3. **dsh 提供了比 pi 更贴切的宿主机制**：`dsh-jobs` 后台任务注册表
   （`<kind>-N` 稳定 id、`readAt` 不消耗读取、带超时等待结算、按 agent
   会话归属隔离）正好覆盖 atelier 的 monitor 轮询外壳；其结算通知由
   `dsh-tool-jobs` 自动投递（繁忙 agent 注入下一步、空闲 agent 由 follow-up
   轮次唤醒），取代 atelier 自建的「完成 → sendUserMessage」推送。注意
   dsh-jobs 只是抽象约定，进程内实现需 `dsh-jobs-local`，模型侧工具与
   通知投递需 `dsh-tool-jobs`（§4、§6 Phase 3）。pi 版的 `PI_SUBAGENT`
   env 嗅探在 dsh 侧无需对应物，理由见 §4 映射表该行。

## 3 现状资产盘点

### 3.1 可原样搬迁（约占代码量 70%）

| 资产 | 位置 | 搬迁方式 |
| --- | --- | --- |
| herdr/tmux 多路复用器后端 | `runtime/multiplexer/` | 原样复制，零改动（但为 `.ts` 文件、78 处相对 import 带 `.ts` 后缀，运行前提见下注） |
| harness spec（TOML）+ 适配器 + 路由链 | `runtime/harness/`、`context/harnesses.toml` | 原样复制（`spec.ts` 的 `getAgentDir` 依赖见 §3.2） |
| 模型时段 DSL | `core/schedule.ts` | 原样复制 |
| 类型 | `core/types.ts` | 原样复制（`core/schemas.ts` 含 typebox 参数定义，已移入 §3.2 改写清单） |
| 纯逻辑工具 | `runtime/formatting.ts`、`runtime/session-log.ts`、`runtime/workfile.ts` | 原样复制 |
| 长程生命周期 | `lifecycle/`（checkpoint/workflow/resume） | 逻辑复制，持久化路径适配 dsh 数据目录 |
| Return Header 协议 | `registry/return-header.ts` | 原样复制 |
| agent/prompt markdown 资产 | `context/agents/*.md`（8 个）、`context/prompts/*.md`（7 个） | 原样复制；可选后续转为 dsh skill（`dsh-skill` 机制存在） |
| monitor 判定逻辑 | `runtime/monitor.ts`（status.json 终态 + herdr `agent get` 状态 + transcript 稳定性启发） | 逻辑复制，等待外壳适配 dsh-jobs（§4） |

> **`.ts` 原样复制的运行前提（本机实测）**：Node ≥23.6 起默认启用 type
> stripping，无需 flag 即可 `import "./x.ts"`（本机 Node v24.18.0 实测通过
> ——interface/类型注解直接跑）。atelier 源码已核无不可擦除语法
> （enum/namespace/参数属性/decorator 零命中），故「原样复制」= 保留 `.ts`
> 后缀与 78 处 `.ts` import 不动，靠宿主 stripping 运行，不引入构建步骤。
> 这与 §5.1「纯 JS ESM、零构建」不矛盾：新写的宿主胶法层用 `.js`，搬迁的
> 纯逻辑层保留 `.ts`。dsh 宿主 Node 版本下限须 ≥23.6（与 §7.2 engines
> 联动）；若目标 profile 跑在更旧 Node 上，则退路是机械剥离类型转 `.js`。
> herdr CLI 版本兼容已核：本机 herdr 0.9.4 的子命令集
> （`pane split/run/get/close/rename/send-keys`、`agent get`）与 herdr.ts
> 调用面完全一致；`parsePaneId` 解析的 split JSON 形状注释标称 v0.7.5，
> Phase 1 需对 0.9.x 实测复核。

### 3.2 需适配改写（约 20%）

| 资产 | 位置 | 改动内容 |
| --- | --- | --- |
| 插件入口层 | `index.ts`（1714 行中的框架部分） | pi 扩展 API → dsh 插件 API（`apply`/`inject`/`Config`/`ctx.*`），§4 逐项映射 |
| 工具参数 schema | `core/schemas.ts`（typebox `Type.Object` 定义 `SubagentParams`） | typebox → dsh-tools 自带 schema DSL（`{type, required, description}` 字面量，支持 string/number/integer/boolean/null/array/object/json/oneOf）；**原盘点遗漏，工作量集中在此一个 schema** |
| 配置加载 | `core/config.ts` | 去 `getAgentDir` 依赖；atelier.json 文件配置保留为「单一真相源」，cordis config 行覆盖（dsh-agenote `sharedConfig()` 先例） |
| SQLite registry | `registry/registry.ts` | `bun:sqlite` → `node:sqlite`（Node ≥23.4 起免 flag；本机 Node v24.18.0 实测 `exec`/`prepare().run/all/get`/`PRAGMA user_version` 与 bun 版子集一致）。**边界**：已核 registry.ts 全部使用匿名 `?` 占位符（`?N` 编号参数零命中），不触发 node:sqlite 的已知差异——`?N` 只接受对象绑定、位置数组绑定报 column index out of range（agenote 20260930-204445）；迁移时不得引入 `?N` |
| frontmatter 解析 | `core/discovery.ts` | `parseFrontmatter` 仅 agent 发现一处调用；同文件已有自实现 `parsePromptFrontmatter`（跳过 SPDX 注释块）可扩展复用，工作量小 |
| 路径解析 | `core/context.ts`、`runtime/runner.ts`、`runtime/harness/spec.ts` | `getAgentDir` → dsh workspace/XDG 路径解析 |

### 3.3 需重写或降级（约 10%）

| 资产 | 位置 | 处置 |
| --- | --- --- |
| TUI 设置面板 | `ui/config-panel.ts`（pi `SettingsList`） | dsh 无 TUI 对应物。**降级**：配置走 cordis.yml（HMR 热替换）；web GUI 贡献列为后置可选——`@deepseek-ai/dsh-client-ui-settings` 包存在于本机 dsh 安装，且 `dsh-agent-extensions` 已示范 client half 挂载形态（`dsh.client` 声明 + 裸包名 patch 行），路径真实存在但非本次范围 |
| plan review gate | `index.ts` `tool_call` 拦 `plannotator_submit_plan` | dsh-plan-mode 有稳定 exit 工具 + `plan:policy` section；gate 改挂 `tools/pre-execute` 或包装该工具 |
| 一次性上下文注入 | `index.ts` `appendEntry` 标记 + `before_agent_start` 消费 | dsh 无 appendEntry 等价物；任务指令直接走 `agent.followup()`（语义本就正确），「已做过 X」判定从 durable log 推导 |

## 4 pi → dsh API 映射表

| atelier（pi） | dsh 等价物 | 实证来源 |
| --- | --- | --- |
| `pi.registerTool(defineTool)` | `ctx.tools.register(defineTool({name, description, parameters, output, execute}))`；schema 自动进 system prompt；策略 allow/deny/ask 门禁；`exec.signal` 协作式取消；工具超时 | `@deepseek-ai/dsh-tools` README.zh + 源码（0.2.0-rc.2） |
| `pi.registerCommand` | `ctx.commands.register({definitionId, name, description, handler})`，handler 返回 `{kind:"success"\|"error", text}` | dsh-agenote `commands.js` |
| `pi.on("before_agent_start")` 注入 | 背景知识 → `ctx.systemPrompt.section({name, order, interpolate, text})`；请求级 → `agent/pre-step` waterfall | dsh-agenote `hooks.js` + agenote 卡片 |
| `pi.sendUserMessage`（异步推送） | `agent.followup(createUserMessage({content:[{type:"text",text}], source:{kind:"plugin:<名>"}}))` | dsh-agenote 实证；注意 followup 会唤醒 driver——背景知识必须走 systemPrompt.section（agenote 20260921-113519） |
| `pi.appendEntry` 隐藏标记 | durable log 推导：扫 `session.surface.nodes` 找 `source.plugin`/`source.kind` 匹配项 | agenote 卡片（内存标记活不过 resume/clear/compact，durable log 是单一真相源） |
| `pi.on("tool_call")` | `tools/pre-execute`（可重排门禁）/ `tools/post-execute` / `tools/result` | dsh-tools README |
| `ctx.mode === "tui"` | 无对应；配置改 cordis 托管 | §3.3 |
| `bun:sqlite` | `node:sqlite` | 本机 Node v24.18.0 实测免 flag、API 子集一致（§3.2） |
| `@earendil-works/pi-coding-agent`（`getAgentDir`/`parseFrontmatter`） | 自实现 | 依赖集中于 7 文件，已枚举（§3.2） |
| subagent 嗅探（`PI_SUBAGENT` env，peer.ts wrapper 导出） | **无需对应物**。pi 版用途是防递归：被派生的 peer 是另一个 pi 进程、也会加载 atelier，靠 env 阻止其重复注册工具/命令。dsh-atelier 的 peer 是外部 CLI（claude/codex/hermes…），不加载本插件，递归链条不存在。`session.header.origin === 'subagent'`（dsh-session `SessionHeader` 持久化字段，注意其注释自述「presentation metadata, not proof that the child is continuable」）另有用途：本插件若被 dsh 原生 subagent 派生加载，可据此降级（跳过 UI 强相关初始化），属可选加固 |
| monitor 轮询 + 推送解耦 | **dsh-jobs 家族**：`<kind>-N` 稳定 id、`readAt` 不消耗、带超时等待结算、agent 会话归属隔离。最小组合三件套——`@deepseek-ai/dsh-jobs`（抽象约定，直接加载会抛异常）+ `dsh-jobs-local`（进程内注册表实现）+ `dsh-tool-jobs`（`job_output`/`job_list`/`job_kill` 工具与**结算通知自动投递**）。monitor 的 status.json/`herdr agent get`/transcript 三段判定逻辑原样保留为 job producer 的 `run()` 循环 | `@deepseek-ai/dsh-jobs` README.zh + `dsh-tool-jobs` README.zh |
| peer 完成 → 主会话推送 | **默认无需自行推送**：`dsh-tool-jobs` 在 job 结算时自动投递会话内通知 `background job <id> (<kind>: <label>) finished [status: ...]. Read its output with job_output.`——繁忙 agent 在下一步收到注入，空闲 agent 由 follow-up 轮次唤醒（`completionDelivery: wakeup`，可设 `quiet`）。模型已 `wait` 收走的结算不再通知（`awaited` 语义）。result 全文经 `job_output` 读取携带（结算后第一次读取带 result），不在通知里。`agent.followup()` 仅保留给非 job 路径的显式投递（如 `/<agent>` 命令） | `dsh-tool-jobs` README.zh（「完成通知」节）+ dsh-agenote 实证 |

## 5 目标架构

### 5.1 插件形态

- **零构建**：新写宿主胶法层用 `.js`（与 dsh 生态一致：dsh-agenote、
  dsh-agent-extensions 均纯 JS ESM）；搬迁的纯逻辑层保留 `.ts` 原样，
  靠 Node ≥23.6 默认 type stripping 运行（§3.1 注，本机实测）。
- **manifest**（package.json，字段值照 dsh-agenote 实证）：
  `peerDependencies: {"@deepseek-ai/dsh": "^0.2.0-rc.2"}` +
  `peerDependenciesMeta.optional` + `dsh.manifestVersion: 1` +
  `dsh.bundle.patch`（指向 cordis.patch.yml）；`dsh.engines.dsh` 与 peer
  范围是两个独立字段，dsh-agenote 实证值为 engines `">=0.2.0-rc.2"`、
  peer `^0.2.0-rc.2`（§7.2）。
- **入口分层**：`index.js`（`name`/`inject`/`apply`）→ 半边模块（peer
  生命周期 / tools / commands / hooks）。Config 有两种先例按需选：
  (a) 最简——dsh-agent-extensions 式无 schema，`apply(ctx, config = {})`
   手写默认值；
  (b) 校验——dsh-agenote 式 Standard Schema 手搓子集（`Config["~standard"]
  .validate`，加载期 fail loudly）。**不 import schemastery**：git/tarball
   形态下虽可解析，但 dsh-agenote 因 `link:` 而手搓的先例说明该依赖在
   部署形态变动时会再次咬人，schema 字段少时手搓更稳（§7.1）。
- **安装形态**：git/tarball 进 profile 依赖树（**不用 `link:`**，理由见 §7）。
  `dsh plugin --profile <name> add <git-url|tarball>` 经 pnpm 装到
  `$DSH_HOME/profiles/<name>/node_modules`（dsh CLI README 实证）。git
  spec 零门槛的前提是包无 prepare/build 脚本——纯 JS 插件不走 pnpm
  allowBuilds 审查（agenote 20260921-113519、20260927-014929 实证）；
  若引第三方依赖需逐个评估。版本精度由 pnpm-workspace.yaml 的
  `saveExact: true` 统一保证（该配置作用于 `dsh plugin add` 转发的
  子进程，agenote 20260921-113519）。
  源码仓库建议落在 `~/Projects/dsh-atelier`（与 `~/Projects/agenote/dsh-agenote`
  同级的独立仓库）；也可与 pi 版共用仓库多入口（见 §9 决策 2）。

### 5.2 关键机制在 dsh 上的落点

| atelier 机制 | dsh 落点 |
| --- | --- |
| `subagent` 工具（派发 single/tasks/chain + action send/wait/read/peers/close） | `ctx.tools.register` 注册 `subagent` 主工具；execute 内驱动 peer.ts 生命周期 |
| peer 目录文件契约（`brief-N.md`/`result-N.md`/`status.json`） | 不变，落点建议 `$XDG_CACHE_HOME/dsh-atelier/subagents/`（现状 `resolveXdgCache()` 已尊重 `XDG_CACHE_HOME`；DSH 自身 storages 不承载此类数据，不混入） |
| monitor 等待（`waitForPeerMessage`） | dsh-jobs 注册长任务（producer 的 `run()` 内跑原轮询循环）；status.json 终态 + `herdr agent get` + transcript 稳定性三段判定逻辑原样保留为 job 结算判据 |
| 异步推送（缺省非 wait:true 后台执行 + 完成推送） | 工具立即返回 job 句柄；结算通知由 `dsh-tool-jobs` 自动投递（注入下一步 / follow-up 唤醒空闲 agent），**插件不自行 followup**；`maxConsecutiveWakes` 封顶自激链，`completionDelivery` 按需选 wakeup/quiet |
| auto-close + resume 调度 | 不变（`scheduleIdleClose`/`ensurePeer`/`reopenPeer`，timer 非注册物需自行管理——agenote 已知边角） |
| 主会话 agent 上下文注入（worker/planner/griller 默认注入 + `/<agent>` 命令注入） | 默认注入走 `ctx.systemPrompt.section`；`/<agent> <task>` 命令 handler 直接 `followup` 投递（无需 appendEntry 中转） |
| plan review gate | 挂 dsh-plan-mode exit 工具的 pre-execute 门禁；`reviewedPlans` 状态从 durable log 推导 |
| 配置（atelier.json 全字段） | 保留文件加载为真相源；cordis.yml 的 config 行可覆盖；`/atelier-config` 面板降级删除 |
| registry SQLite | `node:sqlite`，schema/migrate 不变 |
| harness spec 用户覆盖 `~/.config/pi/atelier/harnesses.toml` | 路径改 dsh 配置根（建议 `$XDG_CONFIG_HOME/dsh-atelier/harnesses.toml`）；TOML 解析现为 `import { TOML } from "bun"`（spec.ts），Node 无内置，**替换方案列入 Phase 0 决策**（§7.4 已核实实际语法子集，手搓成本低于原估） |

## 6 执行计划（分阶段）

原则：**先证伪最大风险，再整体搬迁**。每阶段可独立验收。

### Phase 0 — 探针（验证三个前提，半天）

- [步骤] 建最小插件仓库（纯 JS ESM + manifest），注册一个 `herdr_probe`
  工具：`ctx.tools.register(defineTool(...))`，execute 内 `execFileSync`
  调 `herdr pane`/`herdr tab` 做 split/sendText/readPane。
- [步骤] 分别以 `link:` 与 git/tarball 两种形态装入 profile，验证
  `import "@deepseek-ai/dsh-tools"` 的解析结果。
- [步骤] TOML 探针：把 atelier 的 `context/harnesses.toml` 原样喂给候选
  解析器（零依赖小包或手搓子集），比对解析结果与 Bun 侧
  `TOML.parse` 的输出；结论落档后定 Phase 2 的落地件。
  **已部分实证（复审日，本机 Node 单次调用）**：约 40 行子集解析器
  （点号分段表名 + 字符串 + 单行字符串数组）完整解析内置文件 6 个
  harness（pi/claude/codex/hermes/opencode/omp），结构断言（每个
  harness 的 `binaries` 为非空数组）全部通过——手搓路线可行性已证，
  剩余决策只是「手搓 vs 小包」的偏好问题。
- 验证检查点：[真实 herdr 会话内调用工具，pane 创建/发送/读回全部成功；
  两种安装形态下 import 解析结论落档，确定发布形态；TOML 解析结论
  （选型 + 支持语法子集声明）落档]。

### Phase 1 — 骨架 + 多路复用器（1 天）

- [步骤] 搭插件骨架（index.js 分层 + Config schema + cordis.patch.yml），
  整层复制 `runtime/multiplexer/`（保留 `.ts` 后缀与 import 不动，验证宿主
  type stripping 原样运行；失败则就地机械转 `.js`）。
- [步骤] 注册 `herdr_probe` 正式版工具（detectBackend + split/send/read/
  agentStatus 原语）。
- 验证检查点：[dsh 会话内工具可创建 pane 并读回内容；`HERDR_ENV`/`$TMUX`
  检测分支正确；herdr 0.9.4 实测 split 返回 JSON 的 pane id 形状与
  `parsePaneId` 兼容]。

### Phase 2 — peer 生命周期 + harness 路由（2-3 天）

- [步骤] 搬迁 `runtime/harness/`（spec 加载 + adapters + resolve 路由链；
  TOML 解析按 Phase 0 结论落地）、`peer.ts`（openPeer/sendToPeer/closePeer/
  auto-close/resume）、`launcher.ts`（prepareAgentPrompt + run 目录）。
- [步骤] 注册 `subagent` 主工具（registerTool 映射；action 分发 send/wait/
  read/peers/close）。
- 验证检查点：[dsh 会话内经 `subagent` 工具在 herdr 分屏开出 claude/codex/
  hermes peer 并收到 result-N.md；send 追问生效；idle auto-close + resume
  重开上下文无损]。

### Phase 3 — 监控与异步推送（1-2 天）

- [步骤] monitor 判定逻辑接入 dsh-jobs 家族：profile 组合加载
  `dsh-jobs-local` + `dsh-tool-jobs`（缺一不可：前者是注册表实现，
  后者提供控制器与通知投递），monitor 轮询循环作为 producer 注册；
  按 §4 结论**不写自行 followup 的推送路径**，结算通知走
  dsh-tool-jobs 自动投递。
- [步骤] 定 `completionDelivery`（wakeup/quiet）与 `maxConsecutiveWakes`
  配置值，防「唤醒轮启动 job → job 结算再唤醒」自激链。
- 验证检查点：[peer 完成后 job 结算触发会话内通知，无需轮询；主会话
  settled 后由 follow-up 轮次自动恢复；连续后台派发不触发无限唤醒链]。

### Phase 4 — 周边适配（1-2 天）

- [步骤] registry 迁 `node:sqlite`；config 去 `getAgentDir` 依赖并接 cordis
  config 覆盖；plan gate 挂 dsh-plan-mode；`/<agent>` 命令改 followup 投递；
  删除 config-panel（或记后置）。
- 验证检查点：[registry 重建/orphan 恢复正常；plan 提交经 gate 拦截一次后
  放行；`/<agent> <task>` 空上下文注入生效]。

### Phase 5 — 回归与发布（1 天）

- [步骤] `monitor.test.ts` 等纯逻辑测试迁入（bun test 可继续用作测试运行器，
  不依赖宿主；注意测试里的 `getAgentDir` mock 要改指 dsh 路径）；
  真实路径端到端回归（上述各阶段检查点合集）；按 atelier 现有
  release.yml + dsh-agenote 的 tag 纪律发版；CHANGELOG 三段式。
- 验证检查点：[全部测试通过 + 端到端场景人工走查 + 冷启动安装验证]。

## 7 风险与约束

1. **部署形态约束（最重要）**：`link:` 部署下插件 realpath 落在源码目录，
   Node 的 node_modules 父级检索够不到 `$DSH_HOME/profiles/node_modules`，
   **import `@deepseek-ai/*` 必失败**（agenote 20260919 卡片实证；本机
   `profiles/web/node_modules/dsh-agenote` 正是指向 `~/Projects/agenote/
   dsh-agenote` 的符号链接，agenote 因此手搓了 `createUserMessage` 与
   schema 子集）。对照组：本机 `profiles/agent-extensions/` 是目录型
   bundle（非 link），其 `import` 走 profile node_modules 正常解析。
   两条路：
   (a) 安装形态改 git/tarball 进 profile 依赖树，peer 由树内已存在的
   `@deepseek-ai/dsh-tools`（dsh-tool-subagent 的传递依赖）满足，解析落
   共享副本、不产生第二份核心包；
   (b) 坚持 `link:` 则手搓 `defineTool` 等价物（丢类型化 schema 与策略
   流水线）。
   **推荐 (a)**，Phase 0 实证后定论。另注意：把 `@deepseek-ai/dsh` 写成
   `dependencies`（而非 peer）会经 hoisted 平铺产生第二份核心包劫持全局
   解析（agenote 20260919-201540 故障；pnpm `autoInstallPeers` 默认 true
   会复现该路径，DSH profile 模板自带 false 所以无感——agenote
   20260927-014929 实证），严禁。
2. **dsh 尚在 rc cohort**：manifest 的版本下限按 cohort 锚定，且
   `peerDependencies` 与 `dsh.engines.dsh` 是两个独立字段——dsh-agenote
   实证值为 peer `^0.2.0-rc.2`（拒 0.3.0 与更旧，prerelease 宽窄随安装器
   semver 选项而定）、engines `">=0.2.0-rc.2"`。安装与启动时 dsh 会按
   声明范围核对运行时版本，不兼容需用户显式豁免。dsh 出新 cohort 时
   同步抬；另注意 §3.1 的 type stripping 要求宿主 Node ≥23.6，engines
   字段管不到 Node 版本，需在 README 写明。
3. **与 dsh 原生 subagent 的定位边界**：dsh 自带 `dsh-tool-subagent`
   （进程内 spawn/fork/acp 委派 + run_in_background）。dsh-atelier 的差异
   化是异构 CLI 舰队 + herdr 分屏可视化 + 文件契约 + harness 原生 resume +
   人类舵手通道。需在 README 写明边界，避免用户混淆。长期看 acp 后端
   （`dsh-acp`）可能与 harness 适配层融合，不阻塞本次移植。
4. **TOML 解析**：现用 `import { TOML } from "bun"`（spec.ts，Bun 原生、
   零依赖）；Node 无内置 TOML。已核实 `context/harnesses.toml` 实际只用
   「点号分段表名 + 字符串 + 字符串数组」子集（无嵌套表/数组表/多行字符串/
   数字/布尔）；复审日已实测约 40 行解析器完整解析内置文件（6 个
   harness），手搓路线可行性已证；零依赖小包（smol-toml 类）是另一选，
   但 git/tarball 形态下多一个传递依赖。**用户覆盖文件可能引入更多语法**，
   无论选哪条都要声明支持子集并对未知语法显式报错，不静默跳过。决策落
   Phase 0 探针（§6）。
5. **timer 生命周期**：agenote 已知边角——timer 不是 cordis 注册物，不随
   插件卸载清除。auto-close 调度器需自行在 dispose 钩子清理。另一条自激
   链风险（唤醒轮启动 job → job 结算再唤醒）有官方封顶手段：
   `dsh-tool-jobs` 的 `maxConsecutiveWakes` 配置（超出后通知降级为注入），
   Phase 3 定值。
6. **本文件的存放位置**：本文件在 atelier 仓库（Guix-configs 的
   submodule `dotfiles/mutable/agents/pi/.config/pi/extensions/atelier`，
   上游 `ShineBreaker/pi-atelier.git`）内，Guix-configs 的 structor 目录树
   以 depth=1 呈现 `dotfiles/`，不展开子模块内部，不会因本文件过期；子
   模块内容的提交留在子模块自身工作区（`git commit` 于 atelier 目录内），
   Guix-configs 侧只体现 submodule 指针变动。移植启动后本文件应迁往
   `~/Projects/dsh-atelier` 并归档。

## 8 验证标准（完工定义）

- [ ] 真实 herdr 会话内，dsh 主会话经 `subagent` 工具开出至少两种外部
      harness（claude/hermes/codex 中择二）的 peer，完成 brief→result
      文件契约闭环。
- [ ] peer 完成后空闲 auto-close，再次 send 经 harness 原生 resume 恢复
      上下文（对话历史无损）。
- [ ] 主会话 `action:"send"` 舵手消息在 peer 忙时正确排队注入。
- [ ] 异步推送：后台派发后工具立即返回 job 句柄；peer 完成后
      dsh-tool-jobs 自动投递结算通知，主会话 settled 后由 follow-up
      轮次恢复（无插件自行推送路径）。
- [ ] 模型时段 DSL、路由链 fallback、Return Header 解析行为与 pi 版一致。
- [ ] registry 崩溃可丢（删 .db 重启重建）。
- [ ] 全部既有纯逻辑测试通过；冷安装（git/tarball）后 boot 无 disabled 行。
- [ ] `.ts` 搬迁层在宿主 Node 下原样运行（无构建、无转译报错）；宿主
      Node ≥23.6 的前提写入 README 与 engines 说明。
- [ ] TOML 选型对内置 + 用户覆盖两类文件均解析正确，未知语法显式报错。
- [ ] 连续后台派发场景下通知唤醒次数受 `maxConsecutiveWakes` 约束，
      无无限自激。

## 9 待决策点（执行方需先与用户确认）

1. 发布形态：git 仓库（推荐，参照 dsh-agenote）还是 npm？（决定 §7.1 走哪条路）
2. 源码仓库位置：`~/Projects/dsh-atelier` 是否合适；是否与 pi 版共用同一
   仓库多入口（`context/` 资产可软链共享，避免双维护）。注意 pi 版
   atelier 本身是 Guix-configs 的 submodule（`ShineBreaker/pi-atelier.git`），
   独立仓库与同仓库多入口两种形态都与 submodule 机制兼容，提交纪律不变
   （改动留在子模块工作区）。
3. config-panel：本次直接删除（配置走 cordis.yml），还是保留为 Phase 6
   后置（web GUI 贡献）？
4. pi 版 atelier 的存止：并行维护、冻结、还是择期归档？

## 10 本机核对路径索引（复审凭据）

| 断言 | 核对对象（本机路径） |
| --- | --- |
| herdr 后端零 pi 依赖 | `runtime/multiplexer/herdr.ts`（仅 `node:child_process`） |
| herdr 0.9.4 命令面匹配 | `herdr pane --help` / `herdr agent --help` 实测子命令集 |
| Node 24 type stripping | 实测 `node main.ts`（import `./mod.ts`）无 flag 通过 |
| atelier 无可擦除语法外的 TS 特性 | grep enum/namespace/参数属性/decorator 零命中 |
| typebox schema 位置 | `core/schemas.ts`（`SubagentParams`） |
| `bun:sqlite` API 子集一致 | 实测 `node:sqlite` exec/prepare/all/get/PRAGMA |
| `PI_SUBAGENT` 嗅探用途 | `index.ts:1470,1576` + `runtime/peer.ts:320,598` |
| `origin === 'subagent'` 字段 | dsh-session `lib/types/types.d.ts`（`SessionHeader.origin`，含 presentation metadata 注释） |
| dsh-tools 工具注册与流水线 | `@deepseek-ai/dsh-tools` README.zh（`defineTool`/`tools/pre-execute`/`timeoutMs`/`exec.signal`） |
| dsh-jobs 抽象 + 实现 + 通知 | `@deepseek-ai/dsh-jobs`、`dsh-jobs-local`、`dsh-tool-jobs` 三者 README.zh |
| plan gate 挂点 | `@deepseek-ai/dsh-plan-mode` README.zh（`exit_plan_mode`、`plan:policy`） |
| 原生 subagent 边界 | `@deepseek-ai/dsh-tool-subagent` README.zh（spawn/fork/acp、`run_in_background`） |
| link: 部署失败实证 | `~/.local/share/dsh/profiles/web/node_modules/dsh-agenote`（符号链接）+ dsh-agenote `lib.js` 手搓注释 |
| 移植先例（bundle 形态） | `~/.local/share/dsh/profiles/agent-extensions/`（index.js/gate.js/global-context.js/cordis.patch.yml/package.json `dsh.client`） |
| 安装命令形态 | `@deepseek-ai/dsh` README.zh（`dsh plugin --profile <name> <pnpm args>`） |
| web GUI 后置包存在 | pnpm store 中 `@deepseek-ai/dsh-client-ui-settings` 等 |
| 本文件所在仓库关系 | atelier 为 Guix-configs submodule（`.gitmodules` 条目） |
