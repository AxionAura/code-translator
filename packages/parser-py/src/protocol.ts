// Validation guards for bridge output (D-018). Bridge responses are semi-trusted
// data: every field is checked here before anything downstream sees a typed value.
// Guards are hand-written (zero-dependency policy) and the AST validator is iterative
// with an explicit stack, mirroring the bridge's own stack-safety on hostile inputs.
import type {
  AstNode,
  AstValue,
  Diagnostic,
  ScopeInfo,
  SourceSpan,
  SymbolFlag,
  TaggedValue,
  TokenInfo,
} from "@ctrans/core";

export const BRIDGE_PROTOCOL_VERSION = 1;

const SYMBOL_FLAGS: readonly SymbolFlag[] = [
  "isLocal",
  "isGlobal",
  "isParameter",
  "isFree",
  "isImported",
  "isAssigned",
  "isReferenced",
  "isDeclaredGlobal",
  "isNonlocal",
];

export interface BridgeHeader {
  readonly protocol: number;
  readonly python: { readonly version: string; readonly full: string };
}

export interface BridgeModuleImport {
  readonly kind: string;
  readonly moduleSpecifier: string;
  readonly importedName: string | null;
  readonly localName: string | null;
  readonly span: SourceSpan;
}

export interface BridgeModuleInfo {
  readonly hasModuleSyntax: boolean;
  readonly imports: readonly BridgeModuleImport[];
  readonly exports: readonly unknown[];
  readonly dynamicImports: readonly unknown[];
}

export interface BridgeParseResult {
  readonly sourceEncoding: string;
  readonly ast: AstNode;
  readonly tokens: readonly TokenInfo[];
  readonly scopes: ScopeInfo | null;
  readonly module: BridgeModuleInfo | null;
}

export interface BridgeParseEnvelope {
  readonly ok: true;
  readonly header: BridgeHeader;
  readonly result: BridgeParseResult;
  readonly diagnostics: readonly Diagnostic[];
}

export interface BridgeErrorPayload {
  readonly kind: string;
  readonly message: string;
  readonly lineno: number | null;
  readonly offset: number | null;
  readonly endLineno: number | null;
  readonly endOffset: number | null;
  readonly limit: string | null;
}

export interface BridgeErrorEnvelope {
  readonly ok: false;
  readonly header: BridgeHeader;
  readonly error: BridgeErrorPayload;
}

export type BridgeEnvelope = BridgeParseEnvelope | BridgeErrorEnvelope;

export class ValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string") {
    throw new ValidationError(`expected string field "${name}"`);
  }
  return value;
}

function intField(record: Record<string, unknown>, name: string): number {
  const value = record[name];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ValidationError(`expected integer field "${name}"`);
  }
  return value;
}

export function validateHeader(value: unknown): BridgeHeader {
  if (!isRecord(value) || !isRecord(value["python"])) {
    throw new ValidationError("header must be an object with a python object");
  }
  const protocol = intField(value, "protocol");
  const python = value["python"] as Record<string, unknown>;
  return {
    protocol,
    python: { version: stringField(python, "version"), full: stringField(python, "full") },
  };
}

export function validateHandshakeEnvelope(value: unknown): BridgeHeader {
  if (!isRecord(value) || value["ok"] !== true) {
    throw new ValidationError("handshake envelope must be {ok: true, header}");
  }
  return validateHeader(value["header"]);
}

export function validateEnvelope(value: unknown): BridgeEnvelope {
  if (!isRecord(value) || typeof value["ok"] !== "boolean") {
    throw new ValidationError("envelope must be an object with a boolean ok field");
  }
  const header = validateHeader(value["header"]);
  if (value["ok"]) {
    return {
      ok: true,
      header,
      result: validateParseResult(value["result"]),
      diagnostics: validateDiagnostics(value["diagnostics"]),
    };
  }
  return { ok: false, header, error: validateErrorPayload(value["error"]) };
}

function validateSpan(value: unknown): SourceSpan {
  if (!isRecord(value)) {
    throw new ValidationError("span must be an object");
  }
  for (const key of ["start", "end"] as const) {
    const position = value[key];
    if (!isRecord(position)) {
      throw new ValidationError(`span.${key} must be an object`);
    }
    intField(position, "line");
    intField(position, "column");
  }
  const startByteOffset = intField(value, "startByteOffset");
  const endByteOffset = intField(value, "endByteOffset");
  if (endByteOffset < startByteOffset) {
    throw new ValidationError("span end precedes start");
  }
  return value as unknown as SourceSpan;
}

function validateTagged(value: Record<string, unknown>): TaggedValue {
  switch (value["tag"]) {
    case "int": {
      const decimal = value["decimal"];
      if (typeof decimal !== "string" || !/^-?\d+$/.test(decimal)) {
        throw new ValidationError("tagged int needs a decimal string");
      }
      return { tag: "int", decimal };
    }
    case "float": {
      const stored = value["value"];
      if (stored !== "inf" && stored !== "-inf" && stored !== "nan") {
        throw new ValidationError("tagged float needs inf/-inf/nan");
      }
      return { tag: "float", value: stored };
    }
    case "bytes": {
      const base64 = value["base64"];
      if (typeof base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
        throw new ValidationError("tagged bytes needs base64");
      }
      return { tag: "bytes", base64 };
    }
    case "complex": {
      const real = value["real"];
      const imaginary = value["imaginary"];
      if (typeof real !== "number" || !Number.isFinite(real)) {
        throw new ValidationError("tagged complex needs finite real");
      }
      if (typeof imaginary !== "number" || !Number.isFinite(imaginary)) {
        throw new ValidationError("tagged complex needs finite imaginary");
      }
      return { tag: "complex", real, imaginary };
    }
    case "ellipsis":
      return { tag: "ellipsis" };
    default:
      throw new ValidationError(`unknown tagged value "${String(value["tag"])}"`);
  }
}

// The bridge contract distinguishes AST nodes from scalars purely by shape:
// nodes are records with string `kind`, `span`, and record `fields`.
function isAstShaped(value: Record<string, unknown>): boolean {
  return typeof value["kind"] === "string" && "span" in value && "fields" in value;
}

function validateScalar(value: unknown): void {
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "string"
  ) {
    return;
  }
  if (isRecord(value) && typeof value["tag"] === "string") {
    validateTagged(value);
    return;
  }
  throw new ValidationError("unexpected scalar value in AST");
}

interface AssembleFrame {
  kind: string;
  span: SourceSpan | null;
  plan: Array<{ name: string; shape: "single" | "list"; slots: Array<AstValue | symbol> }>;
}

const POP_MARKER = Symbol("ctrans.pop");

// Iterative post-order validation: children are validated (and counted) before their
// parent frame assembles, so pathological AST depth cannot exhaust the JS stack.
export function validateAst(value: unknown): AstNode {
  const finished: AstNode[] = [];
  type Entry = { readonly visit: unknown } | { readonly assemble: AssembleFrame };
  const stack: Entry[] = [{ visit: value }];
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if ("assemble" in entry) {
      const frame = entry.assemble;
      const popCount = frame.plan.reduce(
        (count, field) => count + field.slots.filter((slot) => slot === POP_MARKER).length,
        0,
      );
      const children = finished.splice(finished.length - popCount).reverse();
      let cursor = 0;
      const nextChild = (): AstNode => {
        const child = children[cursor];
        cursor += 1;
        if (child === undefined) {
          throw new ValidationError("AST child count mismatch");
        }
        return child;
      };
      const fields: Record<string, AstValue> = {};
      for (const field of frame.plan) {
        const values = field.slots.map((slot) =>
          slot === POP_MARKER ? nextChild() : (slot as AstValue),
        );
        if (field.shape === "single") {
          if (values.length !== 1) {
            throw new ValidationError(`single field "${field.name}" must have one value`);
          }
          fields[field.name] = values[0]!;
        } else {
          fields[field.name] = values;
        }
      }
      finished.push({ kind: frame.kind, span: frame.span, fields });
      continue;
    }
    const current = entry.visit;
    if (!isRecord(current) || !isAstShaped(current)) {
      throw new ValidationError("AST node must be an object with kind/span/fields");
    }
    const kind = stringField(current, "kind");
    const span = current["span"] === null ? null : validateSpan(current["span"]);
    const rawFields = current["fields"];
    if (!isRecord(rawFields)) {
      throw new ValidationError("AST node fields must be an object");
    }
    const frame: AssembleFrame = { kind, span, plan: [] };
    // The assemble frame is pushed before its children: children complete first (LIFO).
    stack.push({ assemble: frame });
    for (const [name, fieldValue] of Object.entries(rawFields)) {
      if (Array.isArray(fieldValue)) {
        const slots: Array<AstValue | symbol> = [];
        for (const item of fieldValue) {
          if (isRecord(item) && isAstShaped(item)) {
            slots.push(POP_MARKER);
            stack.push({ visit: item });
          } else {
            validateScalar(item);
            slots.push(item as AstValue);
          }
        }
        frame.plan.push({ name, shape: "list", slots });
      } else if (isRecord(fieldValue) && isAstShaped(fieldValue)) {
        frame.plan.push({ name, shape: "single", slots: [POP_MARKER] });
        stack.push({ visit: fieldValue });
      } else {
        validateScalar(fieldValue);
        frame.plan.push({ name, shape: "single", slots: [fieldValue as AstValue] });
      }
    }
  }
  if (finished.length !== 1) {
    throw new ValidationError("AST must have exactly one root node");
  }
  return finished[0]!;
}

export function validateParseResult(value: unknown): BridgeParseResult {
  if (!isRecord(value)) {
    throw new ValidationError("result must be an object");
  }
  const sourceEncoding = stringField(value, "sourceEncoding");
  const ast = validateAst(value["ast"]);
  if (!Array.isArray(value["tokens"])) {
    throw new ValidationError("tokens must be an array");
  }
  const tokens: TokenInfo[] = value["tokens"].map((token) => {
    if (!isRecord(token)) {
      throw new ValidationError("token must be an object");
    }
    return {
      kind: stringField(token, "kind"),
      text: stringField(token, "text"),
      span: validateSpan(token["span"]),
    };
  });
  const scopes = value["scopes"] === null ? null : validateScope(value["scopes"]);
  const moduleValue = value["module"];
  const module =
    moduleValue === null || moduleValue === undefined ? null : validateModule(moduleValue);
  return { sourceEncoding, ast, tokens, scopes, module };
}

// Kinds the Python bridge emits ("namespace" for module-object bindings incl.
// `import *`, "named" for from-imports) — a subset of the core ImportKind union.
const BRIDGE_IMPORT_KINDS = new Set(["namespace", "named"]);

function validateModule(value: unknown): BridgeModuleInfo {
  if (!isRecord(value) || typeof value["hasModuleSyntax"] !== "boolean") {
    throw new ValidationError("module must be an object with hasModuleSyntax");
  }
  if (!Array.isArray(value["imports"])) {
    throw new ValidationError("module imports must be an array");
  }
  const imports = value["imports"].map((entry) => {
    if (!isRecord(entry) || typeof entry["kind"] !== "string") {
      throw new ValidationError("module import must be an object with a kind");
    }
    if (!BRIDGE_IMPORT_KINDS.has(entry["kind"])) {
      throw new ValidationError(`unknown bridge import kind "${entry["kind"]}"`);
    }
    const importedName = entry["importedName"];
    const localName = entry["localName"];
    for (const [name, fieldValue] of [
      ["moduleSpecifier", entry["moduleSpecifier"]],
      ["importedName", importedName],
      ["localName", localName],
    ] as const) {
      if (fieldValue !== null && typeof fieldValue !== "string") {
        throw new ValidationError(`module import "${name}" must be a string or null`);
      }
    }
    return {
      kind: entry["kind"],
      moduleSpecifier: entry["moduleSpecifier"] as string,
      importedName: importedName as string | null,
      localName: localName as string | null,
      span: validateSpan(entry["span"]),
    };
  });
  return {
    hasModuleSyntax: value["hasModuleSyntax"],
    imports,
    exports: Array.isArray(value["exports"]) ? value["exports"] : [],
    dynamicImports: Array.isArray(value["dynamicImports"]) ? value["dynamicImports"] : [],
  };
}

function validateScope(value: unknown): ScopeInfo {
  if (!isRecord(value)) {
    throw new ValidationError("scope must be an object");
  }
  if (!Array.isArray(value["symbols"]) || !Array.isArray(value["children"])) {
    throw new ValidationError("scope needs symbols and children arrays");
  }
  const line = value["line"];
  if (line !== null && (typeof line !== "number" || !Number.isInteger(line))) {
    throw new ValidationError("scope line must be null or integer");
  }
  return {
    kind: stringField(value, "kind"),
    name: stringField(value, "name"),
    line,
    symbols: value["symbols"].map((symbol) => {
      if (!isRecord(symbol) || !isRecord(symbol["flags"])) {
        throw new ValidationError("symbol must be an object with flags");
      }
      const flags = {} as Record<SymbolFlag, boolean>;
      for (const flag of SYMBOL_FLAGS) {
        const flagValue = symbol["flags"][flag];
        if (typeof flagValue !== "boolean") {
          throw new ValidationError(`symbol flag "${flag}" must be boolean`);
        }
        flags[flag] = flagValue;
      }
      return { name: stringField(symbol, "name"), flags };
    }),
    children: value["children"].map((child) => validateScope(child)),
  };
}

export function validateDiagnostics(value: unknown): Diagnostic[] {
  if (!Array.isArray(value)) {
    throw new ValidationError("diagnostics must be an array");
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new ValidationError("diagnostic must be an object");
    }
    const severity = entry["severity"];
    if (severity !== "warning" && severity !== "info") {
      throw new ValidationError("diagnostic severity must be warning|info");
    }
    return {
      severity,
      code: stringField(entry, "code"),
      message: stringField(entry, "message"),
      span: entry["span"] === null ? null : validateSpan(entry["span"]),
    };
  });
}

export function validateErrorPayload(value: unknown): BridgeErrorPayload {
  if (!isRecord(value)) {
    throw new ValidationError("error must be an object");
  }
  const nullableInt = (name: string): number | null => {
    const numberValue = value[name];
    if (numberValue === null || numberValue === undefined) return null;
    if (typeof numberValue !== "number" || !Number.isInteger(numberValue)) {
      throw new ValidationError(`error field "${name}" must be null or integer`);
    }
    return numberValue;
  };
  return {
    kind: stringField(value, "kind"),
    message: stringField(value, "message"),
    lineno: nullableInt("lineno"),
    offset: nullableInt("offset"),
    endLineno: nullableInt("endLineno"),
    endOffset: nullableInt("endOffset"),
    limit: typeof value["limit"] === "string" ? value["limit"] : null,
  };
}
