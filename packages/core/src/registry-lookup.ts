// D-017 layer injection: the dependency registry lives one layer up
// (@ctrans/registry); codegen consumes it only through this core-defined lookup
// interface, wired by the CLI. The default implementation (no registry wired)
// reports null for every query — the honest M4 surface (unmapped warnings).
export type RegistryFidelity = "full" | "partial" | "lossy";

export interface BuiltinMappingView {
  readonly id: string;
  readonly helper: string;
  readonly fidelity: RegistryFidelity;
  readonly notes: readonly string[];
  readonly arity: { readonly min: number; readonly max: number };
}

export type MethodEmit =
  | { kind: "rename"; method: string; notes: readonly string[] }
  | { kind: "helper"; helper: string; notes: readonly string[] }
  | { kind: "unsupported"; reason: string };

export interface MethodMappingView {
  readonly id: string;
  readonly fidelity: RegistryFidelity;
  readonly emit: MethodEmit;
}

export interface ModuleMappingView {
  readonly module: string;
  readonly syncAsync: "sync-to-sync" | "sync-to-async";
  readonly emit:
    | { kind: "verbatim" }
    | { kind: "rewrite"; specifier: string }
    | { kind: "unsupported"; reason: string };
}

export interface RegistryLookup {
  lookupBuiltin(name: string): BuiltinMappingView | null;
  lookupMethod(
    receiver: "array" | "map" | "string" | "set",
    name: string,
  ): MethodMappingView | null;
  lookupModule(module: string): ModuleMappingView | null;
}

export const NO_REGISTRY: RegistryLookup = {
  lookupBuiltin: () => null,
  lookupMethod: () => null,
  lookupModule: () => null,
};
