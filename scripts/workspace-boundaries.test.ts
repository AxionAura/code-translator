// Mechanical enforcement of the package dependency direction from docs/architecture.md §3:
// layers may only depend on strictly lower layers, which makes the graph acyclic by
// construction. When M1+ wires the first real cross-package dependency, this test is what
// keeps the direction honest.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

// Higher number = higher layer. A package may depend only on strictly lower layers.
const LAYERS: Record<string, number> = {
  "@ctrans/cli": 4,
  "@ctrans/repair": 3,
  "@ctrans/validator": 2,
  "@ctrans/ai": 2,
  "@ctrans/core": 1,
  "@ctrans/parser-py": 0,
  "@ctrans/parser-js": 0,
  "@ctrans/codegen-js": 0,
  "@ctrans/codegen-py": 0,
  "@ctrans/registry": 0,
  "@ctrans/sandbox": 0,
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
          if (!dep.startsWith("@ctrans/")) continue;
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
