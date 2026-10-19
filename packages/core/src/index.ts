// Responsibility (docs/architecture.md §3): semantic layer, module graph, transformation
// ledger, and pipeline orchestration. Cross-package types and engine interfaces live here
// (AGENTS.md §3, ADR D-017); implementation packages depend on these, never the reverse.
export const packageName = "@ctrans/core";

export { CTransError } from "./errors.js";
export { analyzeModule } from "./semantic.js";
export { buildModuleGraph, normalizeModuleId } from "./module-graph.js";
export type {
  GraphImport,
  GraphImportStatus,
  GraphModuleInput,
  ModuleGraphModel,
  ModuleGraphNode,
} from "./module-graph.js";
export { extractModuleContract, pythonExportNames } from "./module-contract.js";
export type { ContractEntry, ContractEntryKind, ModuleContract } from "./module-contract.js";
export {
  DECISION_KINDS,
  serializeLedger,
  validateLedgerEntries,
  validateLedgerEntry,
  LedgerValidationError,
} from "./ledger.js";
export type { DecisionKind, LedgerEntry, LedgerEscalation } from "./ledger.js";
export { validateTranslationReport, ReportValidationError } from "./report.js";
export type {
  ClaimLevel,
  FileTranslationStatus,
  ReportFileEntry,
  ReportValidationStage,
  StageStatus,
  TranslationReport,
} from "./report.js";
export { computeClaimLevel, runPipeline, targetModulePath } from "./pipeline.js";
export type { ValidationStageName } from "./pipeline.js";
export { validateDependencies, type S3Finding, type S3Input } from "./s3-dependencies.js";
export {
  DEFAULT_INTAKE_CAPS,
  discoverProjectFiles,
  isTestModulePath,
  readProjectFile,
  targetPathForModule,
  type DiscoveredFile,
  type ParsedProjectUnit,
  type ProjectDiscovery,
  type ProjectIntakeCaps,
  type ProjectIntakeResult,
  type ProjectTestModule,
} from "./project.js";
export {
  NO_REGISTRY,
  type BuiltinMappingView,
  type MethodEmit,
  type MethodMappingView,
  type ModuleMappingView,
  type RegistryFidelity,
  type RegistryLookup,
} from "./registry-lookup.js";
export {
  ASYNC_BOUNDARY_MODULE,
  collectFunctionCalls,
  collectImportedFunctions,
  propagateAsync,
  type AsyncRequirements,
} from "./async-propagation.js";
export type {
  AnalyzedUnit,
  DependencyValidator,
  EmittedFile,
  IntMode,
  PipelineInput,
  PipelineResult,
  StageResult,
  SyntaxValidator,
  TargetLanguage,
  TranslateOptions,
  UnitTranslationContext,
  TypeValidator,
  UnitEmission,
  UnitTranslator,
} from "./pipeline.js";
export { UNKNOWN, annotate, unknownType } from "./common-type.js";
export type { AnnotatedType, CommonType, TypeConfidence, TypeOrigin } from "./common-type.js";
export type {
  DeclarationNamespace,
  ReferenceContext,
  ScopeKind,
  ScopeNode,
  SemanticDiagnostic,
  SemanticModel,
  SemanticSeverity,
  SymbolEntry,
  SymbolKind,
  SymbolReference,
} from "./semantic.js";
export { byteColumn, lineIndexOf, scanSourceLines } from "./source-lines.js";
export type { SourceLines } from "./source-lines.js";
export type { AstNode, AstValue, TaggedValue } from "./ast-node.js";
export type { Diagnostic, DiagnosticSeverity } from "./diagnostic.js";
export type {
  ExportKind,
  ImportKind,
  ModuleExport,
  ModuleImport,
  ModuleInfo,
} from "./module-info.js";
export type { ParseResult, ParserId, ParserInfo, SourceLanguage } from "./parse-result.js";
export type {
  JsParseOptions,
  JsParser,
  ParserDescription,
  PythonParseOptions,
  PythonParser,
} from "./parser.js";
export type { ScopeInfo, SymbolFlag, SymbolInfo } from "./scope.js";
export type { SourcePosition, SourceSpan } from "./source-span.js";
export type { TokenInfo } from "./token.js";
export type {
  TsDiagnostic,
  TsExportKind,
  TsExportSummary,
  TsModuleSummary,
  TsModuleSummaryQuery,
  TsOracleSourceFile,
  TsSemanticOracle,
  TsSymbolSummary,
  TsTypeAtQuery,
  TsTypeSummary,
} from "./ts-oracle.js";
