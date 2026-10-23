# Release preparation (v0.1.1)

Status: **v0.1.1 prepared locally; not published.** All eleven `@axion-ct/*`
packages are at `0.1.1` in this working tree. No package has been published, no
`v0.1.1` tag has been created, and no registry state has been changed; `v0.1.0`
remains the published version. See
[release-notes-v0.1.1.md](release-notes-v0.1.1.md) and
[publication-plan-v0.1.1.md](publication-plan-v0.1.1.md).

The previously published release is **v0.1.0 (2026-10-22)**: all eleven packages
are live at `0.1.0` under the MIT license; see
[release-report-v0.1.0.md](release-report-v0.1.0.md). The release is a monorepo of
eleven packages; the CLI is `@axion-ct/cli` with the `ctrans` bin.

## Build

```bash
pnpm install
pnpm build          # emits dist/ for every package (tsc, no bundler)
```

`pnpm build` compiles `src/` to `dist/` per package (`tsconfig.build.json`). Package
`exports` point at `dist/index.js`; `apps/cli/bin/ctrans-dist.mjs` runs the compiled
CLI. Development/tests keep using TypeScript sources (`apps/cli/bin/ctrans.mjs` and
the Vitest workspace aliases).

## Verify before release

```bash
pnpm build
pnpm verify                              # build + typecheck + lint + format + tests + docs
pnpm test:coverage
pnpm benchmark --suite micro --iterations 3
pnpm benchmark:mini                      # expensive, explicit/nightly
pnpm benchmark:perf
node apps/cli/bin/ctrans-dist.mjs doctor
```

`tests/dist-entry.test.ts` executes the compiled bin. `tests/perf-smoke.test.ts`
runs the 500-file synthetic suite within a 120 s CI budget (measured ~0.4 s for the
translation phase on the development host; machine-local).

## Packaging

```bash
pnpm --filter @axion-ct/cli pack --pack-destination /tmp/ctrans-pack
```

Every publishable package contains only `dist/` (plus `python/bridge.py` for
`@axion-ct/parser-py`, which is required at runtime). `@axion-ct/cli` contains `dist/`
and only its compiled bin (`bin/ctrans-dist.mjs`); the source-mode launchers are
development-only and are excluded from the tarball. Package metadata includes
`license: MIT`, `engines.node >= 22.18`, and a bin that points at the compiled
entry. Workspace dependency ranges (`workspace:*`) are rewritten to `0.1.1` by
pnpm on pack. The CLI declares `pyright`, `typescript`, and `vitest` as runtime
dependencies because S2/S5, `doctor`, and project validation resolve them from the
installed CLI package.

The workspace root (`code-translator`) is `private: true` and is **not** a release
artifact; pack or publish only the eleven workspace packages below. `pnpm -r pack`
also packs the private root for local inspection and must not be used as a
publication command.

## Release order (v0.1.1, prepared)

The CLI depends on all implementation packages, so publication must proceed
dependency-first. The published `v0.1.0` release used the same order:

1. `@axion-ct/core`
2. `@axion-ct/parser-py`, `@axion-ct/parser-js`, `@axion-ct/registry`, `@axion-ct/sandbox`
3. `@axion-ct/codegen-js`, `@axion-ct/codegen-py`, `@axion-ct/ai`
4. `@axion-ct/validator`, `@axion-ct/repair`
5. `@axion-ct/cli`

Use the explicit per-package commands and per-package verification steps in
[publication-plan-v0.1.1.md](publication-plan-v0.1.1.md). Do **not** use
`pnpm -r publish`: explicit commands make the dependency order and stop point
unambiguous, and avoid recursive operations that include the private root.

`v0.1.0` is published and immutable. Do not republish it. `v0.1.1` is prepared
locally and requires a clean approved commit, explicit authorization, and the
preflight, per-package verification, and post-publish checks in the v0.1.1 plan.
Do not create the `v0.1.1` tag until those checks pass.

## Runtime requirements

- Node.js ≥ 22.18.
- `python3` ≥ 3.12 for the Python front-end and S6/source execution.
- The pinned `pyright`, `typescript`, and `vitest` toolchain is installed as an
  `@axion-ct/cli` runtime dependency; no separate installation is required.
- `bwrap` for default network-isolated execution with a least-privilege filesystem
  allowlist (otherwise S5/S6/S7 and Python S4 are skipped/refused, not faked);
  `prlimit` is optional; Docker/Podman plus an operator-provided image are required
  only for `--strict`; gVisor is optional and only used when detected.
- `CTRANS_AI_KEY`, an OS keychain entry, or a 0600 key file for AI features. AI is
  off by default.

## Known limitations at release

See [validation.md](validation.md), [security-review-checklist.md](security-review-checklist.md),
and [PROJECT_STATE.md](../PROJECT_STATE.md) §15. Highlights: claim-level acceptance
is not semantic proof; strict mode needs a toolchain image and was not exercised
end-to-end in a container here; Windows keychain retrieval is not implemented; disk
caches are opt-in and unencrypted; reverse test translation (vitest→pytest) is
deferred; number-mode `0 ** -1` still yields `Infinity` instead of Python's
`ZeroDivisionError`; and runtime/indirect integer values are not value-tracked for
precision warnings.

**v0.1.1 patch correction (prepared locally, not published):** the published
`v0.1.0` artifacts have a silent number-mode integer-precision warning gap for
constant exponentiation and arithmetic. The repository and packed `0.1.1`
artifacts contain the exact-constant analysis and regression suite; they do not
repair the immutable `0.1.0` tarballs. The patch also corrects integral-float and
hex-token handling and discloses the remaining number-mode `0 ** -1` gap. See
[release-notes-v0.1.1.md](release-notes-v0.1.1.md),
[release-report-v0.1.0.md](release-report-v0.1.0.md), and
[../research/post-release-product-audit.md](../research/post-release-product-audit.md).
