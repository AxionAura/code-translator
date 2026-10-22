// M11 configuration + CLI contract tests: discovery, precedence, strict schema,
// rejected secret-bearing keys, hardened option parsing, JSON stdout discipline,
// and machine-readable error output.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { runCliCommand } from "../src/main.ts";
import { loadConfig } from "../src/config.ts";

const workspace = mkdtempSync(join(tmpdir(), "ctrans-cli-m11-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

const SOURCE = "def add(a: int, b: int) -> int:\n    return a + b\n";

function project(name: string, files: Record<string, string>): string {
  const root = join(workspace, name);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  return root;
}

describe("ctrans.config.json", () => {
  it("supplies the target/intMode when flags are absent", async () => {
    const root = project("config-defaults", {
      "a.py": SOURCE,
      "ctrans.config.json": JSON.stringify({ to: "ts", intMode: "number" }),
    });
    const result = await runCliCommand(["check", join(root, "a.py")]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("claim level 3");
  });

  it("lets explicit CLI flags override configuration", async () => {
    const root = project("config-override", {
      "a.py": SOURCE,
      "ctrans.config.json": JSON.stringify({ to: "ts" }),
    });
    const result = await runCliCommand(["check", join(root, "a.py"), "--to", "js"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("claim level 1");
  });

  it("loads an explicit --config file", async () => {
    const root = project("config-explicit", { "a.py": SOURCE });
    const config = join(workspace, "explicit-config.json");
    writeFileSync(config, JSON.stringify({ to: "js" }), "utf8");
    const result = await runCliCommand(["check", join(root, "a.py"), "--config", config]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("claim level 1");
  });

  it("rejects unknown keys, secret-bearing keys, and unsafe combinations", async () => {
    const cases: readonly { config: Record<string, unknown>; message: RegExp }[] = [
      { config: { to: "ts", typo: true }, message: /unknown configuration key/ },
      { config: { to: "ts", ai: { apiKey: "x" } }, message: /credentials must come/ },
      { config: { to: "ts", apiKey: "x" }, message: /credentials must come/ },
      { config: { sandboxImage: "img:1" }, message: /sandboxImage requires sandbox/ },
      { config: { to: "ts", ai: { enabled: true } }, message: /requires ai\.provider/ },
      {
        config: { to: "ts", ai: { enabled: false, provider: "openai" } },
        message: /enabled is false/,
      },
      { config: { to: "python" }, message: /to must be/ },
      { config: { to: "ts", format: false }, message: /format: false is not supported/ },
      {
        config: { to: "ts", ai: { enabled: true, provider: "openai", baseUrl: "https://u:p@x" } },
        message: /must not embed credentials/,
      },
      { config: { not: "an object" }, message: /unknown configuration key|configuration/ },
    ];
    for (const [index, entry] of cases.entries()) {
      const root = project(`config-invalid-${String(index)}`, {
        "a.py": SOURCE,
        "ctrans.config.json": JSON.stringify(entry.config),
      });
      const result = await runCliCommand(["check", join(root, "a.py")]);
      expect(result.code, JSON.stringify(entry.config)).toBe(1);
      expect(result.stderr).toMatch(entry.message);
    }
  });

  it("reports malformed JSON and missing explicit config files actionably", async () => {
    const malformed = project("config-malformed", {
      "a.py": SOURCE,
      "ctrans.config.json": "{nope",
    });
    const result = await runCliCommand(["check", join(malformed, "a.py")]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not valid JSON");
    const missing = await runCliCommand([
      "check",
      join(malformed, "a.py"),
      "--config",
      join(workspace, "absent.json"),
    ]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("configuration file not found");
  });

  it("resolves relative smoke paths against the config file directory", () => {
    const root = project("config-smoke", {
      "ctrans.config.json": JSON.stringify({ to: "ts", smoke: "./smoke.json" }),
      "smoke.json": "{}",
    });
    const loaded = loadConfig(join(root, "ctrans.config.json"));
    expect(loaded.config.smoke).toBe(join(root, "smoke.json"));
  });
});

describe("option parsing and machine-readable output", () => {
  it("rejects unknown options and missing values with usage exit code 2", async () => {
    const root = project("options", { "a.py": SOURCE });
    const unknown = await runCliCommand(["check", join(root, "a.py"), "--bogus"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown option");
    const missingValue = await runCliCommand(["check", join(root, "a.py"), "--to"]);
    expect(missingValue.code).toBe(2);
    expect(missingValue.stderr).toContain("--to requires a value");
    const badTarget = await runCliCommand(["check", join(root, "a.py"), "--to", "rust"]);
    expect(badTarget.code).toBe(2);
    expect(badTarget.stderr).toContain("--to must be");
  });

  it("--json emits exactly one JSON document on stdout with no diagnostics", async () => {
    const root = project("json", { "a.py": SOURCE });
    const result = await runCliCommand(["check", join(root, "a.py"), "--to", "ts", "--json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      command: string;
      target: string;
      report: { claimLevel: number };
      files: string[];
    };
    expect(parsed.command).toBe("check");
    expect(parsed.target).toBe("typescript");
    expect(parsed.report.claimLevel).toBe(3);
    expect(parsed.files).toEqual(["a.ts"]);
    expect(result.stderr).toBe("");
  });

  it("progress events go to stderr; stdout remains parseable JSON", async () => {
    const root = project("progress", { "a.py": SOURCE });
    const result = await runCliCommand([
      "check",
      join(root, "a.py"),
      "--to",
      "ts",
      "--json",
      "--progress",
      "json",
    ]);
    expect(result.code).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    const events = result.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string });
    expect(events.map((event) => event.event)).toContain("run:start");
    expect(events.map((event) => event.event)).toContain("run:done");
  });

  it("reports failures as JSON on stderr with an empty stdout", async () => {
    const result = await runCliCommand(["check", "does-not-exist.py", "--to", "ts", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const parsed = JSON.parse(result.stderr) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBeTruthy();
    expect(parsed.error.message).not.toContain("API_KEY");
  });

  it("doctor --json exposes the shared capability model", async () => {
    const result = await runCliCommand(["doctor", "--json"]);
    expect([0, 1]).toContain(result.code);
    const parsed = JSON.parse(result.stdout) as {
      command: string;
      capabilities: { node: { state: string }; bwrap: { state: string } };
      requiredAvailable: boolean;
    };
    expect(parsed.command).toBe("doctor");
    expect(parsed.capabilities.node.state).toBe("available");
    expect(["available", "unavailable"]).toContain(parsed.capabilities.bwrap.state);
    expect(typeof parsed.requiredAvailable).toBe("boolean");
  }, 30000);

  it("translate --json reports output files without embedding source content", async () => {
    const root = project("json-translate", { "a.py": SOURCE });
    const out = join(workspace, "json-translate-out");
    const result = await runCliCommand([
      "translate",
      join(root, "a.py"),
      "--to",
      "ts",
      "-o",
      out,
      "--json",
    ]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { outputDir: string; files: string[] };
    expect(parsed.outputDir).toBe(out);
    expect(parsed.files).toEqual(["a.ts"]);
    expect(result.stdout).not.toContain("def add");
    expect(readFileSync(join(out, "a.ts"), "utf8")).toContain("function add");
  });

  it("project progress events stay off JSON stdout", async () => {
    const root = project("project-progress", {
      "mod.py": "def value():\n    return 1\n",
      "tests/test_mod.py": "from mod import value\n\ndef test_value():\n    assert value() == 1\n",
    });
    const out = join(workspace, "project-progress-out");
    const result = await runCliCommand([
      "project",
      root,
      "--to",
      "ts",
      "-o",
      out,
      "--no-tests",
      "--json",
      "--progress",
      "json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as { command: string; stages: unknown[] };
    expect(parsed.command).toBe("project");
    expect(parsed.stages.length).toBe(7);
    const events = result.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; stage?: string });
    expect(events.some((event) => event.stage === "S4-build")).toBe(true);
    expect(events.some((event) => event.event === "run:done")).toBe(true);
  }, 120000);
});
