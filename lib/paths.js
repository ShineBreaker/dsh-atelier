// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * dsh-atelier 路径解析 — pi 侧 `getAgentDir()` 的等价物。
 *
 * 迁移策略：每个用户可写位置都先看 `~/.config/dsh-atelier/`（新根），
 * 再回退 `~/.config/pi/`（旧根）——用户从 pi 迁移到 dsh 时，既有
 * atelier.json / agents/ / harnesses.toml 继续生效，无需手拷。
 *
 * pi 自身的 settings.json 例外：它配置的是 pi harness peer（pi CLI 仍
 * 作为外部 harness 安装在机上），atelier 派生 pi peer 时读 pi 自己的
 * 默认模型，所以 runner.ts 仍直接读 ~/.config/pi/settings.json。
 */

import * as os from "node:os";
import * as path from "node:path";

/** dsh-atelier 用户配置根：$XDG_CONFIG_HOME/dsh-atelier */
export function atelierConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "dsh-atelier");
}

/** pi 旧配置根：$XDG_CONFIG_HOME/pi（迁移回退 + pi harness peer 的配置） */
export function legacyPiConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "pi");
}

/** 独立配置文件候选（先找到的赢）：dsh-atelier 新根 → pi 旧根回退 */
export function configFileCandidates() {
  return [
    path.join(atelierConfigDir(), "atelier.json"),
    path.join(legacyPiConfigDir(), "atelier.json"),
  ];
}

/** 新配置/覆盖文件的默认写入根 */
export function defaultConfigTarget() {
  return path.join(atelierConfigDir(), "atelier.json");
}

/** 用户自定义 agent 目录：dsh-atelier/agents → pi/agents 回退 */
export function userAgentDirs() {
  return [
    path.join(atelierConfigDir(), "agents"),
    path.join(legacyPiConfigDir(), "agents"),
  ];
}

/** 用户自定义 prompt 目录：同上 */
export function userPromptDirs() {
  return [
    path.join(atelierConfigDir(), "prompts"),
    path.join(legacyPiConfigDir(), "prompts"),
  ];
}

/** 用户 harness spec 覆盖文件候选：dsh-atelier → pi 旧路径回退 */
export function userSpecCandidates() {
  return [
    path.join(atelierConfigDir(), "harnesses.toml"),
    path.join(legacyPiConfigDir(), "atelier", "harnesses.toml"),
  ];
}

/** pi CLI 的 settings.json——pi harness peer 的默认模型真源（pi 仍在机上） */
export function piSettingsPath() {
  return path.join(legacyPiConfigDir(), "settings.json");
}

/** peer/run 目录根：$XDG_CACHE_HOME/dsh-atelier/subagents */
export function subagentsDir() {
  const cache = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(cache, "dsh-atelier", "subagents");
}

/** registry SQLite：$XDG_DATA_HOME/dsh-atelier/atelier-registry.db */
export function registryDbPath() {
  const data = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(data, "dsh-atelier", "atelier-registry.db");
}
