# Changelog

本文件采用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。
版本号语义：patch=不改行为（可攒批）、minor=新能力/行为变化、高危走 -rc.n。

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
