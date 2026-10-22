// Mechanical enforcement of the package dependency direction from docs/architecture.md §3
// and ADR D-017: @axion-ct/core is the base layer that owns all cross-package types and
// interfaces; implementation packages depend on core and strictly lower layers only, which
// makes the graph acyclic by construction. Update LAYERS when packages or edges change.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

// Higher number = higher layer. A package may depend only on strictly lower layers.
const LAYERS: Record<string, number> = {
  "@axion-ct/core": 0,
  "@axion-ct/parser-py": 1,
  "@axion-ct/parser-js": 1,
  "@axion-ct/codegen-js": 1,
  "@axion-ct/codegen-py": 1,
  "@axion-ct/registry": 1,
  "@axion-ct/sandbox": 1,
  "@axion-ct/validator": 2,
  "@axion-ct/ai": 2,
  "@axion-ct/repair": 3,
  "@axion-ct/cli": 4,
};

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function workspacePackages(): Manifest[] {
  const manifests: Manifest[] = [];
  for (const group of ["packages", "apps"]) {
    for (const dir of readdirSync(join(REPO_ROOT, group), { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const manifestPath = join(REPO_ROOT, group, dir.name, "package.json");
      manifests.push(JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest);
    }
  }
  return manifests;
}

describe("workspace package boundaries", () => {
  it("classifies every workspace package in the layer map (and nothing else)", () => {
    const names = workspacePackages()
      .map((m) => m.name)
      .sort();
    expect(names).toEqual(Object.keys(LAYERS).sort());
  });

  it("only allows dependencies on strictly lower layers", () => {
    const violations: string[] = [];
    for (const manifest of workspacePackages()) {
      const selfLayer = LAYERS[manifest.name];
      if (selfLayer === undefined) continue; // misclassification is reported by the test above
      for (const section of ["dependencies", "devDependencies"] as const) {
        for (const dep of Object.keys(manifest[section] ?? {})) {
          if (!dep.startsWith("@axion-ct/")) continue;
          const depLayer = LAYERS[dep];
          if (depLayer === undefined || depLayer >= selfLayer) {
            violations.push(`${manifest.name} (${section}) -> ${dep}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
