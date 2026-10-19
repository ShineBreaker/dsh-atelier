// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * herdr 工具（0.1.0）——白名单动作集。
 *
 * 刻意不做任意命令透传：模型只能触发枚举内的 herdr 子命令，参数收敛到
 * pane_id/text/command/direction/lines 五个字段，从 schema 层面排除
 * close/kill/delete 类破坏动作（0.1.0 不含这些动作，后续按需再加）。
 *
 * list 类输出做投影摘要：herdr 返回紧凑单行 JSON，原样进模型上下文既臃肿
 * 又难读；投影只保留编排决策需要的字段。
 */

import { defineTool } from "../lib/define-tool.js";
import { herdr } from "../lib/herdr.js";

const ACTIONS = [
  "status",
  "workspaces",
  "panes",
  "agents",
  "read",
  "split",
  "send",
];

const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ACTIONS,
      description:
        "status=herdr 客户端/服务端状态；workspaces/panes/agents=列环境；" +
        "read=读 pane 终端输出；split=分屏开 pane（可带 command 立即执行）；" +
        "send=向 pane 发送字面文本。",
    },
    pane_id: {
      type: "string",
      description: "目标 pane id（read/send 必填，形如 w11:p1）",
    },
    text: {
      type: "string",
      description: "send 的文本内容（send 必填）",
    },
    command: {
      type: "string",
      description: "split 时在新 pane 中执行的命令（可选，省略则只开空 pane）",
    },
    direction: {
      type: "string",
      enum: ["right", "down"],
      description: "split 方向（默认 down）",
    },
    lines: {
      type: "integer",
      description: "read 时读取的尾部行数（默认 100，上限 500）",
    },
  },
  required: ["action"],
};

/** 从 herdr split 的 JSON 响应提取新 pane id；形状不符返回 null。 */
function parsePaneId(json) {
  try {
    const parsed = JSON.parse(json);
    return parsed?.result?.pane?.pane_id ?? null;
  } catch {
    return null;
  }
}

/** list 类 JSON 响应 → 模型可读的投影行。 */
function projectList(json, kind) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  const rows =
    kind === "workspaces"
      ? (parsed?.result?.workspaces ?? []).map(
          (w) =>
            `${w.workspace_id}  ${w.label ?? ""}  panes=${w.pane_count} tabs=${w.tab_count}${w.focused ? "  (focused)" : ""}`,
        )
      : kind === "panes"
        ? (parsed?.result?.panes ?? []).map(
            (p) =>
              `${p.pane_id}  ws=${p.workspace_id} tab=${p.tab_id}  agent=${p.agent ?? "-"} status=${p.agent_status ?? "unknown"}  ${p.terminal_title ?? ""}`,
          )
        : (parsed?.result?.agents ?? []).map(
            (a) =>
              `${a.agent}  pane=${a.pane_id}  status=${a.agent_status ?? "unknown"}  session=${a.agent_session?.value ?? "-"}  ${a.terminal_title ?? ""}`,
          );
  if (rows.length === 0) return `(no ${kind})`;
  return [`${kind} (${rows.length}):`, ...rows].join("\n");
}

/** 执行一个白名单动作，返回 herdr 结果对象。 */
function runAction(args) {
  switch (args.action) {
    case "status":
      return herdr(["status"]);
    case "workspaces":
      return herdr(["workspace", "list"]);
    case "panes":
      return herdr(["pane", "list"]);
    case "agents":
      return herdr(["agent", "list"]);
    case "read": {
      const lines = Math.min(Math.max(args.lines ?? 100, 1), 500);
      return herdr(["pane", "read", args.pane_id, "--lines", String(lines)]);
    }
    case "split": {
      // herdr CLI 的 --direction 是必填项（0.9.4 实测），工具的默认值
      // 必须显式传下去，不能因 schema 层可选就省略。
      const splitArgs = ["pane", "split", "--direction", args.direction ?? "down"];
      return herdr(splitArgs);
    }
    case "send":
      return herdr(["pane", "send-text", args.pane_id, args.text]);
    default:
      return { ok: false, stdout: "", stderr: `unknown action: ${args.action}`, status: 1 };
  }
}

/** split 动作的收尾：拿到新 pane id，可选地在其中执行 command。 */
function finishSplit(splitRes, args) {
  if (!splitRes.ok) {
    return `split failed (exit ${splitRes.status}):\n${splitRes.stderr || splitRes.stdout}`;
  }
  const paneId = parsePaneId(splitRes.stdout);
  if (!paneId) {
    return `split succeeded but pane id unparsable:\n${splitRes.stdout}`;
  }
  if (!args.command) return `pane ${paneId} created`;
  const runRes = herdr(["pane", "run", paneId, args.command]);
  if (!runRes.ok) {
    return `pane ${paneId} created; run failed (exit ${runRes.status}):\n${runRes.stderr || runRes.stdout}`;
  }
  return `pane ${paneId} created and running: ${args.command}\n${runRes.stdout}`;
}

export const definition = defineTool({
  name: "herdr",
  description:
    "操控 herdr 终端多路复用器（分屏 pane、agent 观测、文本收发）。" +
    "需要在 herdr 托管会话内使用（herdr server 运行中）。" +
    "典型流：panes/agents 观测 → split 开 pane 并可带 command 启动外部 CLI → " +
    "read 看输出 → send 追加输入。只读动作无副作用；split/send 有副作用。",
  parameters,
  output: {
    schema: { type: "string" },
  },
  async execute(args) {
    if (!ACTIONS.includes(args.action)) {
      throw new Error(`unknown action: ${args.action}`);
    }
    if ((args.action === "read" || args.action === "send") && !args.pane_id) {
      throw new Error(`${args.action} requires pane_id`);
    }
    if (args.action === "send" && !args.text) {
      throw new Error("send requires text");
    }
    const res = runAction(args);
    if (!res.ok) {
      return `herdr ${args.action} failed (exit ${res.status}):\n${res.stderr || res.stdout || "(no output)"}`;
    }
    if (args.action === "split") return finishSplit(res, args);
    if (args.action === "workspaces" || args.action === "panes" || args.action === "agents") {
      return projectList(res.stdout, args.action);
    }
    return res.stdout || "(no output)";
  },
});
