# Changelog

本文件采用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。
版本号语义：patch=不改行为（可攒批）、minor=新能力/行为变化、高危走 -rc.n。

## [Unreleased]

### Changed

- 包名（分发身份）`dsh-atelier` → `dsh-atelier-agent`：npm 上原名已被第三方
  无关项目占用（hurricant/aidenli，0.3.4）。同步改名：`package.json` name、
  `cordis.patch.yml` 挂载行、`index.js` name 导出、命令 definitionId 前缀、
  durable log source kind（`plugin:dsh-atelier-agent`）。
- XDG 数据路径不变（`~/.config/dsh-atelier`、`$XDG_CACHE/dsh-atelier/
  subagents`、registry db），既有配置与 run 状态继续生效。
- 已装 profile 需把 dependencies 与 `dsh.profile.bundles` 里的 `dsh-atelier`
  改为 `dsh-atelier-agent`（link: 路径不变），否则 bundle 解析不到。

## [0.2.0] - 2026-10-19

peer 编排半边落地：`peer` 工具把任务派发到 herdr/tmux 分屏 pane 里的持久
harness 会话（pi/hermes/claude/codex），文件契约回收结果，harness 原生
resume 无损恢复；与 dsh 原生 `subagent` 互补共存。

### Added

- `peer` 工具：`{agent, task}` 单发、`tasks:[...]` 并行、`chain:[...]` 串行
  链；默认异步派发，完成后自动推送回主会话；管理动作
  `send/wait/read/peers/close/list/status`。
- 迁移层（`core/ runtime/ registry/ lifecycle/ context/`）：pi atelier
  逻辑机械搬迁，`.ts` 经 Node ≥23.6 type stripping 直跑，零构建；
  `bun:sqlite` 已换 `node:sqlite`。
- 命令：`/<agent> <task>`、`/<prompt> <param>`（scout-and-plan /
  implement / implement-and-review / research-and-implement /
  parallel-research / parallel-workers / design-review-implement 七个
  模板）、`/atelier-resume`、`/atelier-workflow`。
- hooks：systemPrompt 注入 8 个内置 agent 提示词 + 命令标记 + plan-mode
  优先级提示；`exit_plan_mode` plan gate；`agent/pre-step` 视觉移交
  （模型无视觉能力时转 visual peer）；session 锚点 + 孤儿认领。
- harness 适配层：herdr/tmux 双复用器探测；`{provider}` 占位符与 mcode
  适配（hermes 的 provider/model 复合名拆参）。
- 配置三层：`~/.config/dsh-atelier/atelier.json`（优先）→
  `~/.config/pi/atelier.json`（迁移回退）→ cordis config 行覆盖。
- 测试：`test/smoke.js`（契约 + 真实 herdr 只读冒烟，11 例）、
  `test/e2e-drive.mjs`（headless E2E，fake ctx 捕获注册面）。
- 文档：README（安装/使用/设计约束）、AGENTS.md（结构/验证/发布约束）、
  `docs/dsh-port-plan.md`（移植计划归档）。

### Fixed

- agent 消息提交改用 `promptAgent`，修 hermes peer 不提交输入的问题。

### Verified

- node v24.18.0：`node --check` 全量 + 模块图导入通过；冒烟 11/11。
- E2E 注册面用例全通过（list/注入/plan gate/视觉移交/workflow/resume/
  孤儿认领/registry 持久化）；真实 peer 派发用例（wait/tasks/chain/
  peers/focus）需 pi CLI 在 PATH，发版机缺失未复跑。

## [0.1.0] - 2026-10-15

首个可用版本：dsh 宿主内调用 herdr 的白名单工具面。

### Added

- `herdr` 工具：status/workspaces/panes/agents/read/split/send 七个动作；
  list 类输出投影为摘要行；split 解析新 pane id 并可在其中执行 command。
- `lib/define-tool.js`：defineTool 手搓等价物（零 @deepseek-ai import 约束
  下的产物，README「设计约束」第 1 条）。
- `lib/herdr.js`：execFileSync 封装，失败返回结构化结果不抛异常。
- `test/smoke.js`：契约测试 + 真实 herdr 只读调用冒烟（11 例）。

### Verified

- herdr 0.9.4 端到端人工验证：workspace create → pane split(--pane,
  --direction down) → pane run → pane read → pane send-text → pane close
  → workspace close，全链路通过；pane id 形状 result.pane.pane_id 与
  parsePaneId 兼容。
- 冒烟测试 11/11 通过（node v24.18.0）。

### Known limits

- 未装进真实 profile 跑宿主加载（沙箱写入受限，见提交说明）；
  `dsh plugin --profile <name> add` + 会话内实调待用户环境放行后补验。
- 无浏览器半边（dsh.client）；无 Config schema（enabled 单字段手写默认）。
