// ESM resolve hook for the unbuilt CLI: resolves `.js` relative specifiers to their
// TypeScript sources so `node bin/ctrans.mjs` runs the noEmit workspace directly.
// Replaced by compiled dist output when the build step lands (docs/roadmap.md).
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
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
