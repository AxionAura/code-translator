// M11 API-key resolution: environment first, OS keychain second, 0600 fallback file
// with a secret-free warning. Insecure permissions, symlinks, and malformed files
// are rejected; key values never appear in diagnostics.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { buildAiWiring } from "../src/ai-wiring.ts";
import { keyFilePath, resolveAiKey } from "../src/keys.ts";
import { FakeChatModel } from "@axion-ct/ai";

const created: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctrans-keys-"));
  created.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of created.reverse()) rmSync(dir, { recursive: true, force: true });
});

const SECRET = "test-key-value-not-real";

function withKeyFile(mode: number): { root: string; path: string } {
  const root = tempDir();
  const path = keyFilePath({ XDG_CONFIG_HOME: root }, root);
  mkdirSync(join(root, "ctrans"), { recursive: true });
  writeFileSync(path, JSON.stringify({ openai: SECRET }), { mode });
  chmodSync(path, mode);
  return { root, path };
}

describe("resolveAiKey", () => {
  it("prefers the environment and never calls the keychain", () => {
    const resolution = resolveAiKey("openai", {
      env: { CTRANS_AI_KEY: SECRET },
      keychain: () => {
        throw new Error("keychain must not run");
      },
    });
    expect(resolution).toEqual({ key: SECRET, source: "env", warning: null });
  });

  it("uses the OS keychain when the environment is empty", () => {
    const resolution = resolveAiKey("anthropic", {
      env: {},
      keychain: () => SECRET,
      home: tempDir(),
    });
    expect(resolution.key).toBe(SECRET);
    expect(resolution.source).toBe("keychain");
    expect(resolution.warning).toBeNull();
  });

  it("reads a 0600 fallback file and warns without exposing the key", () => {
    const { root } = withKeyFile(0o600);
    const resolution = resolveAiKey("openai", {
      env: { XDG_CONFIG_HOME: root },
      keychain: () => null,
      home: root,
    });
    expect(resolution.key).toBe(SECRET);
    expect(resolution.source).toBe("file");
    expect(resolution.warning).toContain("0600 file");
    expect(resolution.warning).not.toContain(SECRET);
  });

  it("rejects group/world-readable files", () => {
    const { root } = withKeyFile(0o644);
    const resolution = resolveAiKey("openai", {
      env: { XDG_CONFIG_HOME: root },
      keychain: () => null,
      home: root,
    });
    expect(resolution.key).toBeNull();
    expect(resolution.warning).toContain("owner-only");
    expect(resolution.warning).not.toContain(SECRET);
  });

  it("rejects symlinked key files", () => {
    const root = tempDir();
    const real = join(root, "real.json");
    writeFileSync(real, JSON.stringify({ openai: SECRET }), { mode: 0o600 });
    chmodSync(real, 0o600);
    mkdirSync(join(root, "ctrans"), { recursive: true });
    const path = keyFilePath({ XDG_CONFIG_HOME: root }, root);
    symlinkSync(real, path);
    const resolution = resolveAiKey("openai", {
      env: { XDG_CONFIG_HOME: root },
      keychain: () => null,
      home: root,
    });
    expect(resolution.key).toBeNull();
    expect(resolution.warning).toContain("symlinks are not allowed");
  });

  it("rejects malformed files and non-string provider entries", () => {
    const root = tempDir();
    mkdirSync(join(root, "ctrans"), { recursive: true });
    const path = keyFilePath({ XDG_CONFIG_HOME: root }, root);
    writeFileSync(path, "{nope", { mode: 0o600 });
    chmodSync(path, 0o600);
    expect(
      resolveAiKey("openai", {
        env: { XDG_CONFIG_HOME: root },
        keychain: () => null,
        home: root,
      }).warning,
    ).toContain("unreadable");

    writeFileSync(path, JSON.stringify({ openai: 42 }), { mode: 0o600 });
    chmodSync(path, 0o600);
    expect(
      resolveAiKey("openai", {
        env: { XDG_CONFIG_HOME: root },
        keychain: () => null,
        home: root,
      }).warning,
    ).toContain("non-empty string");
  });

  it("returns no key and no warning when nothing is configured", () => {
    const resolution = resolveAiKey("openai", {
      env: { XDG_CONFIG_HOME: tempDir() },
      keychain: () => null,
      home: tempDir(),
    });
    expect(resolution).toEqual({ key: null, source: null, warning: null });
  });
});

describe("buildAiWiring key errors", () => {
  it("includes the actionable warning in the typed missing-key error", () => {
    expect(() =>
      buildAiWiring({
        provider: "openai",
        keyResolver: () => ({
          key: null,
          source: null,
          warning: "ignoring API key file: permissions must be owner-only",
        }),
      }),
    ).toThrow(/permissions must be owner-only/);
  });

  it("never includes key material in the error", () => {
    try {
      buildAiWiring({
        provider: "openai",
        keyResolver: () => ({ key: null, source: null, warning: null }),
      });
      expect.unreachable("expected AI-KEY-MISSING");
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET);
      expect((error as Error).message).toContain("CTRANS_AI_KEY");
    }
  });

  it("wires the opt-in disk cache explicitly and reports its mode", () => {
    const wiring = buildAiWiring({
      provider: "openai",
      modelFactory: () => new FakeChatModel([{ kind: "text", text: "{}" }]),
      cache: "disk",
      cacheDirectory: join(tempDir(), "responses"),
    });
    expect(wiring).not.toBeNull();
    expect(wiring!.cacheMode).toBe("disk");
    expect(wiring!.warnings).toEqual([]);
    expect(
      buildAiWiring({ provider: "openai", modelFactory: () => new FakeChatModel([]) })!.cacheMode,
    ).toBe("memory");
  });
});
