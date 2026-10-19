// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * atelier hooks 半边 — pi index.ts 三个 hook 块的 dsh 移植：
 *
 *   1. 主会话 agent 上下文注入（pi before_agent_start → dsh
 *      systemPrompt.section text 回调）：命令注入标记 > plan mode →
 *      planner / 默认 worker。section text 每个请求重算，与 pi 的
 *      请求级追加语义对齐；dsh 该回调拿 {agent}，durable log 判定 plan 态。
 *
 *   2. 视觉移交（pi before_agent_start images 分支 → agent/pre-step
 *      waterfall）：当前模型无 image modality 时把图片落盘 tmp 并注入
 *      visual peer 指引消息。
 *
 *   3. plan review gate（pi tool_call 拦 plannotator_submit_plan →
 *      tools/pre-execute 拦 exit_plan_mode）：首次 deny 注入 griller
 *      方法论；同一会话同一份 plan 的第二次调用放行并落盘
 *      .agents/current-plan.md。
 *
 *   4. session 锚点 + 孤儿认领（pi session id 提取 → agent/created）：
 *      hostSession.id 记到 peer.json 归属；orphanRecovery 一次性收尾。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  isSubagent,
  ownMessage,
  planModeActive,
  sessionCwd,
} from "./lib/message.js";
import { pendingContextInject } from "./lib/state.js";
import { stripSubagentOnlySection, resolveAgentFile } from "./core/context.ts";
import { hostSession } from "./core/session.ts";
import { detectBackend } from "./runtime/multiplexer/detect.ts";
import { orphanRecovery } from "./registry/orphan-recovery.ts";
import { rebuildFromStatusFiles } from "./registry/registry.ts";
import { finalizeSessionLog } from "./runtime/session-log.ts";

export const name = "atelier-hooks";

/** llm 用于视觉移交的模型 modality 检测；tools/commands 由另两个半边注入。 */
export const inject = ["tools", "systemPrompt", "llm"];

/** system-prompt section 名。 */
const SECTION_NAME = "atelier-main-context";

/**
 * 读 agent .md 的 body，剥离 frontmatter + subagent-only 段。
 * 等价 pi loadMainSessionAgentContext。
 */
function loadMainSessionAgentContext(agentName) {
  const agentPath = resolveAgentFile(agentName);
  if (!agentPath) return null;
  try {
    const content = fs.readFileSync(agentPath, "utf-8");
    return stripSubagentOnlySection(content);
  } catch {
    return null;
  }
}

// ─── Plan Review Gate ────────────────────────────────────────────────────────

/**
 * 构造 gate 拦截提示词（等价 pi buildPlanReviewGatePrompt）。
 * dsh 侧 plan 内容内联在 exit_plan_mode.plan 参数，不落文件——提示词引导
 * 模型把 plan 就地摆出来逐项诘问，不再指向一个文件路径。
 */
function buildPlanReviewGatePrompt() {
  const grillerBody = loadMainSessionAgentContext("griller");
  const header = [
    "⛔ 计划提交前需要先经过多轮对抗式诘问（grill）。",
    "",
    "请把你刚才提交的 plan 完整展示给用户，然后以下方 griller 方法论为指导，",
    "对计划逐项压测——一次只问用户一个问题，每个问题附带你的推荐答案。",
    "事实（代码、配置、文档）自己查证，只有需要用户价值判断的决策才问用户。",
    "直到所有关键假设、边界、替代方案都被用户确认，才允许再次调用",
    "exit_plan_mode 提交（同一份计划的第二次调用不会再被拦截）。",
    "",
    "═══════════════════════════════════════════════════════════",
    "                    griller 方法论",
    "═══════════════════════════════════════════════════════════",
    "",
  ].join("\n");

  const grillerSection =
    grillerBody ??
    [
      "（griller.md 加载失败，使用兜底诘问维度：）",
      "1. 假设检验：计划基于哪些未经验证的假设？",
      "2. 范围边界：遗漏了什么场景？边界条件怎么处理？",
      "3. 替代方案：有没有更简单/更健壮的方法？",
      "4. 架构一致：与现有模式冲突吗？",
      "5. 回滚风险：不可逆步骤的风险和缓解措施？",
    ].join("\n");

  return header + "\n" + grillerSection;
}

/** plan 的去重键：agent + 内容前 200 字（防同会话新 plan 被误放行）。 */
function planKey(agent, planText) {
  return `${agent?.id ?? "?"}::${String(planText ?? "").slice(0, 200)}`;
}

// ─── 视觉移交 ────────────────────────────────────────────────────────────────

/** message.content 里的 image block（dsh ContentBlock: {type:"image",...}）。 */
function extractImages(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b) => b && typeof b === "object" && b.type === "image" && (b.data || b.url),
  );
}

function extForMime(mime) {
  const m = (mime ?? "image/png").toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("gif")) return ".gif";
  if (m.includes("webp")) return ".webp";
  if (m.includes("bmp")) return ".bmp";
  if (m.includes("svg")) return ".svg";
  return ".png";
}

/**
 * 当前模型是否支持视觉：ctx.llm.listModels(provider) 的 descriptor
 * inputModalities 查 "image"；查不到 descriptor → 返回 undefined（不拦截）。
 */
async function modelAcceptsImages(ctx, agent) {
  const provider = agent?.options?.provider;
  const modelId = agent?.options?.model;
  if (!provider || !modelId || !ctx.llm?.listModels) return undefined;
  try {
    const models = await ctx.llm.listModels(provider);
    const desc = Array.isArray(models)
      ? models.find((m) => m.id === modelId || m.name === modelId)
      : undefined;
    if (!desc?.inputModalities) return undefined;
    return desc.inputModalities.includes("image");
  } catch {
    return undefined;
  }
}

export function apply(ctx, cfg) {
  if (cfg.enabled === false) return;
  const disposers = [];

  // ── 0. Registry 启动 rebuild（best-effort，与 pi 同语义） ─────────────
  let registryOk = false;
  try {
    const report = rebuildFromStatusFiles();
    registryOk = true;
    if (report.indexed > 0) {
      ctx.logger.info(`[atelier:registry] indexed ${report.indexed} runs from status.json`);
    }
  } catch (err) {
    ctx.logger.warn(`[atelier:registry] init failed, continuing without index: ${String(err)}`);
  }

  // 孤儿认领（一次）：session 锚点建立后按「当前 session 名下」归属收尾。
  let orphanDone = false;
  const runOrphanRecoveryOnce = () => {
    if (orphanDone || !registryOk) return;
    orphanDone = true;
    try {
      let probes;
      try {
        const backend = detectBackend();
        probes = {
          paneAlive: (id) => backend.isAlive(id),
          agentStatus: (id) => backend.agentStatus?.(id) ?? null,
          agentSession: (id) => backend.agentSession?.(id) ?? null,
        };
      } catch {
        probes = undefined;
      }
      const r = orphanRecovery(Date.now(), probes);
      if (r.recovered + r.settled > 0) {
        ctx.logger.info(
          `[atelier:registry] orphan recovery: ${r.recovered} 孤儿收尾, ${r.settled} 代写终态` +
            `（session ${hostSession.id?.slice(0, 8)}…）`,
        );
      }
    } catch (err) {
      ctx.logger.warn(`[atelier:registry] orphan recovery failed: ${String(err)}`);
    }
  };

  // ── 1. agent/created：session 锚点 + 孤儿认领 ─────────────────────────
  disposers.push(
    ctx.on("agent/created", ({ agent }) => {
      if (isSubagent(agent)) return;
      if (!hostSession.id && agent?.session?.header?.id) {
        hostSession.id = agent.session.header.id;
        runOrphanRecoveryOnce();
      }
    }),
  );

  // ── 2. 主会话上下文注入（worker/planner/命令标记）────────────────────
  // pi 走 before_agent_start 往 systemPrompt 追加；dsh 等价物是
  // systemPrompt.section 的 text 回调——每个请求重算、拿 {agent}。
  // 优先级（同 pi）：命令注入标记 > plan mode → planner / 默认 worker。
  const sectionHandle = ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: 10350, // 在 agenote(10300)/gate-notice(10301) 之后
    interpolate: false,
    text: (context) => {
      const agent = context?.agent;
      if (!agent || isSubagent(agent)) return "";

      // session 锚点兜底（agent/created 未触发过的极端路径）
      if (!hostSession.id && agent?.session?.header?.id) {
        hostSession.id = agent.session.header.id;
        runOrphanRecoveryOnce();
      }

      // 命令注入标记（/<agent> 空上下文）——一次性消费
      const pending = pendingContextInject.get(String(agent.id));
      if (pending) {
        pendingContextInject.delete(String(agent.id));
        const content = loadMainSessionAgentContext(pending);
        if (content) return content;
        // 加载失败 → 走默认逻辑
      }

      const planMode = planModeActive(agent.session);
      const agentName = planMode ? "planner" : "worker";
      const body = loadMainSessionAgentContext(agentName);
      if (!body) return "";
      const priorityHint = planMode
        ? "\n\n# 优先级提示：plan mode 下，plan-mode 注入的规划阶段约束优先级最高，与本文冲突时遵循 plan-mode。\n"
        : "";
      return priorityHint + "\n\n" + body;
    },
  });
  // layers.effect 返回值即注销函数（cordis scoped effect）
  if (typeof sectionHandle === "function") disposers.push(sectionHandle);

  // ── 3. 视觉移交（agent/pre-step waterfall）───────────────────────────
  // pi：event.images 有图片且当前模型不支持视觉 → 落盘 + 注入 visual 指引。
  // dsh：pre-step 决策对象里追加一条 ownMessage（agent-instructions 同款手法）。
  disposers.push(
    ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
      const decision = await next();
      if (isSubagent(agent)) return decision;
      if (decision?.kind === "reject") return decision;

      // 最近一条带图片的 user 消息
      const list = decision?.messages ?? messages ?? [];
      const lastWithImages = [...list]
        .reverse()
        .find((m) => m?.role === "user" && extractImages(m).length > 0);
      if (!lastWithImages) return decision;
      const images = extractImages(lastWithImages);

      // 模型能力：descriptor 明确无 image 才移交；未知不拦
      const accepts = await modelAcceptsImages(ctx, agent);
      if (accepts !== false) return decision;

      // 落盘到 tmp 供 visual peer 读取
      try {
        const tmpDir = path.join(os.tmpdir(), "dsh-atelier-visual");
        fs.mkdirSync(tmpDir, { recursive: true });
        const savedPaths = [];
        images.forEach((img, i) => {
          if (!img.data) return;
          const ext = extForMime(img.mimeType);
          const file = path.join(tmpDir, `img-${Date.now()}-${i}${ext}`);
          fs.writeFileSync(file, Buffer.from(img.data, "base64"));
          savedPaths.push(file);
        });
        if (savedPaths.length === 0) return decision;

        signal?.throwIfAborted?.();
        const hint = [
          "🖼️ 检测到图片输入，但当前模型不支持视觉。",
          "请使用 visual peer 分析以下图片：",
          "",
          `peer(agent: "visual", task: "分析以下图片", images: [${savedPaths.map((p) => `"${p}"`).join(", ")}])`,
          "",
          `图片文件：\n${savedPaths.map((p) => `  - ${p}`).join("\n")}`,
        ].join("\n");
        return {
          ...decision,
          messages: [...(decision.messages ?? []), ownMessage(hint)],
        };
      } catch {
        return decision;
      }
    }),
  );

  // ── 4. Plan review gate（tools/pre-execute 拦 exit_plan_mode）─────────
  // pi 拦 plannotator_submit_plan（filePath 键）；dsh 拦 exit_plan_mode，
  // plan 全文在参数 plan 字段——同 agent+同 plan 键的第二次调用放行并落盘。
  {
    const reviewedPlans = new Set();
    disposers.push(
      ctx.on("tools/pre-execute", async (exec, next) => {
        if (exec.name !== "exit_plan_mode") return next();
        const planText = String(exec.arguments?.plan ?? "");
        if (!planText.trim()) return next();
        const key = planKey(exec.agent, planText);

        // 第二次调用（诘问已完成）→ 放行 + 落盘 .agents/current-plan.md
        if (reviewedPlans.has(key)) {
          reviewedPlans.delete(key);
          try {
            const target = path.join(
              sessionCwd(exec.agent),
              ".agents",
              "current-plan.md",
            );
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, planText, "utf-8");
          } catch {
            // 落盘失败不阻塞
          }
          return next();
        }

        // 首次调用 → deny，注入 griller 方法论要求多轮诘问
        reviewedPlans.add(key);
        return { kind: "deny", reason: buildPlanReviewGatePrompt() };
      }),
    );

    // 会话销毁清 reviewedPlans（等价 pi session_shutdown 清理）
    disposers.push(ctx.on("agent/disposed", () => reviewedPlans.clear()));
  }

  // ── 5. agent/disposed：session log finalize（等价 pi finalizeSessionLog）─
  disposers.push(
    ctx.on("agent/disposed", ({ agent }) => {
      if (isSubagent(agent)) return;
      try {
        finalizeSessionLog(sessionCwd(agent));
      } catch {
        // best-effort
      }
      hostSession.id = null;
    }),
  );

  return () => {
    for (const d of disposers) d?.();
  };
}
