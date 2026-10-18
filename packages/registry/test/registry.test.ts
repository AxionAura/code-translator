// Registry v1 structural invariants (docs/dependency-mapping.md §3/§5): unique
// ids, honest fidelity declarations, unique method (receiver, name) pairs, and
// lookup determinism. Behavioral usage tests live in @ctrans/codegen-js
// (registry-methods.test.ts) — a mapping claim without a behavior test is a bug,
// so every entry here must have a matching emission path exercised there.
import { describe, expect, it } from "vitest";

import {
  BUILTIN_MAPPINGS,
  METHOD_MAPPINGS,
  MODULE_MAPPINGS,
  lookupBuiltin,
  lookupMethod,
  lookupModule,
} from "../src/index.js";

describe("registry v1 structural invariants", () => {
  it("has unique builtin, method, and module ids", () => {
    const builtinIds = [...BUILTIN_MAPPINGS.values()].map((entry) => entry.id);
    expect(new Set(builtinIds).size).toBe(builtinIds.length);
    const methodIds = METHOD_MAPPINGS.map((entry) => entry.id);
    expect(new Set(methodIds).size).toBe(methodIds.length);
    const moduleIds = MODULE_MAPPINGS.map((entry) => entry.id);
    expect(new Set(moduleIds).size).toBe(moduleIds.length);
  });

  it("has unique (receiver, name) method pairs", () => {
    const keys = METHOD_MAPPINGS.map((entry) => `${entry.receiver}.${entry.name}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("declares partial fidelity wherever a divergence note exists", () => {
    // full-fidelity entries may not carry divergence notes: honesty by construction.
    for (const builtin of BUILTIN_MAPPINGS.values()) {
      if (builtin.fidelity === "full") expect(builtin.notes).toHaveLength(0);
    }
    for (const method of METHOD_MAPPINGS) {
      if (method.fidelity === "full") {
        const notes = method.emit.kind === "unsupported" ? [] : method.emit.notes;
        expect(notes).toHaveLength(0);
      }
    }
    for (const module of MODULE_MAPPINGS) {
      if (module.fidelity === "full") expect(module.notes).toHaveLength(0);
    }
  });

  it("resolves lookups deterministically", () => {
    expect(lookupBuiltin("sorted")?.emit).toEqual({ kind: "helper", helper: "sorted" });
    expect(lookupBuiltin("nonexistent")).toBeNull();
    expect(lookupMethod("array", "append")?.emit).toEqual({
      kind: "rename",
      method: "push",
      notes: expect.any(Array),
    });
    expect(lookupMethod("array", "transmogrify")).toBeNull();
    expect(lookupMethod("string", "upper")?.emit).toMatchObject({ method: "toUpperCase" });
    expect(lookupModule("requests")?.syncAsync).toBe("sync-to-async");
    expect(lookupModule("ctypes")).toBeNull();
  });

  it("marks exactly the async boundary modules", () => {
    const asyncModules = MODULE_MAPPINGS.filter((entry) => entry.syncAsync === "sync-to-async").map(
      (entry) => entry.module,
    );
    expect(asyncModules).toEqual(["requests"]);
  });
});
