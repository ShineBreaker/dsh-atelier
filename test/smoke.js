// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * 冒烟测试：契约 + 真实 herdr 只读调用。
 * 运行：node test/smoke.js（需要 herdr server 在跑；无 server 时只读项会 FAIL）。
 * 写操作端到端（split/run/send/read 闭环）不在此自动跑，见 README「验证」。
 */

import assert from "node:assert/strict";
import * as plugin from "../index.js";
import { definition } from "../tools/herdr.js";

let failed = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`ok    ${label}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${label}\n      ${err.message}`);
  }
}

// ── 契约：apply 经假 ctx 注册，definition 符合 ToolDefinition 形状 ──

const registeredNames = [];
const fakeCtx = {
  tools: {
    register(def) {
      registeredNames.push(def.name);
      return () => {};
    },
  },
  on: () => () => {},
  commands: { register: () => () => {} },
  systemPrompt: { section: () => () => {} },
  llm: { listModels: async () => [] },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

await check("apply 注册工具一次并交还反注册函数", () => {
  const dispose = plugin.apply(fakeCtx, {});
  assert.ok(registeredNames.includes("herdr"));
  assert.ok(registeredNames.includes("peer"));
  assert.equal(typeof dispose, "function");
});

await check("definition 契约形状（ToolSchema + output + execute）", () => {
  assert.equal(definition.name, "herdr");
  assert.ok(definition.description.length > 0);
  assert.equal(definition.parameters.type, "object");
  assert.deepEqual(definition.parameters.required, ["action"]);
  assert.ok(definition.output.schema);
  assert.deepEqual(definition.output.render({}, "hello"), [
    { type: "text", text: "hello" },
  ]);
  assert.equal(typeof definition.execute, "function");
});

await check("enabled:false 不注册", () => {
  registeredNames.length = 0;
  plugin.apply(fakeCtx, { enabled: false });
  assert.equal(registeredNames.length, 0);
});

// ── 执行：参数薄验 ──

await check("read 缺 pane_id 抛错", () =>
  assert.rejects(() => definition.execute({ action: "read" }), /pane_id/),
);

await check("send 缺 text 抛错", () =>
  assert.rejects(() => definition.execute({ action: "send", pane_id: "x:y" }), /text/),
);

await check("未知 action 抛错", () =>
  assert.rejects(() => definition.execute({ action: "rm-rf" }), /unknown action/),
);

// ── 执行：真实 herdr 只读调用 ──

await check("herdr status 真实调用", async () => {
  const out = await definition.execute({ action: "status" });
  assert.ok(out.includes("version"), `status 输出异常: ${out.slice(0, 120)}`);
});

await check("herdr workspaces 真实调用（投影）", async () => {
  const out = await definition.execute({ action: "workspaces" });
  assert.match(out, /^workspaces \(\d+\):|^\(no workspaces\)/);
});

await check("herdr panes 真实调用（投影）", async () => {
  const out = await definition.execute({ action: "panes" });
  assert.match(out, /^panes \(\d+\):|^\(no panes\)/);
});

await check("herdr agents 真实调用（投影）", async () => {
  const out = await definition.execute({ action: "agents" });
  assert.match(out, /^agents \(\d+\):|^\(no agents\)/);
});

await check("herdr read 首个 pane 三行", async () => {
  const list = await definition.execute({ action: "panes" });
  const firstPane = list.match(/^(\S+:\S+)\s/m);
  if (!firstPane) return; // 无 pane 时跳过
  const out = await definition.execute({ action: "read", pane_id: firstPane[1], lines: 3 });
  assert.equal(typeof out, "string");
});

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
