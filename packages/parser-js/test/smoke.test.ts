import { describe, expect, it } from "vitest";

import { packageName } from "../src/index.js";

describe("@ctrans/parser-js skeleton", () => {
  it("loads its entry point", () => {
    expect(packageName).toBe("@ctrans/parser-js");
  });
});
