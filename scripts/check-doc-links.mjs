// Verifies that repository-relative links in Markdown files point at existing files.
// Deliberately dependency-free so `pnpm docs:check` works on a fresh clone.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SKIP_DIRS = new Set([".git", ".ctrans", "coverage", "dist", "node_modules"]);

// Inline links and images: [text](target) / ![alt](target). Reference-style links and
// angle-bracket targets are not used in this repository's documentation.
const LINK_PATTERN = /\[[^\]]*\]\(([^)\s]+)\)/g;
const EXTERNAL_PATTERN = /^(https?:|mailto:|data:)/;

function listMarkdownFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) listMarkdownFiles(join(dir, entry.name), out);
    } else if (extname(entry.name) === ".md") {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

export function findBrokenDocLinks(rootDir = process.cwd()) {
  const root = resolve(rootDir);
  const broken = [];
  for (const file of listMarkdownFiles(root)) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(LINK_PATTERN)) {
      const link = match[1];
      if (EXTERNAL_PATTERN.test(link)) continue;
      const pathPart = link.split("#")[0];
      if (pathPart === "") continue; // same-document anchor
      let target = pathPart;
      try {
        target = decodeURIComponent(pathPart);
      } catch {
        // keep the raw path when it is not valid percent-encoding
      }
      if (!existsSync(resolve(dirname(file), target))) {
        broken.push({ file: relative(root, file), link });
      }
    }
  }
  return broken;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const broken = findBrokenDocLinks();
  if (broken.length > 0) {
    for (const { file, link } of broken) console.error(`broken link in ${file}: ${link}`);
    console.error(`found ${broken.length} broken documentation link(s)`);
    process.exitCode = 1;
  } else {
    console.log("documentation links OK");
  }
}
