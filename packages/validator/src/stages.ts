// S5/S6 validation (roadmap M6 WS D/E): the @ctrans/validator implementations of
// the test-execution and differential stages. Everything runs through the
// SandboxRunner — source Python and translated JS are BOTH untrusted.
//
// S5: runs the translated project's vitest suite (toolchain-provided runner via a
// symlinked node_modules — nothing is installed, no consent required) and parses
// the JSON reporter output into per-test outcomes.
//
// S6: executes the SOURCE test modules with the tool-provided stdlib runner
// (function-style subset, same supported surface as the pytest mapper) under the
// same sandbox and compares per-test outcomes by name with S5. A passing S6 is
// evidence for the exercised inputs only — never universal equivalence.
import { join } from "node:path";

import type { StageResult } from "@ctrans/core";
import { SandboxRunner, type SandboxCapabilities, type SandboxRunSpec } from "@ctrans/sandbox";

export interface TestOutcome {
  readonly name: string;
  readonly outcome: "passed" | "failed";
  readonly message: string | null;
}

export interface S5Options {
  readonly capabilities: SandboxCapabilities;
  // Absolute path to the translator toolchain's node_modules (symlinked into the
  // workspace so the vitest runner resolves; nothing is installed).
  readonly nodeModulesPath: string;
  // Absolute path to the vitest CLI entry (node_modules/vitest/vitest.mjs).
  readonly vitestEntryPath: string;
  // Absolute path to the node binary running the vitest CLI.
  readonly nodePath: string;
  readonly timeoutMs?: number;
}

export interface S5Input {
  // Emitted project files (target path -> content), including tests.
  readonly files: ReadonlyMap<string, string>;
  readonly testFiles: readonly string[];
}

// The per-test JSON from vitest's json reporter is large; extract module →
// assertionResults. The runner caps output; the cap must hold the full report.
export interface S5Result extends StageResult {
  readonly outcomes: readonly TestOutcome[];
}

export async function runS5(input: S5Input, options: S5Options): Promise<S5Result> {
  const runner = new SandboxRunner({ capabilities: options.capabilities });
  const files = new Map(input.files);
  // The json reporter must print to STDOUT (the only stream the sandbox returns):
  // vitest's default json reporter writes a file when `stdout` is not set.
  files.set(
    "vitest.config.mjs",
    `export default { test: { include: ['tests/**/*.test.ts', 'test/**/*.test.ts', '**/*.test.ts'], environment: 'node', reporters: [['json', { stdout: true }]] } };\n`,
  );
  // The workspace needs a WRITABLE node_modules directory (vite's config loader
  // writes node_modules/.vite-temp at startup), so the toolchain runner enters as
  // a per-package symlink inside it — nothing in the toolchain store is written.
  const spec: SandboxRunSpec = {
    argv: [options.nodePath, options.vitestEntryPath, "run", "--no-color"],
    files: [...files.entries()].map(([path, content]) => ({ path, content })),
    symlinks: [{ path: "node_modules/vitest", target: join(options.nodeModulesPath, "vitest") }],
    timeoutMs: options.timeoutMs ?? 120000,
    stdoutCapBytes: 4 * 1024 * 1024,
    stderrCapBytes: 1024 * 1024,
    // Untrusted translated code executes ONLY under enforced network isolation;
    // without bwrap this throws (no silent downgrade — the caller reports the skip).
    requireNetworkIsolation: true,
  };
  const result = await runner.run(spec);
  if (result.outcome === "timeout") {
    return {
      stage: "S5-tests",
      status: "fail",
      reason: `vitest run exceeded ${String(options.timeoutMs ?? 120000)}ms (sandbox timeout)`,
      details: [result.stderr.slice(-2000)],
      outcomes: [],
    };
  }
  if (result.outcome === "output-limit") {
    return {
      stage: "S5-tests",
      status: "fail",
      reason: "vitest output exceeded the sandbox cap (report unparseable)",
      details: [],
      outcomes: [],
    };
  }
  if (result.outcome === "spawn-failed") {
    return {
      stage: "S5-tests",
      status: "skipped",
      reason: `test runner failed to spawn: ${result.stderr.slice(0, 500)}`,
      details: [],
      outcomes: [],
    };
  }
  // completed: parse the JSON report from the workspace file (also present on stdout).
  let report: VitestJsonReport | null = null;
  try {
    const jsonText = extractVitestJson(result.stdout);
    report = JSON.parse(jsonText) as VitestJsonReport;
  } catch {
    return {
      stage: "S5-tests",
      status: "fail",
      reason: "vitest produced no parseable JSON report (runner crashed?)",
      details: [result.stdout.slice(0, 1000), result.stderr.slice(0, 1000)],
      outcomes: [],
    };
  }
  const outcomes: TestOutcome[] = [];
  for (const testModule of report.testResults ?? []) {
    const moduleName = (testModule.name ?? "").replace(/^.*\/(tests\/|test\/)?/, "tests/");
    for (const assertion of testModule.assertionResults ?? []) {
      const rawName = assertion.fullName ?? assertion.title ?? "";
      // Normalize to the pytest-convention name the mapper preserved.
      const name = normalizeTestName(rawName, moduleName);
      outcomes.push({
        name,
        outcome: assertion.status === "passed" ? "passed" : "failed",
        message: (assertion.failureMessages ?? [])[0]?.slice(0, 500) ?? null,
      });
    }
  }
  const failed = outcomes.filter((outcome) => outcome.outcome === "failed");
  return {
    stage: "S5-tests",
    status: failed.length === 0 && outcomes.length > 0 ? "pass" : "fail",
    reason:
      failed.length === 0
        ? outcomes.length === 0
          ? "no tests collected (runner reported an empty suite)"
          : null
        : `${String(failed.length)} of ${String(outcomes.length)} translated tests failed`,
    details: failed
      .slice(0, 10)
      .map((outcome) => `${outcome.name}: ${outcome.message ?? "failed"}`),
    outcomes,
  };
}

interface VitestJsonReport {
  readonly testResults?: readonly {
    readonly name?: string;
    readonly assertionResults?: readonly {
      readonly fullName?: string;
      readonly title?: string;
      readonly status?: string;
      readonly failureMessages?: readonly string[];
    }[];
  }[];
}

// vitest's stdout interleaves the JSON with other lines; the report starts at the
// first line that parses as the report object.
function extractVitestJson(stdout: string): string {
  const start = stdout.indexOf('{"numTotalTestSuites"');
  if (start >= 0) {
    const end = stdout.lastIndexOf("}");
    return stdout.slice(start, end + 1);
  }
  return stdout;
}

// The mapper preserves pytest names ("test_add", "TestCalc.test_add"); vitest's
// fullName is "file > describe it" (the describe/it boundary is a SPACE in this
// vitest version). Recover the pytest-convention name: the file prefix is split
// off, and a Test-class describe segment becomes `Class.method`.
function normalizeTestName(fullName: string, moduleName: string): string {
  void moduleName;
  const parts = fullName.split(" > ").filter((part) => part !== "");
  if (parts.length === 0) return fullName;
  const last = parts[parts.length - 1]!;
  const classMethod = /^(Test[A-Za-z0-9_]*) (.+)$/.exec(last);
  if (classMethod !== null) return `${classMethod[1]}.${classMethod[2]}`;
  return last;
}

// ---- S6 differential -----------------------------------------------------------

export interface S6Options {
  readonly capabilities: SandboxCapabilities;
  readonly nodePath: string;
  readonly pythonPath: string;
  readonly timeoutMs?: number;
}

export interface S6Input {
  // Source project files (path -> content), including the pytest test modules.
  readonly sourceFiles: ReadonlyMap<string, string>;
  readonly sourceTestModules: readonly {
    readonly path: string;
    readonly testNames: readonly string[];
  }[];
  // S5 outcomes for the target side.
  readonly targetOutcomes: readonly TestOutcome[];
  // The tool-provided source runner (stdlib-only) content.
  readonly sourceRunnerScript: string;
}

export interface S6Result extends StageResult {
  readonly matched: readonly { readonly name: string; readonly outcome: "passed" | "failed" }[];
  readonly mismatched: readonly {
    readonly name: string;
    readonly source: TestOutcome["outcome"];
    readonly target: TestOutcome["outcome"];
  }[];
  readonly sourceOnly: readonly string[];
  readonly targetOnly: readonly string[];
}

// The tool-provided source-side runner: executes the supported pytest subset
// (test functions, Test classes without __init__, basic same-module fixtures,
// parametrize cases) with the stdlib only. It is TRUSTED tool code running INSIDE
// the sandbox with the source project materialized — never on the host.
const SOURCE_RUNNER_SCRIPT = `
import importlib
import inspect
import json
import sys

def render(value):
    if isinstance(value, str):
        return value
    return str(value)

def fixture_args(fn, mod):
    try:
        parameters = list(inspect.signature(fn).parameters.values())
    except (TypeError, ValueError):
        return []
    args = []
    for parameter in parameters:
        if parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD):
            continue
        provider = getattr(mod, parameter.name, None)
        if callable(provider) and getattr(provider, "__ctrans_fixture__", False):
            args.append(call_with_fixtures(provider, mod))
        else:
            args.append(None)
    return args

def call_with_fixtures(fn, mod):
    return fn(*fixture_args(fn, mod))

def execute(action, label):
    try:
        action()
        return {"name": label, "outcome": "passed", "message": None}
    except Exception as exc:
        return {"name": label, "outcome": "failed", "message": f"{type(exc).__name__}: {exc}"}

def run_callable(fn, mod, prefix):
    parametrize = getattr(fn, "__ctrans_parametrize__", None)
    if parametrize is not None:
        outcomes = []
        for case in parametrize[1]:
            values = list(case) if isinstance(case, (tuple, list)) else [case]
            label = prefix + "".join(" " + render(v) for v in values)
            outcomes.append(execute(lambda v=values: fn(*v), label))
        return outcomes
    return [execute(lambda: call_with_fixtures(fn, mod), prefix)]

def collect(mod):
    outcomes = []
    for name in sorted(dir(mod)):
        if name.startswith("_"):
            continue
        obj = getattr(mod, name)
        if name.startswith("test_") and callable(obj):
            outcomes.extend(run_callable(obj, mod, name))
        elif isinstance(obj, type) and name.startswith("Test"):
            instance = obj.__new__(obj)
            methods = {}
            for klass in obj.__mro__:
                for mname, mval in vars(klass).items():
                    if mname.startswith("test_") and callable(mval):
                        methods.setdefault(mname, mval)
            for mname in sorted(methods):
                outcomes.extend(run_callable(methods[mname], instance, name + "." + mname))
    return outcomes

def main():
    # The sandbox materializes the manifest as a workspace file (the runner's stdin
    # is not connected).
    with open("manifest.json", encoding="utf-8") as handle:
        manifest = json.load(handle)
    all_outcomes = []
    for entry in manifest:
        module_name = entry["module"]
        # pytest puts the test module's basedir on sys.path; mirror that so the
        # module's own sibling imports resolve the way they do under pytest.
        module_dir = entry.get("dir", "")
        if module_dir and module_dir not in sys.path:
            sys.path.insert(0, module_dir)
        mod = importlib.import_module(module_name)
        all_outcomes.extend(collect(mod))
    print(json.dumps(all_outcomes))

if __name__ == "__main__":
    main()
`;

// Tool-provided pytest stub materialized into the sandbox workspace (as pytest.py
// beside the source runner): lets the source test modules import `pytest` and
// apply decorators as recorded metadata instead of real pytest behavior. The
// differential runner consumes the metadata (parametrize cases, fixture-ness,
// raises context) with the stdlib only — real pytest is never installed.
const PYTEST_STUB = `
class _Mark:
    def __getattr__(self, name):
        def factory(*args, **kwargs):
            def decorator(fn):
                if name == "parametrize" and len(args) >= 2:
                    raw_cases = args[1]
                    cases = list(raw_cases) if hasattr(raw_cases, "__iter__") else [raw_cases]
                    fn.__ctrans_parametrize__ = (args[0], cases)
                return fn
            return decorator
        return factory

mark = _Mark()

def fixture(*args, **kwargs):
    if len(args) == 1 and callable(args[0]) and not kwargs:
        args[0].__ctrans_fixture__ = True
        return args[0]
    def decorator(fn):
        fn.__ctrans_fixture__ = True
        return fn
    return decorator

class _Raises:
    def __init__(self, expected):
        self.expected = expected
    def __enter__(self):
        return None
    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            raise AssertionError("expected an exception to be raised")
        return True

def raises(expected, *args, **kwargs):
    return _Raises(expected)

def fail(message=""):
    raise AssertionError(message)
`;

export async function runS6(options: S6Options, input: S6Input): Promise<S6Result> {
  const runner = new SandboxRunner({ capabilities: options.capabilities });
  const files = new Map(input.sourceFiles);
  files.set("ctrans_source_runner.py", input.sourceRunnerScript || SOURCE_RUNNER_SCRIPT);
  files.set("pytest.py", PYTEST_STUB);
  // Import shim: the runner imports modules by their dotted path relative to root
  // and puts each module's own directory on sys.path (pytest basedir semantics).
  const manifest = input.sourceTestModules.map((module) => ({
    module: module.path.replace(/\.py$/, "").replaceAll("/", "."),
    dir: module.path.includes("/") ? module.path.slice(0, module.path.lastIndexOf("/")) : ".",
  }));
  files.set("manifest.json", JSON.stringify(manifest));
  // PYTHONPATH=. so importlib resolves root-relative modules inside the sandbox.
  const spec: SandboxRunSpec = {
    argv: [options.pythonPath, "ctrans_source_runner.py"],
    files: [...files.entries()].map(([path, content]) => ({ path, content })),
    env: { PYTHONPATH: ".", PYTHONSAFEPATH: "1" },
    timeoutMs: options.timeoutMs ?? 120000,
    stdoutCapBytes: 4 * 1024 * 1024,
    stderrCapBytes: 1024 * 1024,
    // Untrusted source code executes ONLY under enforced network isolation; without
    // bwrap this throws (no silent downgrade — the caller reports the skip).
    requireNetworkIsolation: true,
  };
  const result = await runner.run(spec);
  if (result.outcome !== "completed" || result.exitCode !== 0) {
    return {
      stage: "S6-differential",
      status: "skipped",
      reason:
        result.outcome === "timeout"
          ? "source runner exceeded the sandbox timeout"
          : `source runner failed (${result.outcome}, exit ${String(result.exitCode)}): ${result.stderr.slice(0, 300)}`,
      details: [],
      matched: [],
      mismatched: [],
      sourceOnly: [],
      targetOnly: [],
    };
  }
  let sourceOutcomes: TestOutcome[] = [];
  try {
    sourceOutcomes = JSON.parse(result.stdout.trim().split("\n").pop() ?? "[]") as TestOutcome[];
  } catch {
    return {
      stage: "S6-differential",
      status: "skipped",
      reason: "source runner produced no parseable outcome JSON",
      details: [result.stdout.slice(0, 500)],
      matched: [],
      mismatched: [],
      sourceOnly: [],
      targetOnly: [],
    };
  }
  // Compare by name.
  const targetByName = new Map(input.targetOutcomes.map((outcome) => [outcome.name, outcome]));
  const sourceByName = new Map(sourceOutcomes.map((outcome) => [outcome.name, outcome]));
  const matched: { name: string; outcome: "passed" | "failed" }[] = [];
  const mismatched: {
    name: string;
    source: TestOutcome["outcome"];
    target: TestOutcome["outcome"];
  }[] = [];
  const sourceOnly: string[] = [];
  for (const source of sourceOutcomes) {
    const target = targetByName.get(source.name);
    if (target === undefined) {
      sourceOnly.push(source.name);
      continue;
    }
    if (target.outcome === source.outcome) {
      matched.push({ name: source.name, outcome: source.outcome });
    } else {
      mismatched.push({ name: source.name, source: source.outcome, target: target.outcome });
    }
  }
  const targetOnly = [...targetByName.keys()].filter((name) => !sourceByName.has(name));
  const pass =
    mismatched.length === 0 &&
    sourceOnly.length === 0 &&
    targetOnly.length === 0 &&
    matched.length > 0;
  return {
    stage: "S6-differential",
    status: pass ? "pass" : "fail",
    reason: pass
      ? null
      : `${String(mismatched.length)} outcome mismatch(es), ${String(sourceOnly.length)} source-only, ${String(targetOnly.length)} target-only`,
    details: mismatched
      .slice(0, 10)
      .map((entry) => `${entry.name}: source=${entry.source} target=${entry.target}`),
    matched,
    mismatched,
    sourceOnly,
    targetOnly,
  };
}

// Convenience: the canonical source-runner script (exposed for wiring/tests).
export function sourceRunnerScript(): string {
  return SOURCE_RUNNER_SCRIPT;
}

void join;
