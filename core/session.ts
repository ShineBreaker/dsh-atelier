// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * 当前宿主 session 的共享锚点（pi 侧原名 piSession）。
 *
 * dsh 侧 index.js 在 agent/created（或首个 pre-step）时从
 * agent.session.header.id 提取写入此处；runtime/peer.ts 派发时读取并记入
 * peer.json，registry/orphan-recovery.ts 据此判定「本会话名下的孤儿」。
 * 放 core 层避免 index ↔ runtime 循环依赖。
 */
export const hostSession: { id: string | null } = { id: null };
