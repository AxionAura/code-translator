// ESM resolve hook for the unbuilt CLI: resolves `.js` relative specifiers to their
// TypeScript sources, and workspace package names to their source entry points, so
// `node bin/ctrans.mjs` runs the noEmit workspace without a build. The compiled
// distribution (`bin/ctrans-dist.mjs`) resolves package exports -> dist instead.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGES_ROOT = new URL("../../../packages/", import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@axion-ct/") && !specifier.slice("@axion-ct/".length).includes("/")) {
    const name = specifier.slice("@axion-ct/".length);
    const source = new URL(`${name}/src/index.ts`, PACKAGES_ROOT);
    if (existsSync(fileURLToPath(source))) {
      return { url: pathToFileURL(fileURLToPath(source)).href, shortCircuit: true };
    }
  }
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL !== undefined) {
    const candidate = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(candidate))) {
      const tsCandidate = specifier.slice(0, -3) + ".ts";
      const resolved = new URL(tsCandidate, context.parentURL);
      if (existsSync(fileURLToPath(resolved))) {
        return { url: pathToFileURL(fileURLToPath(resolved)).href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}
