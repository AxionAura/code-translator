# Release preparation (v0.1.0)

Status: **release-ready for a local/distribution review; nothing has been
published.** All packages are version `0.1.0` under the MIT license. The release is
a monorepo of eleven packages; the CLI is `@ctrans/cli` with the `ctrans` bin.

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
pnpm --filter @ctrans/cli pack --pack-destination /tmp/ctrans-pack
```

Every package contains only `dist/` (plus `python/bridge.py` for
`@ctrans/parser-py`, which is required at runtime). Package metadata includes
`license: MIT`, `engines.node >= 22.18`, and a bin that points at the compiled
entry. Workspace dependency ranges (`workspace:*`) are rewritten by pnpm on pack.

## Publishing order (only with explicit authorization)

The CLI depends on all implementation packages, so publish dependencies first:

1. `@ctrans/core`
2. `@ctrans/parser-py`, `@ctrans/parser-js`, `@ctrans/registry`, `@ctrans/sandbox`
3. `@ctrans/codegen-js`, `@ctrans/codegen-py`, `@ctrans/ai`
4. `@ctrans/validator`, `@ctrans/repair`
5. `@ctrans/cli`

`pnpm -r publish --access public` may work with a logged-in npm account, but the
exact registry/auth policy is an operator decision. **Do not publish, upload, or
tag a release without explicit authorization.** No release has been published by
this milestone.

## Runtime requirements

- Node.js ≥ 22.18.
- `python3` ≥ 3.12 for the Python front-end and S6/source execution.
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
deferred.
