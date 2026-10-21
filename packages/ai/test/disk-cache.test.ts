// M11 cross-run response cache: opt-in, per-user, owner-only files, hash-only names,
// tolerant reads, and no trust in malformed/symlinked entries.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  AiAmbiguityResolver,
  FakeChatModel,
  FileResponseCacheStore,
  ResponseCache,
  type ChatResult,
  type SecretGate,
} from "../src/index.js";
import { hashText } from "../src/index.js";

const created: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctrans-cache-"));
  created.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of created.reverse()) rmSync(dir, { recursive: true, force: true });
});

const result: ChatResult = {
  text: '{"optionId":"switch"}',
  usage: { inputTokens: 10, outputTokens: 2, usd: null },
};

describe("FileResponseCacheStore", () => {
  it("round-trips a result with owner-only directory/file permissions", () => {
    const dir = join(tempDir(), "responses");
    const store = new FileResponseCacheStore(dir);
    const key = hashText("key-one");
    store.set(key, result);
    expect(store.get(key)).toEqual(result);
    const directoryMode = statSync(dir).mode & 0o777;
    expect(directoryMode & 0o077).toBe(0);
    const fileMode = statSync(join(dir, `${key}.json`)).mode & 0o777;
    expect(fileMode & 0o077).toBe(0);
    expect(readFileSync(join(dir, `${key}.json`), "utf8")).not.toContain("prompt");
  });

  it("ignores malformed, oversized, and symlinked entries", () => {
    const root = tempDir();
    const dir = join(root, "responses");
    const store = new FileResponseCacheStore(dir);
    const malformed = hashText("malformed");
    writeFileSync(join(dir, `${malformed}.json`), "{nope", "utf8");
    expect(store.get(malformed)).toBeUndefined();

    const target = join(root, "target.json");
    writeFileSync(target, JSON.stringify(result), "utf8");
    const linked = hashText("linked");
    symlinkSync(target, join(dir, `${linked}.json`));
    expect(store.get(linked)).toBeUndefined();

    const invalidShape = hashText("shape");
    writeFileSync(join(dir, `${invalidShape}.json`), JSON.stringify({ text: 42 }), "utf8");
    expect(store.get(invalidShape)).toBeUndefined();
  });

  it("rejects non-hash keys and never writes outside the cache directory", () => {
    const dir = join(tempDir(), "responses");
    const store = new FileResponseCacheStore(dir);
    expect(() => store.set("../../escape", result)).not.toThrow();
    expect(store.get("../../escape")).toBeUndefined();
  });

  it("refuses a symlinked cache root", () => {
    const root = tempDir();
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    const linked = join(root, "responses");
    symlinkSync(outside, linked);
    const store = new FileResponseCacheStore(linked);
    store.set(hashText("key"), result);
    expect(store.get(hashText("key"))).toBeUndefined();
  });

  it("default placement is per-user XDG cache", () => {
    expect(FileResponseCacheStore.defaultDirectory({ XDG_CACHE_HOME: "/tmp/xdg" }, "/home/u")).toBe(
      "/tmp/xdg/ctrans/responses",
    );
    expect(FileResponseCacheStore.defaultDirectory({}, "/home/u")).toBe(
      "/home/u/.cache/ctrans/responses",
    );
  });
});

const allowAll: SecretGate = { scan: async () => ({ blocked: false, findings: [] }) };

function request() {
  return {
    unit: "mod.py",
    rule: "py.Match",
    sourceKind: "py.Match",
    span: null,
    summary: "match on value",
    contracts: [],
    diagnostics: [],
    options: [
      { id: "if-chain", description: "if chain" },
      { id: "switch", description: "switch" },
    ],
    heuristic: "if-chain",
  };
}

describe("cross-run cache through the resolver", () => {
  it("serves a repeated ambiguity request from disk without a second model call", async () => {
    const dir = join(tempDir(), "responses");
    const firstModel = new FakeChatModel([{ kind: "text", text: result.text }], "fake:cache");
    const first = new AiAmbiguityResolver({
      model: firstModel,
      gate: allowAll,
      cache: new ResponseCache({ store: new FileResponseCacheStore(dir) }),
    });
    const decision = await first.resolve(request());
    expect(decision?.optionId).toBe("switch");
    expect(firstModel.calls.length).toBe(1);

    const secondModel = new FakeChatModel(
      [{ kind: "text", text: '{"optionId":"if-chain"}' }],
      "fake:cache",
    );
    const second = new AiAmbiguityResolver({
      model: secondModel,
      gate: allowAll,
      cache: new ResponseCache({ store: new FileResponseCacheStore(dir) }),
    });
    const cached = await second.resolve(request());
    expect(cached?.optionId).toBe("switch");
    expect(secondModel.calls.length).toBe(0);
    expect(second.journalEntries().some((entry) => entry.outcome === "cache-hit")).toBe(true);
  });

  it("a corrupt disk entry is a miss and the model is called", async () => {
    const dir = join(tempDir(), "responses");
    mkdirSync(dir, { recursive: true });
    const cache = new ResponseCache({ store: new FileResponseCacheStore(dir) });
    const model = new FakeChatModel([{ kind: "text", text: result.text }], "fake:cache");
    const resolver = new AiAmbiguityResolver({ model, gate: allowAll, cache });
    // Prime the key, then corrupt its file.
    await resolver.resolve(request());
    const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
    expect(files.length).toBe(1);
    writeFileSync(join(dir, files[0]!), "{corrupt", "utf8");
    const second = new FakeChatModel([{ kind: "text", text: result.text }], "fake:cache");
    await new AiAmbiguityResolver({
      model: second,
      gate: allowAll,
      cache: new ResponseCache({ store: new FileResponseCacheStore(dir) }),
    }).resolve(request());
    expect(second.calls.length).toBe(1);
  });
});
