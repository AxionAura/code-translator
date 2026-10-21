// Deterministic response cache (docs/ai-architecture.md §5): keyed by model id +
// the canonical prompt + parameters. Values hold only the model's text and usage —
// never credentials, never the prompt (the prompt lives in the journal by hash).
// M11 adds an OPT-IN cross-run file store: 0700 directory, 0600 files, sha256 file
// names, symlink/regular-file checks, atomic writes, and tolerant reads. It is off
// by default because cached model output can contain code-derived text.
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  lstatSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ChatRequest, ChatResult, ChatUsage } from "./types.js";

export function canonicalRequest(modelId: string, request: ChatRequest): string {
  return JSON.stringify({
    v: 1,
    model: modelId,
    system: request.system ?? "",
    messages: request.messages.map((message) => [message.role, message.content]),
    schema: request.schema ?? null,
    maxTokens: request.maxTokens ?? null,
    temperature: request.temperature ?? null,
  });
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
}

// Storage abstraction behind the in-memory cache; a store failure must degrade to
// a miss (the call is repeated), never to a crash or a trusted partial value.
export interface ResponseCacheStore {
  get(key: string): ChatResult | undefined;
  set(key: string, result: ChatResult): void;
}

const CACHE_KEY = /^[a-f0-9]{64}$/;
const MAX_CACHE_FILE_BYTES = 1024 * 1024;

function isUsage(value: unknown): value is ChatUsage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const valid = (entry: unknown): boolean =>
    entry === null || (typeof entry === "number" && Number.isFinite(entry));
  return valid(record["inputTokens"]) && valid(record["outputTokens"]) && valid(record["usd"]);
}

function parseCachedResult(text: string): ChatResult | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record["text"] !== "string") return undefined;
  const usage = record["usage"];
  if (usage !== null && !isUsage(usage)) return undefined;
  const normalized: ChatUsage | null =
    usage === null
      ? null
      : {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          usd: usage.usd,
        };
  return { text: record["text"], usage: normalized };
}

// Cross-run, per-user cache. Paths are fixed by the environment (never project
// input); file names are validated hash keys. Reads reject symlinks and oversized
// files; writes are atomic and owner-only. Any filesystem error is a miss/no-op.
export class FileResponseCacheStore implements ResponseCacheStore {
  private readonly directory: string;
  private enabled = true;
  private writes = 0;

  constructor(directory: string) {
    this.directory = directory;
    try {
      const existing = lstatSync(directory);
      // Refuse a symlinked cache root: writes would escape the per-user location.
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        this.enabled = false;
        return;
      }
      chmodSync(directory, 0o700);
    } catch {
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
      } catch {
        // Optional cache: an unwritable directory just disables persistence.
        this.enabled = false;
      }
    }
  }

  static defaultDirectory(
    env: Readonly<Record<string, string | undefined>> = process.env,
    home = homedir(),
  ): string {
    const base = env["XDG_CACHE_HOME"] ?? join(home, ".cache");
    return join(base, "ctrans", "responses");
  }

  get(key: string): ChatResult | undefined {
    if (!this.enabled || !CACHE_KEY.test(key)) return undefined;
    const path = join(this.directory, `${key}.json`);
    let fd: number | null = null;
    try {
      const stats = lstatSync(path);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_CACHE_FILE_BYTES) {
        return undefined;
      }
      // O_NOFOLLOW closes the symlink race between stat and open.
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const text = readFileSync(fd, "utf8");
      return parseCachedResult(text);
    } catch {
      return undefined;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Ignore close failures on an optional cache.
        }
      }
    }
  }

  set(key: string, result: ChatResult): void {
    if (!this.enabled || !CACHE_KEY.test(key)) return;
    const target = join(this.directory, `${key}.json`);
    const temporary = join(this.directory, `.${key}.${String(process.pid)}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify({ text: result.text, usage: result.usage }), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, target);
    } catch {
      try {
        unlinkSync(temporary);
      } catch {
        // Best-effort cleanup.
      }
      return;
    }
    this.writes += 1;
    if (this.writes % 64 === 0) this.prune();
  }

  // Bound disk growth without deleting fresh entries. Optional cache: failures are
  // ignored. Entries beyond 2000 are removed oldest-first.
  private prune(): void {
    try {
      const entries = readdirSync(this.directory)
        .filter((name) => name.endsWith(".json") && CACHE_KEY.test(name.slice(0, -5)))
        .map((name) => ({ name, mtimeMs: statSync(join(this.directory, name)).mtimeMs }))
        .sort((left, right) => left.mtimeMs - right.mtimeMs);
      for (const entry of entries.slice(0, Math.max(0, entries.length - 2000))) {
        try {
          unlinkSync(join(this.directory, entry.name));
        } catch {
          // Another process may have removed it.
        }
      }
    } catch {
      // Optional cache.
    }
  }
}

export class ResponseCache {
  private readonly entries = new Map<string, ChatResult>();
  private readonly store: ResponseCacheStore | null;
  private hits = 0;
  private misses = 0;

  constructor(options: { readonly store?: ResponseCacheStore } = {}) {
    this.store = options.store ?? null;
  }

  key(modelId: string, request: ChatRequest): string {
    return hashText(canonicalRequest(modelId, request));
  }

  get(key: string): ChatResult | undefined {
    const hit = this.entries.get(key);
    if (hit !== undefined) {
      this.hits += 1;
      return hit;
    }
    if (this.store !== null) {
      const stored = this.store.get(key);
      if (stored !== undefined) {
        this.entries.set(key, stored);
        this.hits += 1;
        return stored;
      }
    }
    this.misses += 1;
    return undefined;
  }

  set(key: string, result: ChatResult): void {
    this.entries.set(key, result);
    this.store?.set(key, result);
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses };
  }

  size(): number {
    return this.entries.size;
  }
}
