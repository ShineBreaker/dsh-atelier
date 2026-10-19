# dsh-atelier-agent

pi atelier 的 dsh（DeepSeek Harness）移植版：基于 herdr/tmux 分屏的
**外部 agent CLI 编排**插件。

`peer` 工具把任务派发到分屏 pane 里的持久 harness 会话（pi/hermes/
claude/codex/任意 TUI agent），文件契约（`brief-N.md`/`result-N.md`/
`status.json`）结构化回收结果；peer 空闲超时自动回收 pane，`send` 时
经 harness 原生 resume 无损恢复。与 dsh 原生 `subagent`（进程内子
agent）**互补共存**：轻量子任务走 `subagent`，跨 CLI 厂商/持久交互/
人工可见的编排走 `peer`。

## 安装

```sh
dsh plugin --profile <name> add git+file:///path/to/dsh-atelier
# 或发布后：dsh plugin --profile <name> add git+ssh://git@github.com/<you>/dsh-atelier.git
```

装完在 profile 的 `cordis.patch.yml` 加挂载行（裸包名，勿用子路径）：

```yaml
- insert:
    - id: dsh-atelier-agent
      name: 'dsh-atelier-agent'
```

本包的 `dsh.bundle.patch` 自带同样一行，经 `dsh plugin add` 会自动并入
profile manifest；手改 patch 时才需要上面这步。

## 使用

### `peer` 工具（模型可见）

- **派发**：`{agent:"worker", task:"..."}` 单发、`{tasks:[...]}` 并行、
  `{chain:[...]}` 串行链。默认异步——立即返回句柄，完成后结果自动推送
  回主会话；`wait:true` 才就地阻塞。
- **管理**：`action:"send"` 向 peer 追加指令（忙碌=舵手纠偏、空闲=新
  任务、已回收=resume 重开）；`action:"wait"|"read"|"peers"|"close"|
  "list"|"status"`。
- `action:"list"` 返回可用 agent、harness 与 prompt 模板清单。

### `herdr` 工具（白名单原语）

status/workspaces/panes/agents/read/split/send——只读动作无副作用。

### 命令（人可见）

- `/<agent> <task>`：空上下文把该 agent 的 prompt 注入主会话；非空
  直接派发 peer。
- `/<prompt> <param>`：按模板派发 single/parallel/chain。
- `/atelier-resume <parentRunId>`：从 checkpoint 续跳未完成的 chain。
- `/atelier-workflow list|show <id>`：查看持久化 workflow。

### 配置

`~/.config/dsh-atelier/atelier.json`（优先）或 `~/.config/pi/atelier.json`
（迁移回退）；cordis config 行 `{atelier: {...}}` 可覆盖。字段同
`core/types.ts` 的 `SubagentConfig`（tiers 路由、modelSchedules、
defaultTier、idleGraceMs 等）。

## 开发

```sh
node --check index.js hooks.js commands.js tools/*.js lib/*.js   # 语法
node --input-type=module -e "await import('./index.js')"           # 模块图
```

环境管理沿用仓库根的 direnv 约定（.envrc）；本包纯 Node 内置能力，
`.ts` 迁移层靠 Node ≥23.6 type stripping 直跑，不需要构建。

## 设计约束（改动前必读）

1. **零 `@deepseek-ai` import**。dsh 核心家族只在 CLI 启动器的 pnpm
   虚拟树里；`defineTool` 用手搓等价物（lib/define-tool.js），宿主
   API 全经 ctx 服务与事件获取。
2. **零依赖、零构建**。纯 ESM；SQLite 用 `node:sqlite`。
3. **挂载行必须裸包名**。子路径行会让 `dsh.client` 声明被静默跳过。
4. **工具名 `peer` 不抢 `subagent`**——互补设计的历史决策与遮蔽
   机制存档见 AGENTS.md。

## License

MIT
