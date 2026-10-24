# Code Translator v0.1.1 — release notes (historical preparation record)

> **Published release.** v0.1.1 was published and verified on npm on
> **2026-10-23**; see [release-report-v0.1.1.md](release-report-v0.1.1.md). This
> file is retained as the preparation record of what the patch contains. The
> "not published" statements below describe the moment of preparation and are
> superseded by the release report.

Status at preparation time: candidate ready locally, not yet published. All
eleven `@axion-ct/*` packages at `0.1.1` in the working tree, no registry state
changed, no `v0.1.1` git tag, npm `latest` still `0.1.0`.

Release date prepared: **2026-10-23**. Previous release:
[v0.1.0](release-report-v0.1.0.md) (published 2026-10-22).

## Changes since v0.1.0

### Constant integer precision is no longer silently wrong

Default `intMode=number` previously emitted constant expressions such as
`2 ** 53 + 1` and `2 ** 100` as ordinary JavaScript numbers with no warning,
deterministic ledger entries, and an unchanged claim. The emitted value could be
numerically wrong while the report implied validated equivalence.

The fix evaluates constant integer `+`, `-`, `*`, `**`, `//`, `%`, and unary
`+`/`-` exactly with BigInt during analysis. If the final result or any
intermediate value cannot be represented exactly by float64, the operation is
classified `semantic` and emits `CTW-NUM-INT-ARBITRARY-PRECISION`. Safe boundary
expressions such as `2 ** 53 - 1` remain deterministic and warning-free; a safe
enclosing result suppresses a boundary-subexpression warning. `intMode=bigint`
remains exact and warning-free.

### Integral float and integer-base tokens are distinguished

The Python bridge represents integral float literals as JSON numbers, so the
lowering layer now consults the source NUMBER tokens:

- integral float literals (`2.0`, `2e3`, `1j`) stay JavaScript numbers in
  `intMode=bigint` and are inferred as float values;
- integer-base literals containing `e` (`0x1e2`) remain integers and do not
  trigger a false precision warning.

### Bounded analysis

The constant evaluator caps decimal literal length, exponent magnitude, and
materialized bit size, so pathological constants cannot cause unbounded BigInt
work. Larger or indirect expressions keep the existing honest
semantic/annotation policy rather than guessing.

No other translation behavior, dependency, or public API changes are included in
this patch. Internal dependencies remain `workspace:*` in the repository and are
rewritten by pnpm to `0.1.1` in the packed manifests.

## Remaining limitations (explicit)

- **`0 ** -1` in number mode is still wrong:** Python raises
  `ZeroDivisionError`; the generated number-mode expression evaluates to
  `Infinity`. This is a pre-existing exceptional-exponentiation gap, not fixed by
  this patch. Use `intMode=bigint` where exact integer semantics are required.
- **JS/TS → Python `console.log` is not mapped.** A broader smoke sample that used
  `console.log(...)` emitted a bare `console` reference in the Python target;
  pyright S2 failed (`"console" is not defined`) and the file remained at claim 1.
  This is a pre-existing mapping gap, not introduced by this patch, and such a
  result is not presented as a validated Python translation. The documented
  minimal six-direction smoke does not use this call.
- **Indirect/runtime integer values are not value-tracked.** The precision
  warning covers statically constant integer expressions. Values flowing through
  variables, parameters, containers, or call results remain subject to the
  existing annotation/semantic-helper policy.
- **A claim level is a validation claim, not a semantic-equivalence proof.** A
  file can still carry a numeric claim while containing warned semantic
  adaptations; read the ledger and warnings together.
- **The broader V1 limitations remain unchanged.** `docs/language-support.md` §4
  and `PROJECT_STATE.md` §15 remain the authoritative list, including
  unsupported constructs, test-translation coverage, float formatting, dict
  ordering, sandbox requirements, and AI scope.
- **`0.1.0` is immutable on npm.** This patch fixes the repository and packed
  `0.1.1` artifacts; it does not and cannot repair already-published `0.1.0`
  tarballs.

## Verification evidence

The release candidate is verified from this working tree with:

```bash
pnpm install --frozen-lockfile --offline --ignore-scripts
pnpm verify
pnpm test:coverage
pnpm build
```

Recorded result: **113 test files, 1116/1116 tests passing, 0 failing, 0
skipped**; `pnpm verify` exit 0 and documentation links pass. Coverage exit 0,
including `@axion-ct/codegen-js` at **90.86% lines** and `@axion-ct/sandbox` at
**86.39% lines**. The targeted sandbox/container and project-golden run passed
**35/35 tests**, including a real Docker `fedora:44` strict run.

All eleven packed tarballs carry version `0.1.1`, resolve every internal
dependency to `@axion-ct/*@0.1.1`, include the MIT license, and contain no
`workspace:`, old `@ctrans/` scope, TypeScript source, or `__pycache__` entries.
The CLI bin is mode `0755`. Installing all eleven tarballs together into a fresh
temporary project succeeded; the installed CLI reported `0.1.1`, `doctor` exited
0 with node/python/bwrap/pyright/tsc/vitest available, all six translation
directions exited 0 on minimal supported samples (claim 3 for typed targets,
claim 1 for JavaScript output with S2 skipped by design), and the
`project-barrels-multi-module` fixture reached claim 5 with five S5 outcomes and
five S6 matches.

Smoke scope is explicit: a broader JavaScript sample that called `console.log`
reported a Python S2 failure and claim 1 because `console` has no Python mapping
in the generated module. That is a pre-existing mapping limitation, not a
packaging regression introduced by this patch, and it is not presented as a
validated translation. `0 ** -1` has a separate known failure described above.

These are local verification results. They are not a claim that npm has accepted
or served the patch. Read-only registry checks after packing returned **404 for
all eleven `@axion-ct/*@0.1.1` requests**, and `@axion-ct/core` still reports
`latest=0.1.0`.

## Release set

All eleven publishable packages move to `0.1.1`, in dependency order:

1. `@axion-ct/core`
2. `@axion-ct/parser-py`, `@axion-ct/parser-js`, `@axion-ct/registry`,
   `@axion-ct/sandbox`
3. `@axion-ct/codegen-js`, `@axion-ct/codegen-py`, `@axion-ct/ai`
4. `@axion-ct/validator`, `@axion-ct/repair`
5. `@axion-ct/cli`

The private root package is not a release artifact. Exact publication commands,
per-package checks, abort rules, and the authorization boundary are in
[publication-plan-v0.1.1.md](publication-plan-v0.1.1.md).
