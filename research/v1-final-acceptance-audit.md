# V1 Final Acceptance Audit — v0.1.0

- **Audit date:** 2026-10-22
- **Baseline commit:** `3ab1cde` (`docs: record M11 implementation commit and verification evidence`); M11 implementation `78953ef`.
- **Working tree at audit start:** clean, branch `main`, no uncommitted changes.
- **Audit scope:** documentation consistency, independent verification of the reported release baseline, security/environment gaps, package/distribution integrity. No runtime code was changed and nothing was published.
- **Documentation correction commit:** `TBD` (recorded by the follow-up state commit).

## 1. Recommendation

**ACCEPT WITH DOCUMENTED LIMITATIONS.**

The V1 scope — a CLI-first Python/JavaScript/TypeScript translator with six directions, an honest decision ledger, deterministic-first pipeline, opt-in AI, S1–S7 validation, claim ladder, sandboxing, and bounded repair — is implemented and passes the repository's full verification and release checks in this environment. The remaining gaps are environment-dependent verification and explicitly deferred post-V1 work, not correctness failures in the claimed V1 surface. They are enumerated in §6 and must remain visible in release notes.

## 2. Commands executed and results

All commands were run from the repository root at `3ab1cde` unless noted. Exit codes are actual.

| Check | Command | Result |
| --- | --- | --- |
| Full verification | `pnpm verify` | **exit 0**; 110 test files, **1087/1087 tests**; build, typecheck, lint, format, doc links all passed |
| Coverage | `pnpm test:coverage` | **exit 0**; 1087/1087; core 92.07%, validator 94.92%, repair 95.09%, ai 91.64%, codegen-js 90.68%, codegen-py 90.46%, parser-js 91.74%, parser-py 91.82%, registry 94.73%; sandbox 84.64%, CLI 82.67% (no floors) |
| Benchmark micro | `node apps/cli/bin/ctrans.mjs benchmark --suite micro --iterations 3 --json` | **exit 0**, suite `ok`; parse 27.2 ms, Py→TS 26.8 ms, Py→JS 15.6 ms |
| Benchmark corpus | `… --suite corpus --iterations 3 --json` | **exit 0**, **ok**; 17.5–26.1 ms for 3 files, S1 pass |
| Benchmark mini-projects | `… --suite mini-projects --iterations 3 --json` | **exit 0**, `ok`; all three claim 5, S5+S6 pass, 2/2/3 differential matches, 1.24–1.33 s |
| Benchmark perf (500 files) | `… --suite perf --iterations 3 --json` | **exit 0**, `ok`; 277.6 ms median, 500 emitted files, 2996 ledger entries |
| Nightly writer | `node scripts/benchmark-nightly.mjs perf` | **exit 0**; wrote the date-stamped result (the generated file was restored to its committed value after the check) |
| Strict container tests | `pnpm exec vitest run packages/sandbox/test/container.test.ts --reporter=verbose` | **exit 0**, 12/12; argv security, refusal, exit-125 classification, timeout cleanup, and a **real Docker run with `fedora:44`** |
| Dist entry | `node apps/cli/bin/ctrans-dist.mjs --version`, `check`, `translate` | **exit 0**; version `0.1.0`, translation emitted valid TS |
| Package contents | `pnpm --filter @ctrans/cli pack …`, `@ctrans/parser-py` pack | **exit 0**; CLI tar has `dist/main.js` + compiled bin; parser-py has `python/bridge.py` |
| Package metadata | script over root + 11 packages | `0.1.0`, MIT, non-private packages, dist exports/files; **OK** |
| Lockfile | `pnpm install --frozen-lockfile --offline` | **exit 0**, already up to date |
| Clean clone | `git clone`, `pnpm install`, `pnpm verify`, dist `--version` at `3ab1cde` | **exit 0**; 1087/1087, doc links OK, dist reports `0.1.0` |
| Environment probes | docker/podman/secret-tool/runsc/npm whoami | Docker 29.9.1 daemon and Podman 5.8.9 reachable; `secret-tool` installed; `runsc` absent; npm unauthenticated (`ENEEDAUTH`) |

The committed benchmark artifacts under `benchmarks/results/2026-10-22-*.json` report a previous run (perf 311.9 ms). The audit run above is a fresh independent observation; both are host-local timing samples, not performance claims.

## 3. Test and coverage assessment

- 1087 tests across 110 files pass; no skips or `.only`.
- Coverage floors from AGENTS.md §4 hold: core ≥85%, parser/codegen packages ≥90% lines. All named floor packages pass with margin.
- Sandbox and CLI have no mandated floor; their uncovered lines are capability/cleanup and CLI edge paths.
- The targeted suites exercised here cover the M11 changes (config, keys/cache, CLI commands/JSON/progress, benchmarks, dist) and the M9/M10 repair/validation invariants.
- The real container test was not a mock: it printed `executing real strict container run with docker image fedora:44`; the test also asserts refusal when a runtime/image/gVisor is unavailable.

## 4. Distribution and package verification

- `pnpm build` emits `dist/` for all 11 packages; the compiled CLI resolves package exports and the Python bridge asset.
- CLI tar: `dist/main.js`, `bin/ctrans-dist.mjs`, package metadata; parser-py tar includes `python/bridge.py`.
- Package metadata: version `0.1.0`, MIT, publishable packages (non-private), `files` whitelists, `engines.node >=22.18`, bin at the compiled entry.
- Clean clone at `3ab1cde` builds and tests successfully with a frozen/offline install.
- **Nothing has been published or tagged.** `npm whoami` is unauthenticated; registry policy/auth is unverified and publishing requires explicit authorization.

## 5. Documentation inconsistencies found and corrected

| Issue | Finding | Correction |
| --- | --- | --- |
| `PROJECT_STATE.md` §13 said benchmark results were unavailable | Stale: M11 recorded four suites and committed results | Replaced with the actual recorded methodology/results and their limits |
| `PROJECT_STATE.md` §15 said the compiled dist entry was deferred / no build emission | Stale: M11 builds dist and ships a compiled bin | Replaced with the actual source-entry + dist-entry description |
| Vitest version references | `PROJECT_STATE.md` mixed `5.0.5` for Vitest with the resolved `5.0.3` (`@vitest/coverage-v8` is 5.0.5) | Corrected to Vitest 5.0.3 and coverage-v8 5.0.5 everywhere |
| `docs/configuration.md` used an `example.invalid` `$schema` URL | Illustrative placeholder, but could imply a published schema | Removed from the example/table and added an explicit note that no schema is published; `$schema` if present is an ignored editor hint |
| `docs/testing.md` pointed ConstructMatrix at `tests/constructs/index.json`, registry tests at `packages/registry/tests`, E2E at `tests/e2e`, and corpus at `tests/corpus` | These paths/artifacts do not exist | Pointed at the real matrix data/tests, `packages/registry/test`, `apps/cli/test` + `tests/*.test.ts`, and `benchmarks/corpus|projects`; noted the corpus benchmark's actual scope and future property-check work |
| Documentation claimed every construct matrix entry is generator-enforced via an index | No such generator/index exists | Rewrote to describe the real data-driven matrices and review/test coverage |
| Several design docs still said `Status: approved blueprint` (architecture even said “M0 not started”) | Stale status headers contradicted the implemented V1 | Updated architecture/testing/translation-pipeline/language-support/roadmap statuses; dependency-mapping now says registry v1 implemented with broader scope future |

No historical milestone records were rewritten; the stale statements were current-status or path references, not historical claims. No runtime code was changed for documentation consistency. One test-only robustness change was made during the audit: the `doctor --json` probe test timeout was raised from 5 s to 30 s after a full-suite run timed out while parallel environment probes were running. The assertions and behavior are unchanged; the probe itself is not weakened or mocked.

## 6. Security and environment verification matrix

| Area | Status | Evidence / limitation | V1 release impact |
| --- | --- | --- | --- |
| Strict Docker/Podman behavior, fail-closed | **Verified implementation + tests** | argv flags, daemon-vs-binary detection, refusal paths, exit-125 classification, timeout cleanup; real Docker `fedora:44` run | Supports V1 strict mode |
| Network isolation / read-only / caps / mounts / cleanup | **Verified implementation + tests** | `buildContainerArgv` tests; workspace rw only, toolchain ro, no host env/socket, `--pull=never`; bwrap network-block test | Supports V1 |
| gVisor | **Unverified environment** | `runsc` absent; detection/refusal unit-tested; no live run | Not required by V1; documented optional |
| Live OS keychain retrieval | **Unverified environment** | `secret-tool` exists but no `ctrans-ai` credential; env + 0600 file + all rejection paths tested | Not blocking; env/file paths work and are tested |
| Windows Credential Manager | **Intentionally unimplemented** | Documented; 0600 file fallback | Not blocking Linux/macOS V1; documented Windows caveat |
| Disk cache permissions/symlinks/atomicity | **Verified tests** | 0700/0600, symlink/corruption rejection, atomic temp+rename; unencrypted by design and opt-in | Not blocking; documented privacy trade-off |
| Full S4–S7 inside a Node+Python toolchain container | **Unverified environment** | No suitable image; container driver and refusal tested; host/bwrap S4–S7 verified | Not blocking default mode; documented strict-mode caveat |
| Publication authentication/registry policy | **Unverified** | `npm whoami` → `ENEEDAUTH`; no publish attempted | Blocks publishing only; explicit authorization required |

A documented limitation does not by itself fail V1. The default (non-strict, bwrap-capable) validation path and the compiled distribution are verified; strict-container and keychain guarantees remain operator-environment dependent and are disclosed.

## 7. Residual limitations with release impact

- Claim levels are evidence-based, not semantic proofs (S5/S6 are bounded behavioral evidence).
- `translate`/`check` remain S1–S3 surfaces; `validate` cannot reconstruct S3/S6 without source context.
- Benchmark coverage is correctness + claim + timing on a small original corpus, not a broad real-world benchmark; timings are host-local.
- Disk cache is opt-in and unencrypted; keychain retrieval and Windows CredMan are not fully verified/implemented.
- Strict mode requires an operator-provided toolchain image; a full containerized S4–S7 run was not possible here.
- Reverse test translation, broader corpus trends, and package publication are post-V1/authorized operations.

## 8. Final status

- **Post-correction verification:** `pnpm verify` **exit 0** — 110 files, 1087/1087 tests, doc links OK (after the documentation and test-timeout corrections).
- **Working tree after corrections:** clean after the documentation commit (see follow-up hash).
- **V1 verdict:** **ACCEPT WITH DOCUMENTED LIMITATIONS**.
- **No release published, no tag created, no registry action taken.**
