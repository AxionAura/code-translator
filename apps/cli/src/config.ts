// CLI configuration (docs/architecture.md §10; M11): a small, strictly validated
// `ctrans.config.json`. Unknown keys and secret-bearing keys are REJECTED rather
// than ignored — a typo must not silently change behavior, and credentials never
// belong in configuration files (security.md §4). CLI flags always win over config.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { CTransError } from "@ctrans/core";

export interface AiConfig {
  readonly enabled: boolean;
  readonly provider?: "openai" | "anthropic";
  readonly model?: string;
  readonly baseUrl?: string;
  // "disk" is opt-in: cached model responses may contain code-derived text.
  readonly cache: "memory" | "disk";
}

export interface CliConfig {
  readonly to?: "ts" | "js" | "py";
  readonly intMode?: "number" | "bigint";
  readonly sandbox?: "auto" | "strict";
  readonly sandboxImage?: string;
  // Resolved relative to the config file's directory.
  readonly smoke?: string;
  readonly ai?: AiConfig;
  readonly format?: true;
}

export interface LoadedConfig {
  readonly path: string;
  readonly directory: string;
  readonly config: CliConfig;
}

const ROOT_KEYS = new Set([
  "$schema",
  "to",
  "intMode",
  "sandbox",
  "sandboxImage",
  "smoke",
  "ai",
  "format",
]);
const AI_KEYS = new Set(["enabled", "provider", "model", "baseUrl", "cache"]);
const SECRET_KEY_PATTERN = /^(api[_-]?key|key|token|secret|password|credential|credentials|auth)$/i;
const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;
const MAX_CONFIG_BYTES = 64 * 1024;

export class ConfigError extends CTransError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

function fail(message: string): never {
  throw new ConfigError("CONFIG-INVALID", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new ConfigError(
        "CONFIG-UNSAFE-KEY",
        `${path}.${key} is not allowed: credentials must come from the environment, the OS keychain, or a 0600 key file, never from configuration`,
      );
    }
    if (!allowed.has(key)) {
      throw new ConfigError(
        "CONFIG-UNKNOWN-KEY",
        `unknown configuration key "${path}${key}" (allowed: ${[...allowed].sort().join(", ")})`,
      );
    }
  }
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || value.includes("\u0000")) {
    fail(`${name} must be a non-empty string`);
  }
  return value;
}

function parseAi(value: unknown): AiConfig {
  if (value === undefined) return { enabled: false, cache: "memory" };
  if (!isRecord(value)) fail("ai must be an object");
  checkKeys(value, AI_KEYS, "ai.");
  const enabled = value["enabled"];
  if (enabled !== undefined && typeof enabled !== "boolean") {
    fail("ai.enabled must be a boolean");
  }
  const provider = value["provider"];
  if (provider !== undefined && provider !== "openai" && provider !== "anthropic") {
    fail('ai.provider must be "openai" or "anthropic"');
  }
  const model = optionalString(value["model"], "ai.model");
  const baseUrl = optionalString(value["baseUrl"], "ai.baseUrl");
  if (baseUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      fail("ai.baseUrl must be an absolute http(s) URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      fail("ai.baseUrl must use http or https");
    }
    if (parsed.username !== "" || parsed.password !== "") {
      fail("ai.baseUrl must not embed credentials");
    }
  }
  const cache = value["cache"];
  if (cache !== undefined && cache !== "memory" && cache !== "disk") {
    fail('ai.cache must be "memory" or "disk"');
  }
  const resolvedEnabled = enabled ?? provider !== undefined;
  if (resolvedEnabled && provider === undefined) {
    fail("ai.enabled requires ai.provider");
  }
  if (
    enabled === false &&
    (provider !== undefined || model !== undefined || baseUrl !== undefined)
  ) {
    fail("ai.enabled is false but provider/model/baseUrl are configured");
  }
  return {
    enabled: resolvedEnabled,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    cache: cache ?? "memory",
  };
}

export function parseConfig(value: unknown): CliConfig {
  if (!isRecord(value)) fail("configuration must be a JSON object");
  checkKeys(value, ROOT_KEYS, "");
  const to = value["to"];
  if (to !== undefined && to !== "ts" && to !== "js" && to !== "py") {
    fail('to must be "ts", "js", or "py"');
  }
  const intMode = value["intMode"];
  if (intMode !== undefined && intMode !== "number" && intMode !== "bigint") {
    fail('intMode must be "number" or "bigint"');
  }
  const sandbox = value["sandbox"];
  if (sandbox !== undefined && sandbox !== "auto" && sandbox !== "strict") {
    fail('sandbox must be "auto" or "strict"');
  }
  const sandboxImage = optionalString(value["sandboxImage"], "sandboxImage");
  if (sandboxImage !== undefined && !IMAGE_PATTERN.test(sandboxImage)) {
    fail("sandboxImage is not a valid container image reference");
  }
  if (sandboxImage !== undefined && sandbox !== "strict") {
    fail('sandboxImage requires sandbox: "strict"');
  }
  const smokeValue = optionalString(value["smoke"], "smoke");
  const format = value["format"];
  if (format !== undefined && format !== true) {
    fail("format: false is not supported (generated code is always canonicalized)");
  }
  return {
    ...(to === undefined ? {} : { to }),
    ...(intMode === undefined ? {} : { intMode }),
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(sandboxImage === undefined ? {} : { sandboxImage }),
    ...(smokeValue === undefined ? {} : { smoke: smokeValue }),
    ai: parseAi(value["ai"]),
    ...(format === undefined ? {} : { format: true }),
  };
}

export function loadConfig(path: string): LoadedConfig {
  const absolute = resolve(path);
  let bytes: string;
  try {
    const stats = statSync(absolute);
    if (!stats.isFile() || stats.size > MAX_CONFIG_BYTES) {
      throw new ConfigError(
        "CONFIG-INVALID",
        `configuration must be a regular file no larger than ${String(MAX_CONFIG_BYTES)} bytes: ${absolute}`,
      );
    }
    bytes = readFileSync(absolute, "utf8");
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      "CONFIG-READ",
      `could not read configuration "${absolute}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes) as unknown;
  } catch {
    throw new ConfigError("CONFIG-INVALID", `configuration is not valid JSON: ${absolute}`);
  }
  const config = parseConfig(parsed);
  const directory = dirname(absolute);
  return {
    path: absolute,
    directory,
    config: {
      ...config,
      ...(config.smoke === undefined
        ? {}
        : { smoke: isAbsolute(config.smoke) ? config.smoke : join(directory, config.smoke) }),
    },
  };
}

// Discovery order: explicit --config, then <sourceRoot>/ctrans.config.json, then
// the working directory. File inputs look beside the file. Absence is not an error.
export function discoverConfig(
  sourcePath: string | undefined,
  explicitPath: string | undefined,
  cwd = process.cwd(),
): LoadedConfig | null {
  if (explicitPath !== undefined) {
    if (!existsSync(explicitPath)) {
      throw new ConfigError("CONFIG-NOT-FOUND", `configuration file not found: ${explicitPath}`);
    }
    return loadConfig(explicitPath);
  }
  const candidates: string[] = [];
  if (sourcePath !== undefined) {
    try {
      candidates.push(
        statSync(sourcePath).isDirectory()
          ? join(sourcePath, "ctrans.config.json")
          : join(dirname(sourcePath), "ctrans.config.json"),
      );
    } catch {
      // The command reports the missing input; config discovery stays silent.
    }
  }
  candidates.push(join(cwd, "ctrans.config.json"));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return loadConfig(candidate);
  }
  return null;
}
