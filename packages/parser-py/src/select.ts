// Fallback selection policy (roadmap M1, D-003): the CPython bridge is primary; the
// tree-sitter front-end is used only when explicitly allowed and the bridge cannot
// start (unavailable interpreter) or reports an unsupported runtime. The selected
// parser is always visible in the result (parser.id / parser.fidelity), so this is a
// recorded downgrade, never a silent switch.
import type { PythonParser } from "@ctrans/core";
import { PythonBridgeParser, type PythonBridgeParserOptions } from "./client.js";
import { PY_BRIDGE_UNAVAILABLE, PY_RUNTIME_UNSUPPORTED } from "./errors.js";
import { createTreeSitterPythonParser } from "./fallback.js";

export interface PythonParserSelection extends PythonBridgeParserOptions {
  // Default false: an unusable bridge is a hard error unless the caller opts in.
  readonly allowFallback?: boolean;
}

export async function createPythonParser(
  options: PythonParserSelection = {},
): Promise<PythonParser> {
  const { allowFallback = false, ...bridgeOptions } = options;
  try {
    return await PythonBridgeParser.create(bridgeOptions);
  } catch (error) {
    const eligible =
      error instanceof Error &&
      "code" in error &&
      (error.code === PY_BRIDGE_UNAVAILABLE || error.code === PY_RUNTIME_UNSUPPORTED);
    if (!allowFallback || !eligible) {
      throw error;
    }
    return createTreeSitterPythonParser();
  }
}
