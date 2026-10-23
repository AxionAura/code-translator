# Code Translator v0.1.0 — release report

Status: **published and verified on npm.** Release date: **2026-10-22** (UTC).
This report records post-publication verification; no package was republished by
this audit.

> **Historical release.** A `v0.1.1` patch release candidate (integer-precision
> warning fix, integral-float/hex-token fixes) is prepared locally but **not
> published**; see [release-notes-v0.1.1.md](release-notes-v0.1.1.md) and
> [publication-plan-v0.1.1.md](publication-plan-v0.1.1.md). The registry state
> below is the `0.1.0` state and was not changed by the patch preparation.

## Published packages

Registry checks used `npm view <pkg>@0.1.0` and `npm view <pkg> dist-tags`.
Every package has version `0.1.0`, a non-empty `dist.integrity`, `latest=0.1.0`,
and internal dependencies pinned to `@axion-ct/*@0.1.0`.

| Package | Version | Latest | Internal dependencies |
| --- | --- | --- | --- |
| `@axion-ct/core` | `0.1.0` | `0.1.0` | — |
| `@axion-ct/parser-py` | `0.1.0` | `0.1.0` | core |
| `@axion-ct/parser-js` | `0.1.0` | `0.1.0` | core |
| `@axion-ct/registry` | `0.1.0` | `0.1.0` | core |
| `@axion-ct/sandbox` | `0.1.0` | `0.1.0` | core |
| `@axion-ct/codegen-js` | `0.1.0` | `0.1.0` | core |
| `@axion-ct/codegen-py` | `0.1.0` | `0.1.0` | core |
| `@axion-ct/ai` | `0.1.0` | `0.1.0` | core |
| `@axion-ct/validator` | `0.1.0` | `0.1.0` | core, sandbox |
| `@axion-ct/repair` | `0.1.0` | `0.1.0` | core, ai |
| `@axion-ct/cli` | `0.1.0` | `0.1.0` | all ten above |

Publication timestamps from the registry: `@axion-ct/core` at
`2026-10-22T20:10:52.520Z`; `@axion-ct/cli` at `2026-10-22T20:33:22.289Z`.

## Repository verification

```bash
pnpm verify
```

Result: **exit 0** — 110 test files, **1091/1091 tests**, build, typecheck, lint,
formatting, and documentation links all passed.

## Published CLI smoke tests

- `npm exec --yes --package=@axion-ct/cli@0.1.0 -- ctrans --help` → **exit 0**;
  expected help and command list displayed.
- `npm exec --yes --package=@axion-ct/cli@0.1.0 -- ctrans --version` → **exit 0**;
  `0.1.0`.
- Clean temporary `npm install --ignore-scripts @axion-ct/cli@0.1.0` → **exit 0**
  (149 packages installed).
- All ten importable `@axion-ct/*` packages resolved via ESM import.
- Installed `ctrans doctor --json` → **exit 0**; required and strict capabilities
  available on this host.
- All six translation directions ran successfully from the installed CLI:
  Python→TS, Python→JS, JS→TS, JS→Python, TS→JS, TS→Python. Outputs were checked
  for existence; translated code was not executed outside the sandbox.
- Sandboxed project run (`project-classes-fixtures`) → **claim level 5**;
  S1–S6 passed, S6 matched 6 outcomes, S7 skipped because no smoke harness was
  supplied.

## Residual registry artifact

The npm registry exposes a `0.0.0-stage` version alongside `0.1.0` for all eleven
packages. The `latest` dist-tag correctly points to `0.1.0`; normal installs use
`0.1.0`. The stage entries are npm staged-publication metadata, not a second
release. No unpublish/deprecate action was taken. If the maintainer wants the
stage entries removed or deprecated, that is a separate registry operation
requiring explicit authorization.

## Known limitations

The limitations in [release.md](release.md) remain: claim levels are not semantic
proof; strict validation requires an operator-provided toolchain image; gVisor,
live keychain retrieval, Windows CredMan, and a full containerized S4–S7 run were
not exercised in this environment; reverse test translation remains deferred.

## Post-release P0 correction (v0.1.1 prepared, not published)

The post-release audit found a silent number-mode integer-precision gap in the
published `v0.1.0` artifacts: constant expressions such as `2 ** 53 + 1` and
`2 ** 100` were emitted as JS numbers with no warning. An exact constant-integer
analysis and regression suite now exist in the repository, and all eleven packages
are prepared at `0.1.1`. The fix is **not part of the published `v0.1.0`
tarballs** and has not been published as `0.1.1`; see
[release-notes-v0.1.1.md](release-notes-v0.1.1.md) and
[publication-plan-v0.1.1.md](publication-plan-v0.1.1.md). No package was
republished and the `v0.1.0` tag was not moved.

## Release tag

The annotated tag `v0.1.0` is created at this report's commit after all checks
pass. Nothing was pushed; the repository has no configured remote.
