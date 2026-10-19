// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * 参数 Schema — peer 工具的输入参数 JSON Schema。
 *
 * pi 侧用 typebox；dsh 工具的 parameters 直接吃标准 JSON Schema 字面量，
 * 这里平铺重写（无构建、无 typebox 依赖）。
 *
 * PR-12 peer 化：派发返回异步句柄（peerId），显式 action:wait 收结果；
 * action:send 向存活 peer 随时追加指令（追问/纠偏/解堵）。
 */

/** 单个任务条目：agent 名 + 任务描述 + 可选 cwd */
const TaskItem = {
  type: "object",
  properties: {
    agent: { type: "string", description: "Agent 名称" },
    task: { type: "string", description: "任务描述" },
    cwd: { type: "string", description: "工作目录" },
  },
  required: ["agent", "task"],
};

/** peer 工具的完整参数 schema */
export const PeerParams = {
  type: "object",
  properties: {
    agent: {
      type: "string",
      description:
        "Agent 名称（single 派发）；send 时作为复用目标——找该角色的空闲 peer",
    },
    task: {
      type: "string",
      description: "任务/消息文本（single 派发、send、chain 根任务）",
    },
    tasks: {
      type: "array",
      items: TaskItem,
      description: "并行任务数组（每任务一个新 peer）",
    },
    chain: {
      type: "array",
      items: TaskItem,
      description:
        "串行任务链；task 中可用 {previous}/{task}。同 agent+同 harness 的步骤复用同一 peer（上下文零损耗）",
    },
    action: {
      type: "string",
      enum: ["list", "status", "peers", "send", "wait", "read", "close", "focus"],
      description:
        "管理动作：list=agent/harness 清单；peers=存活 peer 池；" +
        "send=向 peer 追加指令（忙碌时=舵手纠偏，空闲时=新任务）；" +
        "wait=收某 peer 当前消息结果；read=看 peer 实时 transcript；" +
        "focus=把 peer 的 pane 拉到前台供人查看；" +
        "close=退役 peer；status=查 run/peer 状态",
    },
    id: {
      type: "string",
      description:
        "peerId（send/wait/read/close）或 runId（status）。send 可与 agent 二选一",
    },
    peer: {
      type: "string",
      description: "派发时复用的 peerId；缺省总是新开 peer（隔离上下文）",
    },
    harness: {
      type: "string",
      description: "harness 覆盖（pi/claude/codex/hermes/任意 PATH binary 名）",
    },
    wait: {
      type: "boolean",
      description:
        "true=阻塞到本条消息完成并返回结果（仅后续工具强依赖本结果时用）；" +
        "false/缺省=立即返回句柄，结果完成后自动推送新消息，无需轮询或手动 wait",
    },
    lines: {
      type: "number",
      description: "action:read 的 transcript 尾部行数",
    },
    cwd: { type: "string", description: "工作目录覆盖" },
    model: { type: "string", description: "模型覆盖" },
    images: {
      type: "array",
      items: { type: "string" },
      description: "图片文件路径数组，传递给 visual agent 分析",
    },
    isSystemSpawned: {
      type: "boolean",
      description: "PR-9: 系统子 agent 标记（默认 false）",
    },
    action_ext: {
      type: "string",
      description: "PR-10: 扩展动作（resume <runId>）",
    },
  },
};
