// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * dsh 宿主消息工具 — 复刻 @deepseek-ai/dsh-llm 的 createUserMessage
 * （dsh-agenote/lib.js 同款先例：link: 部署下不能 import @deepseek-ai/*）。
 *
 * 另含 durable log 读取的公共 helper：session.surface.nodes +
 * session.eventAt(seq) 是唯一的跨 resume 真相源（agenote 实证）。
 */

import { randomUUID } from "node:crypto";

/** 本插件投递的消息统一带的 source kind（durable log 里识别自注入）。 */
export const PLUGIN_SOURCE = "dsh-atelier-agent";

function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/** createUserMessage 复刻：id + structuredClone + deepFreeze。 */
export function createUserMessage(input) {
  return deepFreeze(
    structuredClone({ ...input, role: "user", id: randomUUID() }),
  );
}

/** 本插件来源的 user 消息（followup / pre-step 注入共用 source 标记）。 */
export function ownMessage(text) {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: `plugin:${PLUGIN_SOURCE}` },
  });
}

/** followup 投递：排独立后续 turn 并唤醒 driver（等价 pi sendUserMessage）。 */
export function deliver(agent, text) {
  try {
    agent.followup(ownMessage(text));
  } catch (err) {
    console.warn("[atelier:push] followup 失败:", err?.message ?? err);
  }
}

/** dsh 原生 subagent 会话豁免（session.header.origin 持久化字段）。 */
export function isSubagent(agent) {
  return agent?.session?.header?.origin === "subagent";
}

/** 会话 workspace cwd（tool/command 的工作目录兜底）。 */
export function sessionCwd(agent) {
  return agent?.session?.header?.cwd ?? process.cwd();
}

/**
 * 会话是否已有真实对话（durable log 存在 user/message）。
 * 等价 pi 侧 sessionManager.getEntries() 的 hasUserMessage 判定——
 * /<agent> 命令的空上下文注入走这个。
 */
export function hasUserMessage(session) {
  const nodes = session?.surface?.nodes;
  if (!nodes) return false;
  for (const seq of nodes) {
    const event = session.eventAt(seq);
    if (event?.type === "user/message") return true;
  }
  return false;
}

/**
 * 读 durable log 里最近的 plan/mode 事件 → plan mode 是否激活。
 * dsh-plan-mode 用 session.append("plan/mode", {active}) 写态（见上游源码），
 * 比内存态可靠——resume/clear 后判定不变。
 */
export function planModeActive(session) {
  const nodes = session?.surface?.nodes;
  if (!nodes) return false;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const event = session.eventAt(nodes[i]);
    if (event?.type === "plan/mode") {
      return event.data?.active === true;
    }
  }
  return false;
}
