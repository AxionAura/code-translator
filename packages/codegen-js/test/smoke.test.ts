import { describe, expect, it } from "vitest";

import { packageName } from "../src/index.js";

describe("@axion-ct/codegen-js skeleton", () => {
  it("loads its entry point", () => {
    expect(packageName).toBe("@axion-ct/codegen-js");
  });
});
