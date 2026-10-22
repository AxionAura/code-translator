// S5/S6 validation (roadmap M6 WS D/E): the @axion-ct/validator implementations of
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

import type { StageResult } from "@axion-ct/core";
import {
  SandboxRunner,
  type SandboxCapabilities,
  type SandboxRunResult,
  type SandboxRunSpec,
} from "@axion-ct/sandbox";

export type SandboxRun = (spec: SandboxRunSpec) => Promise<SandboxRunResult>;

export interface TestAttempt {
  readonly outcome: "passed" | "failed";
  readonly message: string | null;
}

export interface TestOutcome {
  readonly name: string;
  // Target-relative test module path (evidence attribution for repair).
  readonly file: string;
  // Final outcome: a fail-then-pass is "passed" with `flaky: true`.
  readonly outcome: "passed" | "failed";
  // Failed on the first attempt, passed on the single rerun (excluded from claims).
  readonly flaky: boolean;
  // Both attempts are preserved; `[first]` when no rerun was needed.
  readonly attempts: readonly TestAttempt[];
}

// The source-side runner emits only names/outcomes/messages.
interface SourceOutcome {
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
  // Flaky policy (docs/validation.md §5): at most ONE rerun of the suite when the
  // first attempt completed with per-test failures. Default true.
  readonly rerunFlaky?: boolean;
  // Strict container execution (M10); requires `container`.
  readonly strict?: boolean;
  readonly container?: import("@axion-ct/sandbox").ContainerRunOptions;
  // Test seam: scripted sandbox executions (no process spawn).
  readonly run?: SandboxRun;
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
  // Names that failed once and passed on the single rerun (excluded from claims).
  readonly flaky: readonly string[];
  readonly rerunPerformed: boolean;
}

interface VitestOutcomeDraft {
  readonly name: string;
  readonly file: string;
  readonly outcome: "passed" | "failed";
  readonly message: string | null;
}

export async function runS5(input: S5Input, options: S5Options): Promise<S5Result> {
  const files = new Map(input.files);
  // The json reporter must print to STDOUT (the only stream the sandbox returns):
  // vitest's default json reporter writes a file when `stdout` is not set.
  files.set(
    "vitest.config.mjs",
    `export default { test: { include: ['tests/**/*.test.ts', 'test/**/*.test.ts', '**/*.test.ts'], environment: 'node', reporters: [['json', { stdout: true }]] } };\n`,
  );
  const run = options.run ?? defaultSandboxRun(options);
  const first = await executeVitest(input, files, options, run);
  if (first.kind === "infra") return first.result;

  const outcomes: TestOutcome[] = first.outcomes.map((draft) => ({
    ...draft,
    flaky: false,
    attempts: [{ outcome: draft.outcome, message: draft.message }],
  }));
  let rerunPerformed = false;
  let rerunNote: string | null = null;
  const unstableOnRerun: string[] = [];
  const firstFailed = outcomes.filter((outcome) => outcome.outcome === "failed");
  if (options.rerunFlaky !== false && firstFailed.length > 0) {
    // Exactly ONE rerun; only the tests that failed are re-evaluated. Tests that
    // passed the first attempt keep their first-attempt evidence.
    rerunPerformed = true;
    const second = await executeVitest(input, files, options, run);
    if (second.kind === "infra") {
      rerunNote = `rerun unavailable: ${second.result.reason ?? "infrastructure failure"}`;
    } else {
      const secondByName = new Map(second.outcomes.map((draft) => [draft.name, draft]));
      for (let index = 0; index < outcomes.length; index += 1) {
        const outcome = outcomes[index]!;
        if (outcome.outcome !== "failed") {
          // A first-attempt pass is not overturned by the rerun, but instability
          // is reported rather than hidden.
          const again = secondByName.get(outcome.name);
          if (again === undefined || again.outcome === "failed") {
            unstableOnRerun.push(
              `${outcome.file}: ${outcome.name}: passed first attempt but ${
                again === undefined ? "did not run" : "failed"
              } on rerun (first-attempt evidence retained)`,
            );
          }
          continue;
        }
        const again = secondByName.get(outcome.name);
        if (again?.outcome === "passed") {
          outcomes[index] = {
            ...outcome,
            outcome: "passed",
            flaky: true,
            attempts: [...outcome.attempts, { outcome: "passed", message: again.message }],
          };
        } else {
          outcomes[index] = {
            ...outcome,
            attempts: [
              ...outcome.attempts,
              again === undefined
                ? { outcome: "failed", message: "test did not run on the rerun" }
                : { outcome: "failed", message: again.message },
            ],
          };
        }
      }
    }
  }

  const flaky = outcomes.filter((outcome) => outcome.flaky).map((outcome) => outcome.name);
  const failed = outcomes.filter((outcome) => outcome.outcome === "failed");
  const cleanPassed = outcomes.filter((outcome) => outcome.outcome === "passed" && !outcome.flaky);
  const flakyDetails = outcomes
    .filter((outcome) => outcome.flaky)
    .slice(0, 10)
    .map((outcome) => `${outcome.file}: ${outcome.name}: flaky (failed once, passed on rerun)`);
  const failureDetails = failed.slice(0, 10).map((outcome) => {
    const last = outcome.attempts[outcome.attempts.length - 1];
    return `${outcome.file}: ${outcome.name}: ${last?.message ?? "failed"}`;
  });
  if (rerunNote !== null) failureDetails.push(rerunNote);
  failureDetails.push(...unstableOnRerun.slice(0, 10));

  if (outcomes.length === 0) {
    return {
      stage: "S5-tests",
      status: "fail",
      reason: "no tests collected (runner reported an empty suite)",
      details: [],
      outcomes,
      flaky,
      rerunPerformed,
    };
  }
  if (failed.length > 0) {
    return {
      stage: "S5-tests",
      status: "fail",
      reason: `${String(failed.length)} of ${String(outcomes.length)} translated tests failed${flaky.length > 0 ? ` (${String(flaky.length)} flaky)` : ""}`,
      details: [...failureDetails, ...flakyDetails],
      outcomes,
      flaky,
      rerunPerformed,
    };
  }
  if (cleanPassed.length === 0) {
    return {
      stage: "S5-tests",
      status: "warn",
      reason: `all ${String(flaky.length)} executed test(s) were flaky; no stable first-attempt pass`,
      details: flakyDetails,
      outcomes,
      flaky,
      rerunPerformed,
    };
  }
  return {
    stage: "S5-tests",
    status: "pass",
    reason: null,
    details: [...flakyDetails, ...unstableOnRerun.slice(0, 10)],
    outcomes,
    flaky,
    rerunPerformed,
  };
}

function defaultSandboxRun(options: S5Options): SandboxRun {
  const runner = new SandboxRunner({
    capabilities: options.capabilities,
    ...(options.container === undefined ? {} : { container: options.container }),
  });
  return (spec) => runner.run(spec);
}

type VitestExecution =
  | { readonly kind: "ok"; readonly outcomes: readonly VitestOutcomeDraft[] }
  | { readonly kind: "infra"; readonly result: S5Result };

async function executeVitest(
  input: S5Input,
  files: ReadonlyMap<string, string>,
  options: S5Options,
  run: SandboxRun,
): Promise<VitestExecution> {
  const strict = options.strict === true;
  const spec: SandboxRunSpec = {
    argv: [options.nodePath, options.vitestEntryPath, "run", "--no-color"],
    files: [...files.entries()].map(([path, content]) => ({ path, content })),
    symlinks: [{ path: "node_modules/vitest", target: join(options.nodeModulesPath, "vitest") }],
    timeoutMs: options.timeoutMs ?? 120000,
    stdoutCapBytes: 4 * 1024 * 1024,
    stderrCapBytes: 1024 * 1024,
    // Untrusted translated code executes ONLY under enforced isolation; without
    // bwrap (or a strict container) this throws — the caller reports the skip.
    requireNetworkIsolation: true,
    containerMounts: [{ path: options.nodeModulesPath, readOnly: true }],
    ...(strict
      ? {
          strict: true,
          containerArgv: ["node", options.vitestEntryPath, "run", "--no-color"],
        }
      : {}),
  };
  const result = await run(spec);
  const infra = (reason: string, details: readonly string[] = []): VitestExecution => ({
    kind: "infra",
    result: {
      stage: "S5-tests",
      status: "skipped",
      reason,
      details,
      outcomes: [],
      flaky: [],
      rerunPerformed: false,
    },
  });
  if (result.outcome === "timeout") {
    return infra(
      `vitest run exceeded ${String(options.timeoutMs ?? 120000)}ms (infrastructure timeout)`,
      [result.stderr.slice(-1000)],
    );
  }
  if (result.outcome === "output-limit") {
    return infra("vitest output exceeded the sandbox cap (report unparseable)");
  }
  if (result.outcome === "spawn-failed") {
    return infra(`test runner failed to spawn: ${result.stderr.slice(0, 300)}`);
  }
  if (result.outcome === "container-error") {
    return infra(`container runtime failed before tests ran: ${result.stderr.slice(0, 300)}`);
  }
  let report: VitestJsonReport | null = null;
  try {
    report = JSON.parse(extractVitestJson(result.stdout)) as VitestJsonReport;
  } catch {
    return infra("vitest produced no parseable JSON report (runner crashed?)", [
      result.stdout.slice(0, 500),
      result.stderr.slice(0, 500),
    ]);
  }
  const outcomes: VitestOutcomeDraft[] = [];
  for (const testModule of report.testResults ?? []) {
    const file = targetTestPath(testModule.name ?? "", result.workspacePath, input.testFiles);
    for (const assertion of testModule.assertionResults ?? []) {
      const rawName = assertion.fullName ?? assertion.title ?? "";
      outcomes.push({
        name: normalizeTestName(rawName),
        file,
        outcome: assertion.status === "passed" ? "passed" : "failed",
        message: (assertion.failureMessages ?? [])[0]?.slice(0, 500) ?? null,
      });
    }
  }
  return { kind: "ok", outcomes };
}

// The reporter prints absolute workspace paths; evidence must name the emitted
// target file so failures can be attributed to a unit.
function targetTestPath(
  reported: string,
  workspacePath: string,
  testFiles: readonly string[],
): string {
  const normalized = reported.replaceAll("\\", "/");
  const prefix = `${workspacePath.replaceAll("\\", "/")}/`;
  const relative = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
  if (testFiles.includes(relative)) return relative;
  const suffixMatch = testFiles.find((file) => relative.endsWith(`/${file}`));
  return suffixMatch ?? relative;
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
function normalizeTestName(fullName: string): string {
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
  readonly strict?: boolean;
  readonly container?: import("@axion-ct/sandbox").ContainerRunOptions;
  readonly run?: SandboxRun;
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
  // Target tests excluded from the comparison because their first attempt was
  // unstable (passed only on the rerun).
  readonly flaky: readonly string[];
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
  const strict = options.strict === true;
  // PYTHONPATH=. so importlib resolves root-relative modules inside the sandbox.
  const spec: SandboxRunSpec = {
    argv: [options.pythonPath, "ctrans_source_runner.py"],
    files: [...files.entries()].map(([path, content]) => ({ path, content })),
    env: { PYTHONPATH: ".", PYTHONSAFEPATH: "1" },
    timeoutMs: options.timeoutMs ?? 120000,
    stdoutCapBytes: 4 * 1024 * 1024,
    stderrCapBytes: 1024 * 1024,
    // Untrusted source code executes ONLY under enforced isolation; without bwrap
    // (or a strict container) this throws — the caller reports the skip.
    requireNetworkIsolation: true,
    ...(strict
      ? {
          strict: true,
          containerArgv: ["python3", "ctrans_source_runner.py"],
        }
      : {}),
  };
  const run =
    options.run ??
    ((runSpec: SandboxRunSpec) =>
      new SandboxRunner({
        capabilities: options.capabilities,
        ...(options.container === undefined ? {} : { container: options.container }),
      }).run(runSpec));
  const result = await run(spec);
  const skipped = (reason: string, details: readonly string[] = []): S6Result => ({
    stage: "S6-differential",
    status: "skipped",
    reason,
    details,
    matched: [],
    mismatched: [],
    sourceOnly: [],
    targetOnly: [],
    flaky: [],
  });
  if (result.outcome !== "completed" || result.exitCode !== 0) {
    return skipped(
      result.outcome === "timeout"
        ? "source runner exceeded the sandbox timeout (infrastructure)"
        : `source runner failed (${result.outcome}, exit ${String(result.exitCode)}): ${result.stderr.slice(0, 300)}`,
    );
  }
  let sourceOutcomes: SourceOutcome[] = [];
  try {
    sourceOutcomes = JSON.parse(result.stdout.trim().split("\n").pop() ?? "[]") as SourceOutcome[];
  } catch {
    return skipped("source runner produced no parseable outcome JSON", [
      result.stdout.slice(0, 500),
    ]);
  }
  // Compare stable outcomes only: a target test that passed only on its rerun is
  // reported as flaky and excluded (docs/validation.md §5).
  const flakyNames = new Set(
    input.targetOutcomes.filter((outcome) => outcome.flaky).map((outcome) => outcome.name),
  );
  const flaky = [...flakyNames];
  const targetByName = new Map(
    input.targetOutcomes
      .filter((outcome) => !outcome.flaky)
      .map((outcome) => [outcome.name, outcome]),
  );
  const sourceByName = new Map(sourceOutcomes.map((outcome) => [outcome.name, outcome]));
  const matched: { name: string; outcome: "passed" | "failed" }[] = [];
  const mismatched: {
    name: string;
    source: TestOutcome["outcome"];
    target: TestOutcome["outcome"];
  }[] = [];
  const sourceOnly: string[] = [];
  for (const source of sourceOutcomes) {
    if (flakyNames.has(source.name)) continue;
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
  const targetOnly = [...targetByName.keys()].filter(
    (name) => !sourceByName.has(name) && !flakyNames.has(name),
  );
  const clean = mismatched.length === 0 && sourceOnly.length === 0 && targetOnly.length === 0;
  const status = clean
    ? matched.length > 0
      ? "pass"
      : flaky.length > 0
        ? "warn"
        : "fail"
    : "fail";
  const details = mismatched.slice(0, 10).map((entry) => {
    const target = targetByName.get(entry.name);
    const file = target === undefined ? "target" : target.file;
    return `${file}: ${entry.name}: source=${entry.source} target=${entry.target}`;
  });
  for (const name of flaky.slice(0, 10)) {
    const target = input.targetOutcomes.find((outcome) => outcome.name === name);
    details.push(
      `${target?.file ?? "target"}: ${name}: excluded (flaky: failed once, passed on rerun)`,
    );
  }
  return {
    stage: "S6-differential",
    status,
    reason:
      status === "pass"
        ? null
        : status === "warn"
          ? `no stable differential outcomes (${String(flaky.length)} flaky)`
          : clean
            ? "no comparable tests"
            : `${String(mismatched.length)} outcome mismatch(es), ${String(sourceOnly.length)} source-only, ${String(targetOnly.length)} target-only`,
    details,
    matched,
    mismatched,
    sourceOnly,
    targetOnly,
    flaky,
  };
}

// Convenience: the canonical source-runner script (exposed for wiring/tests).
export function sourceRunnerScript(): string {
  return SOURCE_RUNNER_SCRIPT;
}
