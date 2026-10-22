# V1 Final Acceptance Audit — v0.1.0

- **Audit date:** 2026-10-22
- **Baseline commit:** `3ab1cde` (`docs: record M11 implementation commit and verification evidence`); M11 implementation `78953ef`.
- **Working tree at audit start:** clean, branch `main`, no uncommitted changes.
- **Audit scope:** documentation consistency, independent verification of the reported release baseline, security/environment gaps, package/distribution integrity. No runtime code was changed and nothing was published.
- **Documentation correction commit:** `aa9eed4`.

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
| Package contents | `pnpm --filter @axion-ct/cli pack …`, `@axion-ct/parser-py` pack | **exit 0**; CLI tar has `dist/main.js` + compiled bin; parser-py has `python/bridge.py` |
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

## 9. Pre-release security gate addendum (2026-10-22)

**Finding (High): host filesystem exposure through the bwrap profile.** The sandbox
constructed bubblewrap with `--ro-bind / /`, which mounted the entire host root
read-only inside the namespace. Untrusted translated/source code could therefore
read the invoking user's home directory, SSH keys, dotfiles, credentials readable
by that user, unrelated project data, and most of `/etc`. Network and PID isolation
were enforced, but the profile contradicted the stated rule that host credentials
and unrelated host paths are never mounted. The flag appeared in the sandbox
section, but its host-wide read consequence was not disclosed or tested.

**Fix.** `packages/sandbox/src/bwrap-profile.ts` now constructs a least-privilege
allowlist: read-only runtime system trees (`/usr`, `/bin`, `/sbin`, `/lib`,
`/lib64`, `/lib32` where present), a minimal `/etc` subset (loader cache/config,
passwd/group/nsswitch, resolv.conf/hosts, localtime), `/dev`, a new `/proc`, a
writable tmpfs `/tmp`, the workspace (rw), declared toolchain mounts (ro), and the
executable's directory (ro, for e.g. an nvm node binary). The host root is never
bound. Broad sensitive roots (`/`, `/home`, `/root`, `/etc`, `/var`, `/tmp`) are
rejected as mount paths (`/`, `/home`, `/root`, `/etc`, `/var`, `/tmp`, `/proc`,
`/sys`, `/dev`, `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/lib32`). Toolchain
mounts must be read-only; the workspace is the only writable host path. The
capability probe uses the same allowlist and reports
`filesystemIsolation: "bwrap-allowlist"` or `"none"` independently of
`networkIsolation`.

**Regression evidence.** `packages/sandbox/test/sandbox.test.ts` creates a synthetic
sentinel file under `/var/tmp` (outside all declared mounts), runs Python inside the
sandbox, and asserts the read is denied and the sentinel value never appears on
stdout; it also asserts broad sensitive mounts and writable toolchain mounts are
rejected. The container argv builder independently rejects writable mounts. No real
secret store or personal file is read. The strict-mode refusal test uses a simulated
capability report, so it is deterministic on hosts with and without bwrap.

**Verification (2026-10-22).**
- `npx vitest run packages/sandbox/test/sandbox.test.ts packages/sandbox/test/container.test.ts --maxWorkers=2` → **exit 0, 31/31**, including a real `docker run` with local image `fedora:44`, the sentinel read denial, broad-root and writable-mount rejection, and the network-block probe.
- `npx vitest run packages/validator/test apps/cli/test/{project-run,project-repair,doctor-smoke,commands-m11,cli-m11,cli}.test.ts --maxWorkers=2` → **exit 0, 101/101**.
- `npx vitest run --maxWorkers=4` → **exit 0, 110 files, 1091/1091**; coverage run also **1091/1091**, floors held (validator 94.94%, sandbox 86.39%).
- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm docs:check` → **exit 0**.
- A default-parallel `pnpm verify` attempt on an earlier tree returned **exit 1** because ten unrelated tests hit their 5 s/30 s/120 s timeouts under host resource exhaustion (load average ~25, swap full). Every timed-out file passed when rerun, and the complete suite passed at four workers. After host load subsided, a default-parallel `pnpm verify` on the committed tree returned **exit 0** — build, typecheck, lint, format, **1091/1091 tests (110 files)**, and doc links.

**Documentation corrections.** README, `docs/security.md`, the security checklist
(T7/T12 + gate note), and `docs/release.md` now describe the enforced allowlist and
the policy-only fallback accurately; the acceptance audit records the finding.
`docs/architecture.md`, `docs/research.md`, and D-001 were reconciled to the actual
Node floor (`>=22.18`), and the duplicate Benchmarks row in `docs/testing.md` was
removed.

**Residual limitation.** Without bwrap, hardened subprocess mode has no enforced
filesystem or network boundary; `filesystemIsolation`/`networkIsolation` report
`none`/`policy-only`, S5/S6/S7 and Python S4 refuse to execute, and only the
parse-only TypeScript S4 path may proceed. The strict Docker/Podman driver was
already allowlist-based and is unchanged. No new environment claim is made: live
gVisor, live keychain, Windows CredMan, and a full S4–S7 strict toolchain image
remain unverified.

**Gate verdict: PASS WITH DOCUMENTED LIMITATIONS.** The verified High finding is
fixed and regression-tested; no execution, cleanup, timeout, or resource-limit
protection was relaxed, and no test was skipped or weakened. Implementation commit:
`7d56ebf`; documentation/state finalization follows in a separate commit. Nothing
was published, tagged, or uploaded, and no registry state changed.

## 10. V1 release readiness audit (2026-10-22)

**Scope.** Verified the reported Git state (`main` at `a93989b`, clean tree, the
three security commits present in order, no tags or remotes), package metadata and
tarballs, the documented release procedure, security claims, and a clean consumer.
No publishing, tagging, pushing, or registry mutation was performed.

**High finding: the packaged CLI was missing its runtime toolchain.** In a clean
`pnpm deploy` of `@axion-ct/cli`, `translate --to py`, `doctor`, and project S5
validation failed with `Cannot find module 'pyright/package.json'` or
`Cannot find module 'vitest/package.json'`. `pyright`, `vitest`, and `typescript`
were only root devDependencies; the published CLI dependency graph therefore did
not contain them. This is release-blocking because JS/TS→Python S2, `doctor`,
`validate`, and project S5/S6 are core V1 surfaces.

**Fix.** `@axion-ct/cli` now declares the pinned `pyright` 1.1.406,
`typescript ~6.0.3`, and `vitest` 5.0.3 runtime dependencies. The sandbox
toolchain resolver now prefers the pnpm virtual-store root (the node_modules that
owns `.pnpm`) instead of a package-local link, so mounted paths resolve inside the
sandbox. The packed CLI includes only `dist/` and `bin/ctrans-dist.mjs`; the
source-mode launchers are development-only. `tests/dist-entry.test.ts` pins the
runtime dependency declarations and the packaged file list. Commit `16aa56a`.

**Packaging evidence.** All eleven publishable tarballs contain `dist/` (plus
`python/bridge.py` for `@axion-ct/parser-py`), `LICENSE`, and the rewritten
`workspace:*` dependencies as `0.1.0`; the CLI bin is mode 0755. The root
`code-translator` package is `private: true` and is not a release artifact;
`pnpm -r pack` also produces a root tarball for local inspection, so only the
eleven named packages may be packed/published.

**Clean-consumer evidence (no network).**
- `pnpm --filter @axion-ct/cli deploy --prod --legacy /tmp/ctrans-deploy3` → **exit 0**.
- Deployed `node bin/ctrans-dist.mjs --version` → `0.1.0`.
- Deployed `doctor --json` → **exit 0** with required capabilities available.
- Deployed `translate sample.js --to py` → **exit 0**, claim 3 (S1/S2/S3 pass).
- Deployed `project <fixture> --to ts` → **exit 0**, claim 5 (S1–S6 pass, S7 skipped).
- The packed CLI tarball, extracted with the clean deploy's dependencies, reports
  `0.1.0` and translates JS→Python successfully.
- A fully offline `pnpm install` from the tarballs could not complete because the
  local pnpm store lacked `web-tree-sitter@0.27.1` (the repo lockfile pins
  `0.27.0`); this is an environment/store limitation, not a package defect. A
  network install was not attempted.

**Verification.** `pnpm verify` → **exit 0** (110 files, 1091/1091 tests, doc
links); `pnpm test:coverage -- --maxWorkers=4` → **exit 0** (1091/1091; floors
held: validator 94.94%, sandbox 86.39%; CLI 82.56%, no floor). The targeted
project/golden-repair suites pass after the toolchain resolver fix.

**External prerequisites (UNVERIFIED).** npm authentication, ownership of the
then-current `@ctrans` scope (subsequently migrated to `@axion-ct`), registry
availability/policy, 2FA, and the actual publish operation were not checked or
performed; they require network access and explicit authorization. Live gVisor,
live keychain retrieval, Windows CredMan, and a full strict toolchain image remain
unverified.

**Verdict: READY WITH DOCUMENTED LIMITATIONS.** The release-blocking packaging
defect is fixed and verified in a clean consumer; remaining publication steps are
external and require maintainer authorization.

## 11. npm scope migration (2026-10-22)

The `@ctrans` npm organization was unavailable, so the maintainer created
`@axion-ct`. All eleven package names, internal dependency declarations, imports,
source loader, TypeScript/Vitest aliases, lockfile entries, tests, and release
documentation were migrated to `@axion-ct/*`. Version `0.1.0` is unchanged and the
root `code-translator` package remains private. `@ctrans` was never published.

Verification after migration: `pnpm verify` **exit 0** (110 files, 1091/1091 tests,
doc links); all eleven packages pack successfully; packed manifests contain no
`workspace:` or old-scope specifiers, and every internal dependency is
`@axion-ct/*@0.1.0`; a clean deploy passes `doctor`, JS/TS→Python, and a claim-5
project S5/S6 run. Migration commit: `3918946`. A packaging follow-up (`70d774a`)
restricts `@axion-ct/parser-py` to `python/bridge.py`, excluding a stale
`__pycache__` bytecode file found during tarball inspection. No publish, tag,
push, or registry mutation occurred.
