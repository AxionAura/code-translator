// Responsibility (docs/architecture.md §3): Python → JavaScript/TypeScript lowering,
// emission and formatting (M4). Consumes core contracts; parser implementations stay
// out of this package (layer rules, D-017).
export const packageName = "@ctrans/codegen-js";

export { PyToJsTranslator, createPyToJsTranslator, relativeImportSpecifier } from "./translator.js";
export { RUNTIME_HELPERS } from "./helpers.js";
export {
  CTW_CLASS_ATTR_STATIC,
  CTW_DICT_KEY_COERCION,
  CTW_EXTERNAL_UNMAPPED,
  CTW_GENERATOR_EAGER,
  CTW_KWARGS,
  CTW_METHOD_UNMAPPED,
  CTW_MUTABLE_DEFAULT,
  CTW_NUM_BITWISE,
  CTW_NUM_PRECISION,
  CTW_TUPLE_ARRAY,
  LoweringContext,
  ScopeStack,
} from "./context.js";
export { Emitter, tsTypeFromAnnotation } from "./lower.js";
