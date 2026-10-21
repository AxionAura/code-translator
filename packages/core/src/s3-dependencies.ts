// S3 dependency validation (docs/validation.md §1 stage 3): the emitted project's
// imports resolve against the ModuleGraph findings and the dependency registry.
// Distinct verdicts: mapped (registry), emitted-local (project file), verbatim
// external (permitted passthrough with warning), unsupported-mapped (registry says
// no), unresolved (missing project module — failure). A registry miss is NOT
// automatically unresolved: externals and missing locals are different cases.
export interface S3Input {
  // Emitted target files (path -> content).
  readonly files: ReadonlyMap<string, string>;
  // Registry module names with an implementation (mapped surface).
  readonly mappedModules: ReadonlySet<string>;
  // Registry modules explicitly unsupported (declared non-goals).
  readonly unsupportedModules: ReadonlySet<string>;
  // Import specifiers recorded per SOURCE unit by the ModuleGraph analysis:
  // unit id -> specifiers. Validation maps them onto emitted paths.
  readonly sourceImports: ReadonlyMap<string, readonly string[]>;
  // Emitted path for a source module id (the pipeline's module policy).
  readonly targetPathFor: (sourceModuleId: string) => string;
}

export interface S3Finding {
  readonly specifier: string;
  readonly unit: string;
  readonly verdict: "mapped" | "emitted-local" | "external-verbatim" | "unsupported" | "unresolved";
  readonly detail: string;
}

// The import specifiers recorded by the ModuleGraph for a project. Resolution
// against the file set already happened in the graph (status: resolved/external/
// unresolved is derivable from the emitted file set + registry here).
export function validateDependencies(input: S3Input): {
  stage: "S3-dependencies";
  status: "pass" | "fail" | "warn" | "skipped";
  reason: string | null;
  details: readonly string[];
  findings: readonly S3Finding[];
} {
  const findings: S3Finding[] = [];
  for (const [unit, specifiers] of input.sourceImports) {
    for (const specifier of specifiers) {
      // External root for registry lookup: dotted for Python sources
      // (`os.path` → `os`), path-rooted for JS sources (`lodash/merge` → `lodash`).
      const root = specifier.startsWith(".")
        ? specifier
        : specifier.includes("/")
          ? (specifier.split("/")[0] ?? specifier)
          : (specifier.split(".")[0] ?? specifier);
      // 1. Project-local module: resolved by the graph and emitted. Directory
      // imports (`./lib`) resolve to the barrel (lib/index.py).
      const normalized = normalizeSpecifier(specifier, unit);
      const localCandidates = [
        input.targetPathFor(normalized),
        input.targetPathFor(`${normalized}/index`),
      ];
      const localTarget = localCandidates.find(
        (candidate) =>
          input.files.has(candidate) ||
          input.files.has(candidate.replace(/\.py$/, ".ts")) ||
          input.files.has(candidate.replace(/\.py$/, ".js")),
      );
      if (localTarget !== undefined) {
        findings.push({
          specifier,
          unit,
          verdict: "emitted-local",
          detail: `resolved to emitted project module ${String(localTarget)}`,
        });
        continue;
      }
      // 2. Registry mapping.
      if (input.mappedModules.has(root)) {
        findings.push({
          specifier,
          unit,
          verdict: "mapped",
          detail: `registry v1 maps '${root}' to a generated module`,
        });
        continue;
      }
      if (input.unsupportedModules.has(root)) {
        findings.push({
          specifier,
          unit,
          verdict: "unsupported",
          detail: `registry declares '${root}' unsupported (C-extension/declared non-goal)`,
        });
        continue;
      }
      // 3. Unmapped dependency: NOT unresolved — it's an external passthrough with
      // an exact warning (M5 policy: report, never guess).
      const isRelative = specifier.startsWith(".");
      if (isRelative) {
        findings.push({
          specifier,
          unit,
          verdict: "unresolved",
          detail: `relative import '${specifier}' resolves to no emitted project module`,
        });
      } else {
        findings.push({
          specifier,
          unit,
          verdict: "external-verbatim",
          detail: `unmapped third-party/stdlib module '${root}' passes through verbatim (registry v1 has no mapping; M6 registry scope may add one)`,
        });
      }
    }
  }
  const unresolved = findings.filter((f) => f.verdict === "unresolved");
  const unsupported = findings.filter((f) => f.verdict === "unsupported");
  const details = [
    ...unsupported.map((f) => `${f.unit}: ${f.detail}`),
    ...unresolved.map((f) => `${f.unit}: ${f.detail}`),
  ];
  if (unresolved.length > 0) {
    return {
      stage: "S3-dependencies",
      status: "fail",
      reason: `${String(unresolved.length)} unresolved project import(s)`,
      details,
      findings,
    };
  }
  if (unsupported.length > 0) {
    return {
      stage: "S3-dependencies",
      status: "warn",
      reason: `${String(unsupported.length)} registry-unsupported module(s)`,
      details,
      findings,
    };
  }
  const externals = findings.filter((f) => f.verdict === "external-verbatim");
  if (externals.length > 0) {
    return {
      stage: "S3-dependencies",
      status: "warn",
      reason: `${String(externals.length)} unmapped external module(s) pass through verbatim`,
      details: externals.map((f) => `${f.unit}: ${f.detail}`),
      findings,
    };
  }
  return {
    stage: "S3-dependencies",
    status: "pass",
    reason: null,
    details: [],
    findings,
  };
}

// Normalize a source import specifier to a module id relative to the importing
// unit (relative imports resolve against the unit's directory; absolute stay
// as-is). JS/TS relative specifiers carry their JS extension (or none) — stripped
// so the emitted .py candidate can be derived.
function normalizeSpecifier(specifier: string, unit: string): string {
  if (!specifier.startsWith(".")) {
    if (unit.endsWith(".py")) {
      // Python absolute imports name project modules too (`import helper`) —
      // the .py candidate derives from the name itself.
      return `${specifier}.py`;
    }
    // JS/TS bare specifiers are externals (packages) — no local candidate.
    return specifier;
  }
  let rest = specifier;
  let level = 0;
  while (rest.startsWith(".")) {
    level += 1;
    rest = rest.slice(1);
  }
  rest = rest.replace(/\.(js|ts|tsx|jsx|mjs|cjs)$/, "");
  rest = rest.replace(/^\//, ""); // the dot-count loop leaves a leading separator
  if (rest.endsWith("/")) rest = rest.slice(0, -1);
  if (rest === "") rest = "index";
  const parts = unit.split("/");
  parts.pop(); // the unit's own filename
  for (let i = 1; i < level; i += 1) parts.pop();
  return [...parts, `${rest}.py`].filter((segment) => segment !== "").join("/");
}
