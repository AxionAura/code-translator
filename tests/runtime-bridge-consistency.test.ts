// Bridge consistency (D-029): every codegen-js runtime helper name a generated
// module can import (non-internal registry keys) must have a Python-semantic
// bridge definition in codegen-py, so a Py→TS→Py round-trip never imports a
// name the emitted runtime fails to define. The documented exception list is
// empty: all non-internal helpers are bridged (truthy's same-name collision
// with codegen-py's JS-truthy helper is handled inside renderPyRuntime).
import { describe, expect, it } from "vitest";

import { RUNTIME_HELPERS } from "@axion-ct/codegen-js";
import { CODEGEN_JS_RUNTIME_BRIDGE } from "@axion-ct/codegen-py";

// Names deliberately excluded from the bridge, with reasons. Keep empty unless
// a helper genuinely has no honest Python-semantic definition.
const BRIDGE_EXCEPTIONS: readonly { readonly name: string; readonly reason: string }[] = [];

describe("runtime bridge consistency (codegen-js exports vs codegen-py bridges)", () => {
  it("bridges every importable (non-internal) codegen-js runtime helper name", () => {
    const importable = Object.entries(RUNTIME_HELPERS)
      .filter(([, helper]) => helper.internal !== true)
      .map(([key]) => `__ctrans_${key}`);
    expect(importable.length).toBeGreaterThan(50);
    const exceptions = new Set(BRIDGE_EXCEPTIONS.map((entry) => entry.name));
    const missing = importable.filter(
      (name) => CODEGEN_JS_RUNTIME_BRIDGE[name] === undefined && !exceptions.has(name),
    );
    expect(missing, `bridge definitions missing for: ${missing.join(", ")}`).toEqual([]);
    // Every claimed exception must reference a real helper with a recorded reason.
    for (const exception of BRIDGE_EXCEPTIONS) {
      expect(importable, exception.name).toContain(exception.name);
      expect(exception.reason.length).toBeGreaterThan(10);
    }
  });

  it("defines no orphan bridges (every bridge name is an importable helper)", () => {
    const importable = new Set(
      Object.entries(RUNTIME_HELPERS)
        .filter(([, helper]) => helper.internal !== true)
        .map(([key]) => `__ctrans_${key}`),
    );
    const orphans = Object.keys(CODEGEN_JS_RUNTIME_BRIDGE).filter((name) => !importable.has(name));
    expect(orphans).toEqual([]);
  });

  it("bridges truthy with PYTHON semantics and documents the same-name collision", () => {
    // Round-tripped truthiness must restore Python's bool(): NaN is truthy in
    // Python (falsy in JS); empty containers are falsy in Python (truthy in
    // JS). renderPyRuntime resolves the collision when a module needs both.
    expect(CODEGEN_JS_RUNTIME_BRIDGE["__ctrans_truthy"]).toBeDefined();
    expect(CODEGEN_JS_RUNTIME_BRIDGE["__ctrans_truthy"]).toContain("bool(value)");
  });
});
