import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { findBrokenDocLinks } from "./check-doc-links.mjs";

function makeTempTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ctrans-doclinks-"));
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(root, path);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return root;
}

describe("findBrokenDocLinks", () => {
  it("reports repository-relative links that point at missing files", () => {
    const root = makeTempTree({
      "docs/a.md": "See [b](b.md) and [missing](nope.md) and [anchor](b.md#section).",
      "docs/b.md": "ok",
    });
    try {
      expect(findBrokenDocLinks(root)).toEqual([{ file: join("docs", "a.md"), link: "nope.md" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores external links, bare anchors, and skipped directories", () => {
    const root = makeTempTree({
      "README.md": "[site](https://example.com) [here](mailto:x@y.z) [self](#top)",
      "node_modules/pkg/README.md": "[broken](../missing.md)",
      "docs/guide.md": "text",
    });
    try {
      expect(findBrokenDocLinks(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds no broken links in this repository", () => {
    // Repo root is two levels up from this test file.
    expect(findBrokenDocLinks(new URL("..", import.meta.url).pathname)).toEqual([]);
  });
});
