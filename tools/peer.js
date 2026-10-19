// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * peer 工具 — pi atelier subagent 工具的 dsh 移植，**与原生 subagent 互补共存**：
 *
 *   - `subagent`（原生）：进程内子 agent——同进程、快、便宜，适合轻量子任务
 *   - `peer`（本工具）：外部 agent CLI 编排——在 herdr/tmux 分屏 pane 里跑
 *     claude/codex/hermes/pi 等完整 CLI，跨模型厂商协作、会话持久可 resume、
 *     忙碌可舵手纠偏、过程对人全程可见
 *
 * 行为与 pi 版一致：single/tasks/chain 三种派发 + list/peers/send/wait/read/
 * close/status 管理动作；默认异步派发、完成即 followup 推送；wait:true 才
 * 就地阻塞收结果。
 */

import { defineTool } from "../lib/define-tool.js";
import { PeerParams } from "../core/schemas.js";
import { deliver, sessionCwd } from "../lib/message.js";
import { discoverAgents, discoverPrompts } from "../core/discovery.ts";
import { ensureWorkfile } from "../runtime/workfile.ts";
import { generateRunId, getRunDir } from "../runtime/launcher.ts";
import { waitForPeerMessage, listRunning } from "../runtime/monitor.ts";
import {
  closePeer,
  ensurePeer,
  findReusablePeer,
  getPeer,
  listPeers,
  openPeer,
  readPeer,
  sendToPeer,
  peerBusy,
  focusPeer,
} from "../runtime/peer.ts";
import {
  getAdapter,
  listAvailableHarnesses,
  resolveRouteChain,
} from "../runtime/harness/resolve.ts";
import {
  executeWithFallback,
  runParallelBatches,
  runChain,
  readDefaultModelFromSettings,
} from "../runtime/runner.ts";
import { formatResults } from "../runtime/formatting.ts";
import { appendSessionLog } from "../runtime/session-log.ts";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Worker single 模式硬警告 ────────────────────────────────────────────────
// 与 pi 版一致：worker 为并发设计；single 调用触发硬警告，30s 内重试视为
// 紧急 override 放行。
const WORKER_OVERRIDE_GRACE_MS = 30_000;
let lastWorkerSingleWarnAt = 0;

function checkWorkerSingleOverride() {
  if (Date.now() - lastWorkerSingleWarnAt > WORKER_OVERRIDE_GRACE_MS) {
    lastWorkerSingleWarnAt = Date.now();
    return "warn";
  }
  return "allow";
}

function workerSingleWarnText() {
  return [
    "❌ worker 是为并发执行设计的 peer，不允许 single 模式调用。",
    "",
    "请改用 `tasks` 数组（即使只放 1 个任务也合法）：",
    '  peer({ tasks: [{ agent: "worker", task: "..." }] })',
    "",
    "或者把工作拆成 N 个独立子任务，让 N 个 worker 并行：",
    "  peer({ tasks: [",
    '    { agent: "worker", task: "子任务 A" },',
    '    { agent: "worker", task: "子任务 B" },',
    "  ] })",
    "",
    "紧急 override：若确实需要 single worker（例如剩余的上下文窗口不够使用）",
    `${WORKER_OVERRIDE_GRACE_MS / 1000}s 内再调用一次相同的请求将放行执行。`,
  ].join("\n");
}

// ─── 异步后台任务表 ──────────────────────────────────────────────────────────
// 与 pi 版同构：pendingOps 在途批次、finishedOps 推送后缓存、claimed 认领防
// 重复下发；peer 单消息 watcher 用 watchedPeers/claimedPeers 去重。
const pendingOps = new Map(); // batchId → { mode, p, agentId }
const finishedOps = new Map(); // batchId → { mode, results }
const claimedBatches = new Set();
const watchedPeers = new Map(); // "<peerId>-m<seq>" → agentId
const claimedPeers = new Set();

const pendingCatch = (p) =>
  p.catch((err) => [
    {
      runId: "(none)",
      agent: "(batch)",
      status: "failed",
      exitCode: 1,
      output: `后台批次异常: ${err.message}`,
      durationMs: 0,
      tmuxPane: "",
      error: err.message,
    },
  ]);

const formatBatchPush = (id, mode, results) =>
  [
    `📬 [atelier 后台推送] ${mode} ${id} 完成（${results.filter((r) => r.status === "completed").length}/${results.length} 成功）：`,
    "",
    formatResults(results),
  ].join("\n");

/** 批次后台推送：完成投递（被显式 wait 认领则跳过）。agent 为派发所在会话。 */
const attachBatchPush = (agent, batchId, mode, p) => {
  void p.then((results) => {
    if (claimedBatches.has(batchId)) {
      claimedBatches.delete(batchId);
      return;
    }
    pendingOps.delete(batchId);
    finishedOps.set(batchId, { mode, results });
    appendSessionLog(mode, results);
    deliver(agent, formatBatchPush(batchId, mode, results));
  });
};

/** peer 单消息 watcher：完成即推送（被显式 wait 认领则跳过） */
const watchPeerAndPush = (agent, peer, seq, startedAt, cwd, config) => {
  const msgId = `${peer.peerId}-m${seq}`;
  if (watchedPeers.has(msgId)) return;
  watchedPeers.set(msgId, String(agent?.id ?? ""));
  // signal 传 undefined：后台 watcher 与派发工具调用解耦
  void waitForPeerMessage(peer, seq, config, undefined).then((result) => {
    watchedPeers.delete(msgId);
    if (claimedPeers.has(msgId)) {
      claimedPeers.delete(msgId);
      return;
    }
    if (result.status === "completed") {
      ensureWorkfile(result, cwd, startedAt);
    }
    appendSessionLog("single", [result]);
    deliver(
      agent,
      [
        `📬 [atelier 后台推送] peer ${peer.peerId}（${peer.agent}@${peer.harness}）msg #${seq} 完成：`,
        "",
        result.output,
      ].join("\n"),
    );
  });
};

/** 会话销毁时清理该 agent 名下的推送状态（agent/disposed 调用）。 */
export function cleanupAgentOps(agentId) {
  const id = String(agentId ?? "");
  for (const [k, v] of pendingOps) {
    if (v.agentId === id) pendingOps.delete(k);
  }
  for (const [k, v] of watchedPeers) {
    if (v === id) watchedPeers.delete(k);
  }
}

// ─── 工具定义 ────────────────────────────────────────────────────────────────

export const definition = defineTool({
  name: "peer",
  description:
    "外部 agent CLI 编排（与进程内 subagent 互补：subagent 适合同进程轻量子任务；" +
    "peer 适合需要独立 CLI 能力、跨模型厂商、持久交互或人工可见的任务）。" +
    "在分屏 pane 里跑各类 agent harness（claude/codex/hermes/pi/…，按 tier 路由解析，" +
    "外部 harness 优先）。peer 完成后空闲一段时间自动回收 pane，" +
    "但会话可随时用 harness 原生 resume 无损恢复——send(id,task) 对已回收 peer 自动重开，" +
    "上下文不丢；宽限期内（默认 120s）追问则直接复用原 pane。" +
    "派发：{agent, task} 单发、{tasks:[...]} 并行、{chain:[...]} 串行链。" +
    "默认异步：立即返回句柄，结果完成后自动推送新消息，无需轮询；" +
    "派发后如无其他独立工作请直接结束本轮（会话 settled，推送到达时自动恢复）； " +
    "wait:true 仅在后续工具强依赖本结果时阻塞等待。" +
    "管理：action=send 向 peer 追加指令（忙碌=纠偏、空闲=新任务、已回收=resume 重开）； " +
    "action=wait 仅手动核查用；action=read 看实时输出；action=peers 看存活池；" +
    "action=focus 把 peer 的 pane 拉到前台供人查看；" +
    "action=close 退役 peer；action=list 看 agent/harness 清单。",
  parameters: PeerParams,
  output: {
    schema: { type: "string" },
  },
  async execute(args, exec) {
    const params = args ?? {};
    const signal = exec.signal;
    const hostAgent = exec.agent;
    const config = exec.atelierConfig;
    const agents = discoverAgents();
    const prompts = discoverPrompts();
    const effectiveCwd = params.cwd ?? sessionCwd(hostAgent);

    // ── action: list ──────────────────────────────────────────────────
    if (params.action === "list") {
      const agentLines = agents
        .map((a) => {
          const tools = a.tools ? a.tools.join(", ") : "all";
          const tier = a.tier ?? config.defaultTier;
          const routes =
            tier === "inherit"
              ? [`pi/${readDefaultModelFromSettings()[0] ?? "(inherit)"}`]
              : resolveRouteChain(a, config).map(
                  (r) => `${r.harness}${r.model ? `/${r.model}` : ""}`,
                );
          return `| ${a.name} | ${tier} | ${routes.join(" → ") || "(no route)"} | ${a.description.slice(0, 36)}… | ${tools} |`;
        })
        .join("\n");
      const promptLines = prompts
        .map(
          (p) =>
            `| ${p.name} | ${p.mode} | ${p.description.slice(0, 40)}… | /${p.name} <${p.param}> |`,
        )
        .join("\n");
      const harnessLines = listAvailableHarnesses()
        .map(
          (h) =>
            `- **${h.id}** ✓ (\`${h.binaries[0]}\`)${h.interactive ? " ·interactive" : ""}${h.herdrKind ? ` ·herdr:${h.herdrKind}` : ""}${h.resumeCommand ? " ·resume" : ""}`,
        )
        .join("\n");
      return [
        "## Agents",
        "| Name | Tier | Route (harness/model) | Description | Tools |",
        "|------|------|----------------------|-------------|-------|",
        agentLines || "| (none) | | | | |",
        "",
        "## Harnesses",
        harnessLines || "(none detected)",
        "",
        "## Prompt Templates",
        "| Name | Mode | Description | Usage |",
        "|------|------|-------------|-------|",
        promptLines || "| (none) | | | |",
      ].join("\n");
    }

    // ── action: peers ─────────────────────────────────────────────────
    if (params.action === "peers") {
      const peers = listPeers();
      if (peers.length === 0) return "无存活 peer";
      const lines = peers.map((p) => {
        const busy = peerBusy(p);
        return (
          `| ${p.peerId} | ${p.agent} | ${p.harness} | ${p.paneId} | ` +
          `${p.alive ? (busy ? `busy(msg#${p.msgSeq})` : "idle") : "dead"} | ` +
          `${p.nativeSessionId ?? "-"} |`
        );
      });
      return [
        "## Peers",
        "| PeerId | Agent | Harness | Pane | State | NativeSession |",
        "|--------|-------|---------|------|-------|---------------|",
        ...lines,
        "",
        "操作：send(id,task) 追加指令（已回收 peer 自动 resume 重开） · wait(id) 收结果 · read(id) 看输出 · close(id) 退役",
      ].join("\n");
    }

    // ── action: send ──────────────────────────────────────────────────
    if (params.action === "send") {
      const task = params.task;
      if (!task) return "send 需要 task 参数";
      let peer = null;
      if (params.id) {
        peer = await ensurePeer(params.id, config);
        if (!peer) {
          return (
            `peer "${params.id}" 不存在或已关闭且无法 resume 恢复` +
            `（tmux 后端 / harness 未定义 resume-args 时不可恢复；` +
            `历史结果见 peerDir 的 result-N.md）。存活 peer: ${listPeers()
              .map((p) => p.peerId)
              .join(", ") || "none"}`
          );
        }
      } else if (params.agent) {
        peer = findReusablePeer({ agent: params.agent });
      }
      if (peer) {
        const busyBefore = peerBusy(peer);
        const sent = sendToPeer(peer, task, { images: params.images });
        if (!params.wait && sent.isNewTask)
          watchPeerAndPush(hostAgent, peer, sent.seq, Date.now(), effectiveCwd, config);
        if (params.wait) {
          const result = await waitForPeerMessage(peer, sent.seq, config, signal);
          return result.output;
        }
        return (
          `已发送到 peer **${peer.peerId}** (${peer.harness}) msg #${sent.seq}` +
          (busyBefore
            ? " —— peer 忙碌中，文本已注入输入框（舵手消息）"
            : " —— peer 空闲，作为新任务执行") +
          `\n收结果：action:wait id=${peer.peerId} · 看进度：action:read id=${peer.peerId}`
        );
      }
      if (!params.agent) {
        return "send 需要 id（peerId）或 agent（自动找空闲 peer）";
      }
      // 继续走下方 single 派发（agent+task 已齐）
    }

    // ── action: wait ──────────────────────────────────────────────────
    if (params.action === "wait") {
      if (!params.id) return "wait 需要 id（peerId 或 batchId）";
      const pending = pendingOps.get(params.id);
      if (pending) {
        pendingOps.delete(params.id);
        claimedBatches.add(params.id);
        const results = await pending.p;
        appendSessionLog(pending.mode, results);
        return formatResults(results);
      }
      const finished = finishedOps.get(params.id);
      if (finished) {
        return `该批次已完成并推送（句柄 ${params.id}）：\n\n${formatResults(finished.results)}`;
      }
      const m = params.id.match(/^(.*)-m(\d+)$/);
      const peer = getPeer(m ? m[1] : params.id);
      if (!peer) {
        return `未找到 peer/batch "${params.id}"（peers: ${listPeers()
          .map((p) => p.peerId)
          .join(", ") || "none"}）`;
      }
      const seq = m ? Number.parseInt(m[2], 10) : peer.msgSeq;
      const waitMsgId = `${peer.peerId}-m${seq}`;
      claimedPeers.add(waitMsgId);
      const result = await waitForPeerMessage(peer, seq, config, signal);
      if (!watchedPeers.has(waitMsgId)) claimedPeers.delete(waitMsgId);
      if (result.status === "completed") {
        ensureWorkfile(result, effectiveCwd, Date.now() - result.durationMs);
      }
      return result.output;
    }

    // ── action: read ──────────────────────────────────────────────────
    if (params.action === "read") {
      if (!params.id) return "read 需要 id（peerId）";
      const peer = getPeer(params.id);
      if (!peer) return `peer "${params.id}" 不存在或已关闭`;
      return readPeer(peer, params.lines ?? 60) || "(no output)";
    }

    // ── action: close ─────────────────────────────────────────────────
    if (params.action === "close") {
      if (!params.id) return "close 需要 id（peerId）";
      const peer = getPeer(params.id);
      if (!peer) return `peer "${params.id}" 不存在`;
      closePeer(peer);
      return `peer **${params.id}** 已关闭（agent=${peer.agent}, harness=${peer.harness}, msg#${peer.msgSeq}）`;
    }

    // ── action: focus（把 peer 的 pane 所在页拉到前台）──────────────────
    if (params.action === "focus") {
      if (!params.id) return "focus 需要 id（peerId）";
      const peer = getPeer(params.id);
      if (!peer) return `peer "${params.id}" 不存在或已关闭`;
      if (!focusPeer(peer)) {
        return `peer **${params.id}** 聚焦失败（后端不支持或 pane 已消失）`;
      }
      return `peer **${params.id}** 已拉到前台（pane=${peer.paneId}）`;
    }

    // ── action: status ────────────────────────────────────────────────
    if (params.action === "status") {
      if (params.id) {
        const runDir = getRunDir(params.id);
        try {
          const statusJson = JSON.parse(
            fs.readFileSync(path.join(runDir, "status.json"), "utf-8"),
          );
          return JSON.stringify(statusJson, null, 2);
        } catch {
          return `未找到 run: ${params.id}`;
        }
      }
      const running = listRunning();
      if (running.length === 0) return "无运行中的 peer";
      return running
        .map((r) => `- **${r.runId}**: ${r.output.slice(0, 80)}...`)
        .join("\n");
    }

    // ── chain 模式 ────────────────────────────────────────────────────
    if (params.chain && params.chain.length > 0) {
      if (params.chain.length > config.maxTasks) {
        return `chain 任务数 ${params.chain.length} 超过上限 ${config.maxTasks}`;
      }
      const chainEntries = [];
      for (const t of params.chain) {
        const agent = agents.find((a) => a.name === t.agent);
        if (!agent) {
          const available = agents.map((a) => a.name).join(", ") || "none";
          return `未知 agent: "${t.agent}"。可用: ${available}`;
        }
        chainEntries.push({ agent, task: t.task, cwd: params.cwd });
      }
      try {
        if (params.wait !== true) {
          const batchId = generateRunId();
          const chainP = pendingCatch(
            runChain(
              chainEntries,
              config,
              effectiveCwd,
              params.task,
              params.model,
              undefined,
              params.harness,
              batchId,
            ),
          );
          pendingOps.set(batchId, { mode: "chain", p: chainP, agentId: String(hostAgent?.id ?? "") });
          attachBatchPush(hostAgent, batchId, "chain", chainP);
          return `chain 已后台派发（${params.chain.length} 步），句柄 **${batchId}**。完成后自动推送，无需等待；如无其他独立工作请直接结束本轮。手动核查：action:wait id=${batchId} · 看 peers：action:peers`;
        }
        const results = await runChain(
          chainEntries,
          config,
          effectiveCwd,
          params.task,
          params.model,
          signal,
          params.harness,
        );
        appendSessionLog("chain", results);
        return formatResults(results);
      } catch (err) {
        return `启动失败: ${err.message}`;
      }
    }

    // ── parallel 模式 ─────────────────────────────────────────────────
    if (params.tasks && params.tasks.length > 0) {
      if (params.tasks.length > config.maxTasks) {
        return `parallel 任务数 ${params.tasks.length} 超过上限 ${config.maxTasks}`;
      }
      const taskEntries = [];
      for (const t of params.tasks) {
        const agent = agents.find((a) => a.name === t.agent);
        if (!agent) {
          const available = agents.map((a) => a.name).join(", ") || "none";
          return `未知 agent: "${t.agent}"。可用: ${available}`;
        }
        taskEntries.push({ agent, task: t.task, cwd: params.cwd });
      }
      try {
        if (params.wait !== true) {
          const batchId = generateRunId();
          const parallelP = pendingCatch(
            runParallelBatches(
              taskEntries,
              config,
              effectiveCwd,
              params.model,
              undefined,
              params.harness,
              batchId,
            ),
          );
          pendingOps.set(batchId, { mode: "parallel", p: parallelP, agentId: String(hostAgent?.id ?? "") });
          attachBatchPush(hostAgent, batchId, "parallel", parallelP);
          return `parallel 已后台派发（${params.tasks.length} 个 peer），句柄 **${batchId}**。完成后自动推送，无需等待；如无其他独立工作请直接结束本轮。手动核查：action:wait id=${batchId} · 看 peers：action:peers`;
        }
        const results = await runParallelBatches(
          taskEntries,
          config,
          effectiveCwd,
          params.model,
          signal,
          params.harness,
        );
        appendSessionLog("parallel", results);
        return formatResults(results);
      } catch (err) {
        return `启动失败: ${err.message}`;
      }
    }

    // ── send 未命中 peer 或 single 派发 ────────────────────────────────
    if (params.agent && params.task) {
      if (params.agent === "worker") {
        if (checkWorkerSingleOverride() === "warn") {
          return workerSingleWarnText();
        }
      }
      const agent = agents.find((a) => a.name === params.agent);
      if (!agent) {
        const available = agents.map((a) => a.name).join(", ") || "none";
        return `未知 agent: "${params.agent}"。可用: ${available}`;
      }

      try {
        const startedAt = Date.now();
        let peer = null;
        if (params.peer) {
          peer = await ensurePeer(params.peer, config);
          if (!peer) {
            return (
              `peer "${params.peer}" 不存在或已关闭且无法 resume 恢复` +
              `（历史结果见 peerDir 的 result-N.md）。存活 peer: ${listPeers()
                .map((p) => p.peerId)
                .join(", ") || "none"}`
            );
          }
        }

        // ── 阻塞路径：wait:true → 路由链 fallback 重试 ──
        if (params.wait === true && !peer) {
          const result = await executeWithFallback(
            agent,
            params.task,
            config,
            effectiveCwd,
            params.model,
            signal,
            undefined,
            50,
            params.images,
            params.isSystemSpawned,
            undefined,
            params.harness,
          );
          if (result.status === "completed") {
            ensureWorkfile(result, effectiveCwd, startedAt);
          }
          appendSessionLog("single", [result]);
          return result.output;
        }

        // ── 异步路径（默认）：开 peer / 复用 peer → send → 返回句柄 ──
        if (!peer) {
          const routes = resolveRouteChain(
            agent,
            config,
            params.harness || params.model
              ? { harness: params.harness, model: params.model }
              : undefined,
          );
          const route = routes.find((r) => {
            const a = getAdapter(r.harness);
            return a !== null && a.interactive;
          });
          if (!route) {
            return `没有可用 harness（路由: ${routes
              .map((r) => r.harness)
              .join(" → ") || "none"}）。请检查 PATH 或调整 tier routes`;
          }
          peer = await openPeer({
            agent,
            route,
            adapter: getAdapter(route.harness),
            config,
            cwd: effectiveCwd,
            newTab: `sub:${agent.name}`,
            isSystemSpawned: params.isSystemSpawned,
          });
        }
        const sent = sendToPeer(peer, params.task, { images: params.images });
        if (params.wait !== true && sent.isNewTask) {
          watchPeerAndPush(hostAgent, peer, sent.seq, startedAt, effectiveCwd, config);
        }
        if (params.wait === true) {
          const result = await waitForPeerMessage(peer, sent.seq, config, signal);
          if (result.status === "completed") {
            ensureWorkfile(result, effectiveCwd, startedAt);
          }
          appendSessionLog("single", [result]);
          return result.output;
        }
        return (
          `已派发到 peer **${peer.peerId}**` +
          `（${peer.agent}@${peer.harness}，pane ${peer.paneId}）msg #${sent.seq}\n` +
          `完成后自动推送，无需等待；如无其他独立工作请直接结束本轮。` +
          `手动核查：action:wait id=${peer.peerId} · ` +
          `看进度：action:read id=${peer.peerId} · ` +
          `追加指令：action:send id=${peer.peerId}`
        );
      } catch (err) {
        return `启动失败: ${err.message}`;
      }
    }

    const available = agents.map((a) => a.name).join(", ") || "none";
    return `参数无效。可用 agent: ${available}`;
  },
});

export const name = "atelier-peer-tool";
export const inject = ["tools"];

/** config 在 index.js 组合（文件配置 + cordis config 覆盖）后闭包传入。 */
export function apply(ctx, cfg) {
  if (cfg.enabled === false) return;
  // 把 config 缝进 exec：工具定义是模块级单例，execute 从 exec.atelierConfig
  // 读本次 apply 的配置（热重载时新 apply 覆盖定义内字段）。
  const def = { ...definition };
  const inner = def.execute;
  def.execute = (args, exec) =>
    inner(args, { ...exec, atelierConfig: cfg.atelier });
  const unregister = ctx.tools.register(def);

  // 会话销毁时清理该 agent 名下的推送状态（等价 pi session_shutdown）
  const dispose = ctx.on("agent/disposed", ({ agent }) =>
    cleanupAgentOps(agent?.id),
  );
  return () => {
    unregister?.();
    dispose?.();
  };
}
