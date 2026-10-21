// Secret-scanning hard gate (docs/security.md §4, ADR D-025): every outgoing
// payload is scanned with the embedded secretlint preset BEFORE the model is
// called. Fail-closed: findings, scanner errors, or an empty rule set BLOCK the
// request. Findings record rule ids and locations only — never secret values.
import { lintSource } from "@secretlint/core";
import { rules as presetRules } from "@secretlint/secretlint-rule-preset-recommend";

export interface SecretFinding {
  readonly ruleId: string;
  readonly line: number;
  readonly column: number;
}

export type GateOutcome =
  | { readonly blocked: false; readonly findings: readonly SecretFinding[] }
  | {
      readonly blocked: true;
      readonly reason: string;
      readonly findings: readonly SecretFinding[];
    };

export interface SecretGate {
  scan(payload: string): Promise<GateOutcome>;
}

interface LintMessage {
  readonly ruleId?: string;
  readonly line?: number;
  readonly column?: number;
}

// The wrapped rule descriptors `lintSource` expects (the preset exports bare
// rule modules; the core registers them by id).
const configuredRules = presetRules.map((rule) => ({ id: rule.meta.id, rule }));

export class SecretlintGate implements SecretGate {
  async scan(payload: string): Promise<GateOutcome> {
    if (configuredRules.length === 0) {
      // Fail closed: no rules means no meaningful scan.
      return { blocked: true, reason: "secret scanner has no rules configured", findings: [] };
    }
    try {
      const result = await lintSource({
        source: {
          filePath: "ctrans-payload.txt",
          content: payload,
          ext: ".txt",
          contentType: "text",
        },
        options: { config: { rules: configuredRules }, noPhysicFilePath: true },
      });
      const messages = result.messages as readonly LintMessage[];
      if (messages.length > 0) {
        const findings = messages.map((message) => ({
          ruleId: message.ruleId ?? "unknown-rule",
          line: message.line ?? 0,
          column: message.column ?? 0,
        }));
        return {
          blocked: true,
          reason: `${String(findings.length)} potential secret(s) detected before sending`,
          findings,
        };
      }
      return { blocked: false, findings: [] };
    } catch (error) {
      // Scanner failure is indeterminate — block, never bypass.
      return {
        blocked: true,
        reason: `secret scan failed (${error instanceof Error ? error.message.slice(0, 200) : String(error)})`,
        findings: [],
      };
    }
  }
}
