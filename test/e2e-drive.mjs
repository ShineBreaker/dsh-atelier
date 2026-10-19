// dsh-atelier headless E2E driver — fake ctx 捕获注册面，直接驱动工具/命令/hook。
// 用法：HERDR_ENV=1 node test/e2e-drive.mjs <case|all>
// （workspace 默认 /tmp/atelier-e2e，可用 ATELIER_E2E_CWD 覆盖；
//   wait/tasks/chain/resume/peers/focus 用例会经 herdr 真派 pi peer，自动回收）
import * as fs from "node:fs";
import * as path from "node:path";

const PLUGIN = new URL("..", import.meta.url).pathname;
const CWD = process.env.ATELIER_E2E_CWD || "/tmp/atelier-e2e";
process.chdir(CWD);

// ── fake ctx ──────────────────────────────────────────────────────────
const events = new Map();
const commands = new Map();
const tools = new Map();
const sections = [];
const deliveries = [];

let imageOk = true; // 视觉移交用例切换
const ctx = {
  on(ev, fn) {
    if (!events.has(ev)) events.set(ev, []);
    events.get(ev).push(fn);
    return () => {};
  },
  systemPrompt: {
    section: (s) => {
      sections.push(s);
      return () => {};
    },
  },
  commands: { register: (d) => (commands.set(d.name, d), () => {}) },
  tools: { register: (d) => (tools.set(d.name, d), () => {}) },
  llm: {
    listModels: async () => [
      {
        id: "step-5-preview",
        inputModalities: imageOk ? ["text", "image"] : ["text"],
      },
    ],
  },
  logger: {
    info: (...a) => console.log("[log]", ...a),
    warn: (...a) => console.warn("[warn]", ...a),
    error: (...a) => console.error("[err]", ...a),
  },
};

const session = {
  header: { id: "sess-e2e-headless", cwd: CWD },
  surface: { nodes: [] },
  eventAt: () => null,
};
const agent = {
  id: "agent-e2e",
  session,
  options: { provider: "step-plan", model: "step-5-preview" },
  followup: (msg) => {
    const text = msg.content?.[0]?.text ?? "";
    deliveries.push(text);
    console.log("📨 DELIVERY:", text.slice(0, 200).replaceAll("\n", " ⏎ "));
  },
};
const exec = { agent, signal: new AbortController().signal };

const fire = async (ev, payload, next) => {
  const hs = events.get(ev) ?? [];
  const results = [];
  for (const h of hs) results.push(await h(payload, next));
  return results;
};

const plugin = await import(`${PLUGIN}/index.js`);
plugin.apply(ctx, {});
console.log(
  `registered: tools=[${[...tools.keys()]}] commands=${commands.size} sections=${sections.length}`,
);

// 锚定 hostSession（agent/created）
await fire("agent/created", { agent });

const peer = tools.get("peer");
const invoke = (args) => peer.execute(args, exec);

async function waitDeliveries(n, timeoutMs) {
  const t0 = Date.now();
  while (deliveries.length < n && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  return deliveries.length;
}

const case_ = process.argv[2] ?? "all";
const out = {};

if (case_ === "list" || case_ === "all") {
  out.list = (await invoke({ action: "list" })).slice(0, 400);
}

if (case_ === "wait" || case_ === "all") {
  console.log("── wait:true 单发 ──");
  out.wait = await invoke({
    agent: "scout",
    task: "只回复 PONG 一个词，不要做任何调研或写文件",
    wait: true,
  });
}

if (case_ === "tasks" || case_ === "all") {
  console.log("── tasks 并行 ──");
  const before = deliveries.length;
  out.tasksHandle = await invoke({
    tasks: [
      { agent: "scout", task: "只回复 ALPHA 一个词" },
      { agent: "scout", task: "只回复 BETA 一个词" },
    ],
  });
  console.log("handle:", out.tasksHandle);
  const got = await waitDeliveries(before + 1, 240000);
  out.tasksDelivered = got - before;
}

if (case_ === "chain" || case_ === "all") {
  console.log("── chain 串行 ──");
  const before = deliveries.length;
  out.chainHandle = await invoke({
    chain: [
      { agent: "scout", task: "生成一个5位随机数字，只回复该数字" },
      { agent: "scout", task: "上一步给了你什么内容？只回复：{previous}" },
    ],
  });
  console.log("handle:", out.chainHandle);
  const got = await waitDeliveries(before + 1, 360000);
  out.chainDelivered = got - before;
}

if (case_ === "mgmt" || case_ === "all") {
  console.log("── 管理动作（peers/status/read/focus）──");
  out.peers = (await invoke({ action: "peers" })).slice(0, 600);
  const m = out.peers.match(/sa-[a-z0-9]+-[a-z0-9]+/);
  if (m) {
    out.statusOne = (await invoke({ action: "status", id: m[0] })).slice(0, 300);
    out.read = (await invoke({ action: "read", id: m[0], lines: 10 })).slice(0, 300);
    out.focus = await invoke({ action: "focus", id: m[0] });
  } else {
    out.mgmtSkip = "无存活 peer";
  }
}

if (case_ === "workflow" || case_ === "all") {
  console.log("── /atelier-workflow ──");
  const wf = commands.get("atelier-workflow");
  out.wfList = (await wf.handler({ rawInput: "list", agent })).text.slice(0, 400);
  const id = out.wfList.match(/wf-[a-z0-9-]+/)?.[0];
  if (id) out.wfShow = (await wf.handler({ rawInput: `show ${id}`, agent })).text.slice(0, 400);
}

if (case_ === "resume" || case_ === "all") {
  console.log("── /atelier-resume（已完成链 → 无需续跳）──");
  const rs = commands.get("atelier-resume");
  const wf = commands.get("atelier-workflow");
  const list = (await wf.handler({ rawInput: "list", agent })).text;
  const id = list.match(/sa-[a-z0-9-]+/)?.[0]; // resume 吃 parentRunId（chain 句柄）
  out.resumeDone = id
    ? (await rs.handler({ rawInput: id, agent })).text
    : "无 workflow 可测";
}

if (case_ === "plangate" || case_ === "all") {
  console.log("── plan gate ──");
  const execPayload = {
    name: "exit_plan_mode",
    arguments: { plan: "1. 做A\n2. 做B\n3. 验证" },
    agent,
  };
  const next = async () => ({ kind: "allow" });
  const [first] = await fire("tools/pre-execute", execPayload, next);
  out.gateFirst = first?.kind;
  const [second] = await fire("tools/pre-execute", execPayload, next);
  out.gateSecond = second?.kind;
  out.planWritten = fs.existsSync(path.join(CWD, ".agents", "current-plan.md"));
}

if (case_ === "visual" || case_ === "all") {
  console.log("── 视觉移交 ──");
  imageOk = false;
  const imgMsg = {
    role: "user",
    content: [
      { type: "text", text: "看下这张图" },
      { type: "image", mimeType: "image/png", data: Buffer.from("PNGDATA").toString("base64") },
    ],
  };
  const next = async () => ({ kind: "enter", messages: [imgMsg] });
  const [decision] = await fire("agent/pre-step", { agent, messages: [imgMsg], signal: null }, next);
  const last = decision?.messages?.at(-1);
  out.visualHint = last?.content?.[0]?.text?.slice(0, 200);
  imageOk = true;
}

if (case_ === "orphan" || case_ === "all") {
  console.log("── 孤儿认领 ──");
  const { registerRun } = await import(`${PLUGIN}/registry/registry.ts`);
  const { orphanRecovery } = await import(`${PLUGIN}/registry/orphan-recovery.ts`);
  const { hostSession } = await import(`${PLUGIN}/core/session.ts`);
  hostSession.id = session.header.id;

  // 伪造孤儿：peer.json 归本 session、pane 已死、status 卡 running
  const orphanDir = path.join(CWD, "orphan-peer-sa-test000-dead01");
  fs.mkdirSync(orphanDir, { recursive: true });
  const orphanPeer = {
    peerId: "sa-test000-dead01",
    peerDir: orphanDir,
    paneId: "w0:p999",
    agent: "scout",
    harness: "pi",
    alive: true,
    msgSeq: 1,
    sessionId: session.header.id,
  };
  fs.writeFileSync(path.join(orphanDir, "peer.json"), JSON.stringify(orphanPeer));
  fs.writeFileSync(path.join(orphanDir, "status.json"), JSON.stringify({ status: "running", msgSeq: 1 }));
  registerRun({
    runId: "sa-test000-dead01-m1",
    agent: "scout",
    mode: "peer",
    runDir: orphanDir,
    taskExcerpt: "orphan test",
    peerId: "sa-test000-dead01",
    msgSeq: 1,
    harness: "pi",
  });
  const report = orphanRecovery(Date.now(), {
    paneAlive: () => false,
    agentStatus: () => null,
    agentSession: () => null,
  });
  out.orphan = report;
  out.orphanStatus = JSON.parse(fs.readFileSync(path.join(orphanDir, "status.json"), "utf-8"));
}

if (case_ === "inject" || case_ === "all") {
  console.log("── systemPrompt 注入（默认 worker + 命令标记 + plan mode）──");
  const sec = sections.find((s) => s.name === "atelier-main-context");
  out.injectDefault = sec.text({ agent }).slice(0, 120);
  // 命令标记路径
  const { pendingContextInject } = await import(`${PLUGIN}/lib/state.js`);
  pendingContextInject.set(String(agent.id), "reviewer");
  out.injectCmd = sec.text({ agent }).slice(0, 120);
  // plan mode
  session.surface.nodes = [1];
  session.eventAt = (s) => (s === 1 ? { type: "plan/mode", data: { active: true } } : null);
  out.injectPlan = sec.text({ agent }).slice(0, 120);
  session.surface.nodes = [];
}

console.log("\n═══════ RESULT ═══════");
console.log(JSON.stringify(out, null, 2));
