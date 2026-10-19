# AGENTS.md — dsh-atelier

DeepSeek Harness（DSH）的 atelier 移植版：基于 herdr/tmux 分屏的 **外部 agent CLI 编排**插件。`peer` 工具把任务派发到分屏 pane 里的持久 harness 会话（pi/hermes/claude/codex/任意 TUI agent），文件契约（`brief-N/result-N/status.json`）回收结果，harness 原生 resume 无损恢复。与 dsh 原生 `subagent`（进程内子 agent）**互补共存**：轻量子任务走 subagent，跨 CLI/持久/可见的编排走 peer。

源与语义对齐 `pi atelier`（`Guix-configs/dotfiles/mutable/agents/pi/.config/pi/extensions/atelier/`），行为规格见其 AGENTS.md/README.md——本文只记 dsh 侧差异与约束。

## 结构

| 层 | 文件 | 职责 |
|---|---|---|
| 入口 | `index.js` | 组合三半边 + 配置装配（atelier.json 真源 + cordis config 覆盖） |
| 工具 | `tools/peer.js`、`tools/herdr.js` | `peer` 主工具（single/tasks/chain/send/wait/read/peers/close/list/status）；`herdr` 白名单原语工具 |
| 命令 | `commands.js` | `/<agent> <task>`、`/<prompt> <param>`、`/atelier-resume`、`/atelier-workflow` |
| hooks | `hooks.js` | systemPrompt 注入（worker/planner/griller）、`exit_plan_mode` plan gate、`agent/pre-step` 视觉移交、session 锚点 + 孤儿认领 |
| lib | `lib/{message,state,paths,toml,define-tool}.js` | createUserMessage 复刻、操作状态表、XDG 路径、TOML 解析、defineTool 适配 |
| 迁移层 | `core/ runtime/ registry/ lifecycle/ context/` | pi 机械搬迁的 `.ts` 逻辑（Node 24 type stripping 直跑，无构建） |

## 关键约束（移植换来的教训）

- **禁 import `@deepseek-ai/*`**（link: 部署解析不到共享 fallback；agenote 同款禁令）。`createUserMessage` 等在 `lib/` 复刻。
- **工具名 `peer`，不抢 `subagent`**：早期方案曾遮蔽原生 `subagent`（own 层手术摘除），后改为互补设计——原生工具族原样保留，atelier 以独立名字注册，零冲突、零时机敏感。教训存档：own 层工具不能 restrict/unregister、只能 `layers.peek(agent).tools.data.delete`，且 createAgent 期间 own 层插入晚于 `agent/created` 事件——若未来再需要遮蔽，机制是 `agent/created`→`setImmediate`→`restrict(deny)`（遮继承面）→`data.delete`（摘 own 层）→own 层注册。
- **配置**：`~/.config/dsh-atelier/atelier.json` 优先，`~/.config/pi/atelier.json` 迁移回退。peer 目录 `$XDG_CACHE/dsh-atelier/subagents`；registry `$XDG_DATA/dsh-atelier/atelier-registry.db`。
- **source kind**：自投递消息带 `source:{kind:"plugin:dsh-atelier"}`，durable log 里可识别。
- **pi 会话迁移**：`core/session.ts` 的 `hostSession.id` 由 `agent/created` 锚定（`session.header.id`），孤儿认领据此归属。
- `.ts` 迁移层依赖 Node ≥23.6 type stripping；`bun:sqlite` 已换成 `node:sqlite`。

## 验证

```bash
node --check index.js hooks.js commands.js tools/*.js lib/*.js   # 语法
node --input-type=module -e "await import('./index.js')"          # 模块图 + type stripping
node test/e2e-drive.mjs <case|all>                                # headless E2E（fake-ctx + 真 herdr 派发）
# 真实冷启动：dsh tui（改源码必须重启，运行中进程持旧模块图）
```

`test/e2e-drive.mjs` 用 fake ctx 捕获注册面，覆盖注册/list/注入/plan gate/视觉移交/孤儿恢复/管理动作；`wait`/`tasks`/`chain`/`peers`/`focus` 用例会经 herdr 真派 pi peer（自动回收）。需要 `HERDR_ENV=1`。

端到端判据：会话里 `peer action=list` 返回 atelier 的 Agents/Harnesses 表；原生 `subagent` 同时可见且可调用；派发后 `$XDG_CACHE/dsh-atelier/subagents/<peerId>/` 出现 peer.json/brief-N/result-N/status.json。

## 发布

同 dsh-agenote：纯 ESM 零依赖、link:/git 安装、不发 npm；`peerDependencies["@deepseek-ai/dsh"]` 与 `dsh.engines.dsh` 随 cohort 同步抬。
