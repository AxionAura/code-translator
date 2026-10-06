import { describe, expect, it } from "vitest";

import { packageName } from "../src/index.js";

describe("@ctrans/registry skeleton", () => {
  it("loads its entry point", () => {
    expect(packageName).toBe("@ctrans/registry");
  });
});
