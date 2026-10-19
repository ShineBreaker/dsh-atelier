// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * herdr CLI 封装。
 *
 * 与 pi-atelier 的 runtime/multiplexer/herdr.ts 同构：execFileSync 同步调用
 * （该层经复审确认零 pi 依赖、可跨宿主搬迁；herdr 0.9.4 子命令面已核对：
 * pane split/run/get/close/rename/send-keys、agent get）。
 *
 * 失败不抛错：返回 { ok, stdout, stderr, status }——工具面需要把 herdr 的
 * 真实失败原因交还模型，而非吞成异常栈。
 */

import { execFileSync } from "node:child_process";

/**
 * 同步执行 herdr 命令。
 *
 * @param {string[]} args herdr 子命令参数
 * @param {{timeoutMs?: number}} [opts] 子进程超时（默认 15s，到点杀子进程）
 * @returns {{ok: boolean, stdout: string, stderr: string, status: number}}
 */
export function herdr(args, { timeoutMs = 15000 } = {}) {
  try {
    const stdout = execFileSync("herdr", args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    return { ok: true, stdout: stdout.trimEnd(), stderr: "", status: 0 };
  } catch (err) {
    return {
      ok: false,
      stdout: (err.stdout ?? "").toString(),
      stderr: (err.stderr ?? err.message ?? String(err)).toString(),
      status: typeof err.status === "number" ? err.status : 1,
    };
  }
}
