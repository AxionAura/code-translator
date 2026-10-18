import { describe, expect, it } from "vitest";

import { lookupBuiltin } from "../src/index.js";

describe("@ctrans/registry entry point", () => {
  it("exposes the v1 lookup surface", () => {
    expect(lookupBuiltin("sorted")).not.toBeNull();
  });
});
