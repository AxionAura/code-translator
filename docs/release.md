# Release preparation (v0.1.1, historical) — superseded by the published v0.1.1 release

> **Historical preparation document.** The v0.1.1 release described here **was
> published and verified on npm (2026-10-23)**; see
> [release-report-v0.1.1.md](release-report-v0.1.1.md). This file is retained as
> audit evidence for how the candidate was prepared and is not the current
> release status. Current-status summaries live in [README.md](../README.md) and
> [PROJECT_STATE.md](../PROJECT_STATE.md).

Status at preparation time: candidate ready locally, not yet published; all
eleven `@axion-ct/*` packages at `0.1.1` in the working tree, no registry state
changed, `v0.1.0` the then-published version. The published release used the
exact commands below after explicit authorization.

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

`v0.1.0` and `v0.1.1` are published and immutable. Do not republish either. A
future release requires a clean approved commit, explicit authorization, and the
preflight, per-package verification, and post-publish checks in its plan. Do not
create the release tag until those checks pass.

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
deferred; runtime/indirect integer values are not value-tracked for precision
warnings (v0.1.2 discloses them with `CTW-NUM-INT-RUNTIME-UNCERTAIN`), and
number-mode `0 ** -1` now raises `ZeroDivisionError` via the v0.1.2 reliability
fixes in the working tree (the published `0.1.1` tarballs retain the old
behavior).

**v0.1.1 patch correction (published 2026-10-23):** the immutable `v0.1.0`
tarballs have a silent number-mode integer-precision warning gap for constant
exponentiation and arithmetic. The published `0.1.1` artifacts contain the
exact-constant analysis and regression suite; they do not repair `0.1.0`. The
patch also corrected integral-float and hex-token handling. The remaining
number-mode `0 ** -1` gap and runtime-integer precision uncertainty disclosed at
that release are addressed by the v0.1.2 reliability work recorded in
`PROJECT_STATE.md` §8/§19. See
[release-notes-v0.1.1.md](release-notes-v0.1.1.md),
[release-report-v0.1.0.md](release-report-v0.1.0.md), and
[../research/post-release-product-audit.md](../research/post-release-product-audit.md).
