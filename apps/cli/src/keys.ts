// API-key resolution (M11; docs/security.md §4): environment first (CI), then the
// OS keychain, then a 0600 fallback file with a warning. Keys are never read from
// configuration, flags, project files, logs, or cache keys. Keychain commands are
// bounded and run with an env allowlist; their output is never logged.
import { execFileSync } from "node:child_process";
import { closeSync, constants, lstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type KeySource = "env" | "keychain" | "file";

export interface AiKeyResolution {
  readonly key: string | null;
  readonly source: KeySource | null;
  // Actionable, secret-free warning (e.g. file fallback or rejected permissions).
  readonly warning: string | null;
}

export interface KeyResolverOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  // Test seam for keychain lookup; returning null means "not configured".
  readonly keychain?: (provider: string) => string | null;
}

const MAX_KEY_FILE_BYTES = 64 * 1024;
const KEYCHAIN_TIMEOUT_MS = 3000;

export function keyFilePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home = homedir(),
): string {
  const configHome = env["XDG_CONFIG_HOME"] ?? join(home, ".config");
  return join(configHome, "ctrans", "keys.json");
}

function keychainLookup(provider: string, platform: NodeJS.Platform): string | null {
  const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" } as NodeJS.ProcessEnv;
  try {
    if (platform === "darwin") {
      return execFileSync(
        "security",
        ["find-generic-password", "-s", "ctrans-ai", "-a", provider, "-w"],
        {
          encoding: "utf8",
          timeout: KEYCHAIN_TIMEOUT_MS,
          env,
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
    }
    if (platform === "linux") {
      return execFileSync("secret-tool", ["lookup", "service", "ctrans-ai", "account", provider], {
        encoding: "utf8",
        timeout: KEYCHAIN_TIMEOUT_MS,
        env,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    }
    // Windows Credential Manager retrieval is not implemented (documented M11
    // limitation); the 0600 file remains available there.
    return null;
  } catch {
    return null;
  }
}

function readKeyFile(
  path: string,
  provider: string,
): { readonly key: string | null; readonly warning: string | null } {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return { key: null, warning: null };
  }
  if (stats.isSymbolicLink()) {
    return {
      key: null,
      warning: `ignoring API key file ${path}: symlinks are not allowed`,
    };
  }
  if (!stats.isFile() || stats.size > MAX_KEY_FILE_BYTES) {
    return {
      key: null,
      warning: `ignoring API key file ${path}: expected a regular file <= ${String(MAX_KEY_FILE_BYTES)} bytes`,
    };
  }
  if ((stats.mode & 0o077) !== 0) {
    return {
      key: null,
      warning: `ignoring API key file ${path}: permissions must be owner-only (chmod 600)`,
    };
  }
  let parsed: unknown;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      parsed = JSON.parse(readFileSync(fd, "utf8")) as unknown;
    } finally {
      closeSync(fd);
    }
  } catch {
    return {
      key: null,
      warning: `ignoring unreadable API key file ${path}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { key: null, warning: `ignoring API key file ${path}: expected a JSON object` };
  }
  const value = (parsed as Record<string, unknown>)[provider];
  if (value === undefined) return { key: null, warning: null };
  if (typeof value !== "string" || value.trim() === "") {
    return {
      key: null,
      warning: `ignoring API key file ${path}: provider "${provider}" must map to a non-empty string`,
    };
  }
  return {
    key: value.trim(),
    warning: `using API key from ${path} (0600 file); the OS keychain is preferred`,
  };
}

// Resolution order is deliberate: env (CI/explicit) > keychain > file. Missing
// keys return null; callers turn that into a typed AI-KEY-MISSING error.
export function resolveAiKey(provider: string, options: KeyResolverOptions = {}): AiKeyResolution {
  const env = options.env ?? process.env;
  const environmentKey = env["CTRANS_AI_KEY"];
  if (environmentKey !== undefined && environmentKey.trim() !== "") {
    return { key: environmentKey.trim(), source: "env", warning: null };
  }
  const keychain =
    options.keychain ??
    ((name: string) => keychainLookup(name, options.platform ?? process.platform));
  const keychainKey = keychain(provider);
  if (keychainKey !== null && keychainKey.trim() !== "") {
    return { key: keychainKey.trim(), source: "keychain", warning: null };
  }
  const file = readKeyFile(keyFilePath(env, options.home ?? homedir()), provider);
  if (file.key === null) {
    return { key: null, source: null, warning: file.warning };
  }
  return { key: file.key, source: "file", warning: file.warning };
}
