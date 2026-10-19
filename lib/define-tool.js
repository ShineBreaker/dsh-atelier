// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * defineTool 手搓等价物。
 *
 * 为什么不 import @deepseek-ai/dsh-tools：该包 lib/index.js 静态 import
 * @deepseek-ai/cordis / dsh-scope / dsh-llm / dsh-sandbox 等 peer，而 profile
 * node_modules（pnpm hoisted）只平铺 profile 自身依赖树——dsh 核心家族仅存在
 * 于 CLI 启动器的 .pnpm 虚拟树并由 NODE_PATH 注入，ESM import 不读 NODE_PATH，
 * 故插件侧 import 必失败（本机现存插件全部零 @deepseek-ai import，同一约束）。
 *
 * 为什么手搓可行：上游 defineTool 经核对（0.2.0-rc.2 lib/index.js）是纯函数——
 * options 进、普通对象出，无 ctx/服务绑定；产物即 ToolDefinition 契约形状
 * （name/description/parameters + output{schema,render} + execute）。本模块
 * 复刻该产物形状，与宿主注册表契约对齐。
 *
 * 与上游差异：省去执行前 JSON Schema 强校验（必填字段在 execute 内薄验）；
 * output.schema 仍按声明提供（宿主据此约束 canonical value）。
 */

/** 默认 renderer：canonical value → 单文本 content block。 */
function defaultRender(_args, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return [{ type: "text", text }];
}

/**
 * 构造宿主注册表可接受的工具定义。
 *
 * @param {object} options
 * @param {string} options.name 模型可见的工具名
 * @param {string} options.description 模型可见的描述
 * @param {Record<string, unknown>} options.parameters 参数 JSON Schema
 * @param {{schema: Record<string, unknown>, render?: Function}} options.output 输出声明
 * @param {(args: unknown, exec: unknown) => Promise<unknown>} options.execute 执行体
 * @param {number} [options.timeoutMs] 协作式超时（声明即断言 execute 转发 exec.signal）
 */
export function defineTool({
  name,
  description,
  parameters,
  output,
  execute,
  timeoutMs,
}) {
  if (!name || !description) {
    throw new Error("defineTool: name and description are required");
  }
  if (typeof execute !== "function") {
    throw new Error(`defineTool(${name}): execute must be a function`);
  }
  if (!output?.schema) {
    throw new Error(`defineTool(${name}): output.schema is required`);
  }
  return {
    name,
    description,
    parameters,
    output: {
      schema: output.schema,
      render: output.render ?? defaultRender,
    },
    execute,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}
