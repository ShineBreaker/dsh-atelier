// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * 跨半边共享的运行态。
 *
 * - pendingContextInject：`/<agent> <task>` 在空上下文时记的一次性注入标记
 *   （agentId → agentName），由 hooks 半边的 systemPrompt section 回调消费
 *   ——等价 pi 的 appendEntry("atelier:context-inject") 标记 + before_agent_start
 *   消费。dsh 无 appendEntry 等价物；一次性标记本就是进程内瞬态，内存 Map 足够。
 */

/** @type {Map<string, string>} agentId → agentName */
export const pendingContextInject = new Map();
