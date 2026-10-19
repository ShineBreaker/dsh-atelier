// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * waitForPeerMessage 回归测试（`bun test runtime/monitor.test.ts`）。
 *
 * 零外部依赖：launcher（pane 存活/杀 pane）与 detectBackend 用
 * `mock.module` 桩掉；registry 落盘靠 XDG_DATA_HOME 沙盒隔离。
 * 覆盖：
 *   1. transcript 稳定收尾（settleIdle）——曾因引用 Promise 外的
 *      `resolve` 抛 ReferenceError 打崩 pi 进程（bug-report 01a12c40）。
 *   2. 文件契约主路径（status.json completed 直接收结果）。
 *   3. 超时路径（failed + exitCode 124，不杀 pane）。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MuxAgentStatus, MultiplexerBackend } from "./multiplexer/types.ts";
import type { PeerInfo, SubagentConfig } from "../core/types.ts";
import { DEFAULT_CONFIG } from "../core/types.ts";

// ─── 可控桩状态（mock factory 闭包引用，测试内可改） ───

let paneAlive = true;
let agentStatusValue: MuxAgentStatus | null = null;
let readScript: string[] = [];
let readDefault = "";
const killedPanes: string[] = [];
const sentTexts: Array<{ paneId: string; text: string }> = [];

const fakeBackend = {
  name: "herdr",
  splitShell: () => "fake-pane",
  openTab: () => ({ tabId: "fake-tab", paneId: "fake-pane" }),
  closeTab: () => {},
  setTitle: () => {},
  isAlive: () => true,
  kill: () => {},
  sendText: (paneId: string, text: string) => {
    sentTexts.push({ paneId, text });
  },
  readPane: (_paneId: string, _lines?: number) =>
    readScript.length > 0 ? (readScript.shift() as string) : readDefault,
  agentStatus: (_paneId: string) => agentStatusValue,
  agentSession: (_paneId: string) => null,
} as unknown as MultiplexerBackend;

// launcher 整模块桩掉：被测链路（monitor/peer）只用到以下导出。
mock.module("./launcher.ts", () => ({
  getSubagentsDir: () => path.join(process.env.XDG_CACHE_HOME ?? os.tmpdir(), "pi", "subagents"),
  killPane: (paneId: string) => {
    killedPanes.push(paneId);
  },
  paneIsAlive: (_paneId: string) => paneAlive,
  readStatus: (_runDir: string) => null,
  cleanupOldRuns: (_config: unknown) => {},
  prepareAgentPrompt: (_agentName: string, _runDir: string) => null,
}));

mock.module("./multiplexer/detect.ts", () => ({
  detectBackend: () => fakeBackend,
}));

// pi 宿主运行时才提供这些 peerDeps（被测链路经 peer.ts 间接触到），
// 单测里桩掉：只求模块能加载，被测路径用不到它们。
mock.module("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/tmp/atelier-test-agents",
  parseFrontmatter: (text: string) => ({ frontmatter: {}, content: text }),
}));
mock.module("typebox", () => ({
  Type: new Proxy({}, { get: () => () => ({}) }),
}));

// mock 注册完成后再加载被测模块。
const { waitForPeerMessage } = await import("./monitor.ts");

// ─── 测试固件 ───

let tmpRoot = "";
const savedEnv: Record<string, string | undefined> = {};

function fastConfig(overrides: Partial<SubagentConfig> = {}): SubagentConfig {
  return {
    ...DEFAULT_CONFIG,
    pollIntervalMs: 10,
    timeoutMs: 5000,
    blockedGraceMs: 500,
    autoClose: false, // 关掉空闲回收定时器，测试进程不 hanging
    ...overrides,
  };
}

function makePeer(): PeerInfo {
  const peerDir = fs.mkdtempSync(path.join(tmpRoot, "peer-"));
  return {
    peerId: `test-peer-${Date.now().toString(36)}`,
    paneId: "fake-pane",
    mux: "herdr",
    harness: "pi",
    agent: "scout",
    cwd: "/tmp",
    peerDir,
    msgSeq: 1,
    createdAt: Date.now(),
    alive: true,
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-monitor-test-"));
  for (const k of ["XDG_CACHE_HOME", "XDG_DATA_HOME", "HERDR_ENV", "TMUX"] as const) {
    savedEnv[k] = process.env[k];
  }
  process.env.XDG_CACHE_HOME = path.join(tmpRoot, "cache");
  process.env.XDG_DATA_HOME = path.join(tmpRoot, "data");
  fs.mkdirSync(path.join(tmpRoot, "data", "pi"), { recursive: true });
  // 删掉多路复用器标记：万一有调用绕过 mock，直接抛错而不是去 shell out。
  delete process.env.HERDR_ENV;
  delete process.env.TMUX;
  // 重置桩状态
  paneAlive = true;
  agentStatusValue = null;
  readScript = [];
  readDefault = "";
  killedPanes.length = 0;
  sentTexts.length = 0;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("waitForPeerMessage", () => {
  test("transcript 稳定收尾不再抛 ReferenceError（settleIdle 越界 resolve 回归）", async () => {
    const peer = makePeer();
    // peer 停了但没更新 status.json（running 残留），result 文件已落盘——
    // 正是线上崩溃时的现场：settleIdle 被 transcript 稳定启发触发。
    fs.writeFileSync(
      path.join(peer.peerDir, "status.json"),
      JSON.stringify({ status: "running", msgSeq: 1 }),
    );
    fs.writeFileSync(path.join(peer.peerDir, "result-1.md"), "# 回归测试结果\n\npeer 正常落盘。");
    // setup 读一次，之后先变后稳：连续 4 轮不变触发 settleIdle。
    readScript = ["boot-A", "boot-B"];
    readDefault = "steady-output";

    const result = await waitForPeerMessage(peer, 1, fastConfig());

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("回归测试结果");
    // settleIdle 代写 status.json 终态
    const st = JSON.parse(fs.readFileSync(path.join(peer.peerDir, "status.json"), "utf-8")) as {
      status: string;
    };
    expect(st.status).toBe("completed");
  });

  test("文件契约：status.json completed 直接收结果", async () => {
    const peer = makePeer();
    fs.writeFileSync(
      path.join(peer.peerDir, "status.json"),
      JSON.stringify({ status: "completed", msgSeq: 1 }),
    );
    fs.writeFileSync(path.join(peer.peerDir, "result-1.md"), "文件契约输出");
    readDefault = "steady";

    const result = await waitForPeerMessage(peer, 1, fastConfig());

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("文件契约输出");
  });

  test("超时返回 failed（exitCode 124），不杀 pane", async () => {
    const peer = makePeer();
    fs.writeFileSync(
      path.join(peer.peerDir, "status.json"),
      JSON.stringify({ status: "running", msgSeq: 1 }),
    );
    readDefault = "steady"; // 无变化→无 activity，transcript 启发永不触发

    const result = await waitForPeerMessage(peer, 1, fastConfig({ timeoutMs: 60 }));

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(124);
    expect(killedPanes).toEqual([]);
  });
});
