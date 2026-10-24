// Single authoritative generator-version source. Workspace packages are released
// from one synchronized version; @axion-ct/core reads its own published manifest
// so reports and generated headers cannot drift into a hand-maintained constant.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };

if (typeof manifest.version !== "string" || manifest.version === "") {
  throw new TypeError("@axion-ct/core package manifest has no version");
}

export const ENGINE_VERSION: string = manifest.version;
