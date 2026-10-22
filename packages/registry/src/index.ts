// Dependency-mapping registry v1 (D-011): deterministic, in-repo mapping data.
// Every entry declares its supported input pattern, target emission, semantic
// divergences, and fidelity. Entries without honest usage coverage stay out of the
// table (docs/dependency-mapping.md §5: a mapping claim without a test is a bug).
//
// M5 surface (retiring the matching M4 warnings at use sites):
// - builtin call mappings (`sorted`, `list`, `min`, `max`, `reversed`, `zip`,
//   `next`, `abs`, `bool`, `enumerate`) — emitted through `__ctrans_` runtime
//   helpers that reproduce Python semantics exactly (never name-for-name swaps);
// - method mappings on Python-mapped receivers (list.append -> push with its
//   documented return divergence; dict.get/keys/values/items; str methods);
// - module mappings for stdlib modules whose target semantics are implemented and
//   usage-tested in M5 (`math`, `json`, `sys`, `random`);
// - the `requests` -> fetch sync-to-async module entry consumed by the M5
//   async-rewire engine (docs/dependency-mapping.md §6).
import type { RegistryLookup } from "@axion-ct/core";
import type { SyncAsync } from "./async.js";

export type RegistryFidelity = "full" | "partial" | "lossy";

// How a mapped builtin call is emitted. `helper` produces a call to a generated
// `__ctrans_` runtime helper (Python semantics preserved); `native` replaces the
// call with a proven-equivalent JS expression shape.
export type BuiltinEmit = { kind: "helper"; helper: string } | { kind: "native"; template: string };

export interface BuiltinMapping {
  readonly id: string;
  readonly name: string;
  // Argument shapes this entry supports (arity; kwargs forms are outside M5).
  readonly arity: { readonly min: number; readonly max: number };
  readonly emit: BuiltinEmit;
  readonly fidelity: RegistryFidelity;
  // Documented divergences shown in the ledger adaptation text.
  readonly notes: readonly string[];
}

// Receiver kinds come from the lowering's CommonType classification.
export type ReceiverKind = "array" | "map" | "string" | "set";

export interface MethodMapping {
  readonly id: string;
  readonly receiver: ReceiverKind;
  readonly name: string;
  readonly emit:
    | { kind: "rename"; method: string; notes: readonly string[] }
    | { kind: "helper"; helper: string; notes: readonly string[] }
    | { kind: "unsupported"; reason: string };
  readonly fidelity: RegistryFidelity;
}

export interface ModuleMapping {
  readonly id: string;
  readonly module: string;
  // `rewrite` emits the import from the generated __ctrans_<name> module.
  readonly emit:
    | { kind: "verbatim" }
    | { kind: "rewrite"; specifier: string }
    | { kind: "unsupported"; reason: string };
  readonly fidelity: RegistryFidelity;
  readonly syncAsync: SyncAsync;
  readonly notes: readonly string[];
}

export const BUILTIN_MAPPINGS: ReadonlyMap<string, BuiltinMapping> = new Map(
  (
    [
      {
        id: "builtin.sorted",
        name: "sorted",
        arity: { min: 1, max: 1 },
        emit: { kind: "helper", helper: "sorted" },
        fidelity: "partial",
        notes: [
          "stable sort with Python's total-order semantics; key=/reverse= kwargs are outside the M5 call surface",
        ],
      },
      {
        id: "builtin.list",
        name: "list",
        arity: { min: 0, max: 1 },
        emit: { kind: "helper", helper: "list" },
        fidelity: "partial",
        notes: ["materializes any iterable (list(x)); list() produces a fresh empty array"],
      },
      {
        id: "builtin.min",
        name: "min",
        arity: { min: 1, max: 1 },
        emit: { kind: "helper", helper: "min" },
        fidelity: "partial",
        notes: [
          "single-iterable form only; min(a, b) and key=/default= kwargs are outside the M5 call surface",
        ],
      },
      {
        id: "builtin.max",
        name: "max",
        arity: { min: 1, max: 1 },
        emit: { kind: "helper", helper: "max" },
        fidelity: "partial",
        notes: [
          "single-iterable form only; max(a, b) and key=/default= kwargs are outside the M5 call surface",
        ],
      },
      {
        id: "builtin.reversed",
        name: "reversed",
        arity: { min: 1, max: 1 },
        emit: { kind: "helper", helper: "reversed" },
        fidelity: "partial",
        notes: [
          "Python returns a lazy iterator; the helper materializes an array (documented divergence)",
        ],
      },
      {
        id: "builtin.zip",
        name: "zip",
        arity: { min: 1, max: 3 },
        emit: { kind: "helper", helper: "zip" },
        fidelity: "partial",
        notes: ["materializes pairs as arrays; truncates to the shortest input like Python"],
      },
      {
        id: "builtin.next",
        name: "next",
        arity: { min: 1, max: 1 },
        emit: { kind: "helper", helper: "next" },
        fidelity: "partial",
        notes: [
          "next(it) raises the StopIteration-equivalent when exhausted; the default-value form next(it, d) is outside the M5 call surface",
        ],
      },
      {
        id: "builtin.abs",
        name: "abs",
        arity: { min: 1, max: 1 },
        emit: { kind: "helper", helper: "abs" },
        fidelity: "partial",
        notes: [],
      },
      {
        id: "builtin.bool",
        name: "bool",
        arity: { min: 1, max: 1 },
        emit: { kind: "helper", helper: "truthy" },
        fidelity: "partial",
        notes: ["bool(x) is exactly Python truthiness (the existing D-016 helper)"],
      },
      {
        id: "builtin.enumerate",
        name: "enumerate",
        arity: { min: 1, max: 1 },
        emit: { kind: "helper", helper: "enumerate" },
        fidelity: "partial",
        notes: ["materializes [index, value] pairs; start= kwarg is outside the M5 call surface"],
      },
    ] satisfies BuiltinMapping[]
  ).map((entry) => [entry.name, entry]),
);

// Method mappings per mapped receiver kind. `rename` entries preserve semantics
// exactly (with the divergence documented when the return shape differs); `helper`
// entries route through a Python-semantics runtime helper. "method" field shapes:
// "length-zero" -> `(xs.length = 0)`; "slice" -> `xs.slice()`; "keys-object" etc.
// -> `Object.keys(d)`; "push-spread" -> `xs.push(...other)`.
export const METHOD_MAPPINGS: readonly MethodMapping[] = [
  // list (Array receivers)
  {
    id: "list.append",
    receiver: "array",
    name: "append",
    emit: {
      kind: "rename",
      method: "push",
      notes: [
        "Python append returns None; JS push returns the new length (diverges only when the result is used)",
      ],
    },
    fidelity: "partial",
  },
  {
    id: "list.pop",
    receiver: "array",
    name: "pop",
    emit: { kind: "rename", method: "pop", notes: [] },
    fidelity: "partial",
  },
  {
    id: "list.clear",
    receiver: "array",
    name: "clear",
    emit: {
      kind: "rename",
      method: "length-zero",
      notes: ["emitted as `(xs.length = 0)` (JS arrays have no clear)"],
    },
    fidelity: "partial",
  },
  {
    id: "list.copy",
    receiver: "array",
    name: "copy",
    emit: {
      kind: "rename",
      method: "slice",
      notes: ["emitted as `xs.slice()` (shallow copy, same as Python)"],
    },
    fidelity: "partial",
  },
  {
    id: "list.index",
    receiver: "array",
    name: "index",
    emit: {
      kind: "helper",
      helper: "listIndex",
      notes: [
        "Python index uses == and raises ValueError when absent; JS indexOf uses === and returns -1",
      ],
    },
    fidelity: "partial",
  },
  {
    id: "list.count",
    receiver: "array",
    name: "count",
    emit: { kind: "helper", helper: "listCount", notes: ["Python count uses == elementwise"] },
    fidelity: "partial",
  },
  {
    id: "list.remove",
    receiver: "array",
    name: "remove",
    emit: {
      kind: "helper",
      helper: "listRemove",
      notes: ["Python remove uses == and raises ValueError when absent"],
    },
    fidelity: "partial",
  },
  {
    id: "list.insert",
    receiver: "array",
    name: "insert",
    emit: {
      kind: "rename",
      method: "splice",
      notes: ["emitted as `xs.splice(i, 0, v)` (identical semantics)"],
    },
    fidelity: "partial",
  },
  {
    id: "list.extend",
    receiver: "array",
    name: "extend",
    emit: {
      kind: "rename",
      method: "push-spread",
      notes: [
        "emitted as `xs.push(...other)`; Python accepts any iterable, JS spread needs an array",
      ],
    },
    fidelity: "partial",
  },
  {
    id: "list.reverse",
    receiver: "array",
    name: "reverse",
    emit: {
      kind: "rename",
      method: "reverse",
      notes: ["both mutate in place; Python returns None, JS returns the array"],
    },
    fidelity: "partial",
  },
  // dict (Record/object receivers)
  {
    id: "dict.get",
    receiver: "map",
    name: "get",
    emit: {
      kind: "helper",
      helper: "dictGet",
      notes: [
        "Python get returns None for a missing key; the helper returns undefined (None collapse)",
      ],
    },
    fidelity: "partial",
  },
  {
    id: "dict.keys",
    receiver: "map",
    name: "keys",
    emit: { kind: "rename", method: "keys-object", notes: ["emitted as `Object.keys(d)`"] },
    fidelity: "partial",
  },
  {
    id: "dict.values",
    receiver: "map",
    name: "values",
    emit: { kind: "rename", method: "values-object", notes: ["emitted as `Object.values(d)`"] },
    fidelity: "partial",
  },
  {
    id: "dict.items",
    receiver: "map",
    name: "items",
    emit: {
      kind: "rename",
      method: "entries-object",
      notes: ["emitted as `Object.entries(d)` (pairs as [key, value] arrays)"],
    },
    fidelity: "partial",
  },
  {
    id: "dict.pop",
    receiver: "map",
    name: "pop",
    emit: {
      kind: "helper",
      helper: "dictPop",
      notes: ["raises KeyError when the key is absent (no default form in M5)"],
    },
    fidelity: "partial",
  },
  // str (string receivers)
  {
    id: "str.upper",
    receiver: "string",
    name: "upper",
    emit: { kind: "rename", method: "toUpperCase", notes: [] },
    fidelity: "partial",
  },
  {
    id: "str.lower",
    receiver: "string",
    name: "lower",
    emit: { kind: "rename", method: "toLowerCase", notes: [] },
    fidelity: "partial",
  },
  {
    id: "str.strip",
    receiver: "string",
    name: "strip",
    emit: {
      kind: "rename",
      method: "trim",
      notes: ["Python strip() removes surrounding whitespace — identical to JS trim()"],
    },
    fidelity: "partial",
  },
  {
    id: "str.lstrip",
    receiver: "string",
    name: "lstrip",
    emit: { kind: "rename", method: "trimStart", notes: [] },
    fidelity: "partial",
  },
  {
    id: "str.rstrip",
    receiver: "string",
    name: "rstrip",
    emit: { kind: "rename", method: "trimEnd", notes: [] },
    fidelity: "partial",
  },
  {
    id: "str.startswith",
    receiver: "string",
    name: "startswith",
    emit: { kind: "rename", method: "startsWith", notes: [] },
    fidelity: "partial",
  },
  {
    id: "str.endswith",
    receiver: "string",
    name: "endswith",
    emit: { kind: "rename", method: "endsWith", notes: [] },
    fidelity: "partial",
  },
  {
    id: "str.replace",
    receiver: "string",
    name: "replace",
    emit: {
      kind: "rename",
      method: "replaceAll",
      notes: [
        "Python str.replace replaces ALL occurrences; JS replace only the first — replaceAll is the semantic match",
      ],
    },
    fidelity: "partial",
  },
  {
    id: "str.split",
    receiver: "string",
    name: "split",
    emit: {
      kind: "helper",
      helper: "strSplit",
      notes: [
        "Python split() with no separator splits on whitespace runs; split(sep) maps to JS split(sep)",
      ],
    },
    fidelity: "partial",
  },
  {
    id: "str.join",
    receiver: "string",
    name: "join",
    emit: {
      kind: "helper",
      helper: "strJoin",
      notes: ["Python join accepts any iterable of strings"],
    },
    fidelity: "partial",
  },
  {
    id: "str.find",
    receiver: "string",
    name: "find",
    emit: { kind: "rename", method: "indexOf", notes: ["both return -1 when absent"] },
    fidelity: "partial",
  },
  {
    id: "str.capitalize",
    receiver: "string",
    name: "capitalize",
    emit: { kind: "helper", helper: "strCapitalize", notes: [] },
    fidelity: "partial",
  },
  // set (Set receivers)
  {
    id: "set.add",
    receiver: "set",
    name: "add",
    emit: { kind: "rename", method: "add", notes: [] },
    fidelity: "partial",
  },
  {
    id: "set.discard",
    receiver: "set",
    name: "discard",
    emit: { kind: "rename", method: "delete", notes: ["both silently ignore absent members"] },
    fidelity: "partial",
  },
  {
    id: "set.remove",
    receiver: "set",
    name: "remove",
    emit: {
      kind: "helper",
      helper: "setRemove",
      notes: ["Python remove raises KeyError when absent; JS delete does not"],
    },
    fidelity: "partial",
  },
  {
    id: "set.clear",
    receiver: "set",
    name: "clear",
    emit: { kind: "rename", method: "clear", notes: [] },
    fidelity: "partial",
  },
];

// Module mappings — the V1 stdlib scope from docs/dependency-mapping.md §4 whose
// target semantics are honestly implementable and usage-tested in M5. Modules
// needing helper-class wrappers (pathlib, datetime) or dialect rewrites (re) stay
// unmapped until their usage tests exist (an unmapped module is reported, never
// guessed — AGENTS.md §11).
export const MODULE_MAPPINGS: readonly ModuleMapping[] = [
  {
    id: "module.math",
    module: "math",
    emit: { kind: "rewrite", specifier: "./__ctrans_math" },
    fidelity: "partial",
    syncAsync: "sync-to-sync",
    notes: [
      "generated __ctrans_math module with exact Python semantics for the mapped surface (floor/ceil return ints, pow/copysign/isclose, constants)",
    ],
  },
  {
    id: "module.json",
    module: "json",
    emit: { kind: "rewrite", specifier: "./__ctrans_json" },
    fidelity: "partial",
    syncAsync: "sync-to-sync",
    notes: [
      "dumps/loads map to a generated module; sort_keys/indent supported; separators normalized to Python's defaults",
    ],
  },
  {
    id: "module.sys",
    module: "sys",
    emit: { kind: "rewrite", specifier: "./__ctrans_sys" },
    fidelity: "partial",
    syncAsync: "sync-to-sync",
    notes: ["argv, exit, platform, maxsize; sys.modules tricks unsupported"],
  },
  {
    id: "module.random",
    module: "random",
    emit: { kind: "rewrite", specifier: "./__ctrans_random" },
    fidelity: "partial",
    syncAsync: "sync-to-sync",
    notes: [
      "random(), randint, choice, shuffle, seed; the generator differs from CPython's Mersenne Twister (same distribution contract, not value-for-value — documented)",
    ],
  },
  {
    id: "module.requests",
    module: "requests",
    emit: { kind: "rewrite", specifier: "./__ctrans_requests" },
    fidelity: "partial",
    syncAsync: "sync-to-async",
    notes: [
      "requests.get/post/head/delete -> await fetch with the documented response surface (text/json/status_code/raise_for_status); sessions, proxies, and auth objects unsupported",
    ],
  },
];

export { isAsyncBoundary, type SyncAsync } from "./async.js";

export function lookupBuiltin(name: string): BuiltinMapping | null {
  return BUILTIN_MAPPINGS.get(name) ?? null;
}

export function lookupMethod(receiver: ReceiverKind, name: string): MethodMapping | null {
  return (
    METHOD_MAPPINGS.find((entry) => entry.receiver === receiver && entry.name === name) ?? null
  );
}

export function lookupModule(module: string): ModuleMapping | null {
  return MODULE_MAPPINGS.find((entry) => entry.module === module) ?? null;
}

// D-017 layer adapter: the registry implements the core-defined RegistryLookup
// interface so the CLI (layer 4) can inject it into the codegen without a
// codegen -> registry dependency.
export function createRegistryLookup(): RegistryLookup {
  return {
    lookupBuiltin: (name: string) => {
      const hit = lookupBuiltin(name);
      if (hit === null) return null;
      return {
        id: hit.id,
        helper: hit.emit.kind === "helper" ? hit.emit.helper : "",
        fidelity: hit.fidelity,
        notes: hit.notes,
        arity: hit.arity,
      };
    },
    lookupMethod: (receiver, name) => {
      const hit = lookupMethod(receiver, name);
      if (hit === null) return null;
      return { id: hit.id, fidelity: hit.fidelity, emit: hit.emit };
    },
    lookupModule: (module: string) => {
      const hit = lookupModule(module);
      if (hit === null) return null;
      return { module: hit.module, syncAsync: hit.syncAsync, emit: hit.emit };
    },
  };
}
