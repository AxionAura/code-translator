import { describe, expect, it } from "vitest";

import { packageName } from "../src/index.js";

describe("@axion-ct/repair skeleton", () => {
  it("loads its entry point", () => {
    expect(packageName).toBe("@axion-ct/repair");
  });
});
