# V1 publication plan (`0.1.0`)

Status: **preflight prepared, not executed.** Nothing has been published, tagged,
or uploaded. Publication requires explicit maintainer authorization and npm
credentials with publish rights to the `@ctrans` scope.

Prepared from `main` at `008769d` (clean working tree, no tags, no remotes) on
2026-10-22.

## 1. Release set

Eleven publishable packages, all `0.1.0`, MIT, `engines.node >= 22.18`:

| Package | Internal dependencies | External runtime dependencies | Packed content |
| --- | --- | --- | --- |
| `@ctrans/core` | — | — | `dist/` |
| `@ctrans/parser-py` | core | `tree-sitter-python`, `web-tree-sitter` | `dist/`, `python/bridge.py` |
| `@ctrans/parser-js` | core | `@babel/parser`, `oxc-parser`, `typescript` | `dist/` |
| `@ctrans/registry` | core | — | `dist/` |
| `@ctrans/sandbox` | core | — | `dist/` |
| `@ctrans/codegen-js` | core | `prettier` | `dist/` |
| `@ctrans/codegen-py` | core | `@astral-sh/ruff-wasm-nodejs` | `dist/` |
| `@ctrans/ai` | core | `secretlint` packages | `dist/` |
| `@ctrans/validator` | core, sandbox | — | `dist/` |
| `@ctrans/repair` | core, ai | — | `dist/` |
| `@ctrans/cli` | all ten above | `pyright`, `typescript`, `vitest` | `dist/`, compiled `bin/ctrans-dist.mjs` |

The root package `code-translator` is `private: true` and is **not** a release
artifact. Do not use `pnpm -r pack` as a publication step: it also produces a
local tarball of the private root. Pack only the eleven named packages.

## 2. Preflight results (2026-10-22)

| Check | Result |
| --- | --- |
| Git state | `main` at `008769d`; clean tree; no tags or remotes |
| Lockfile | `pnpm install --frozen-lockfile --offline --ignore-scripts` → **exit 0** |
| Full verification | `pnpm verify` → **exit 0**; 110 files, 1091/1091 tests; doc links OK |
| Package packing | All eleven `pnpm --filter <pkg> pack` commands → **exit 0** |
| Tarball metadata | Every tarball has `package.json`, `LICENSE`, `dist/`; `parser-py` also has `python/bridge.py`; no `workspace:` specs remain |
| CLI tarball | Contains only `dist/`, `bin/ctrans-dist.mjs` (mode 0755), `package.json`, `LICENSE`; source-mode launchers excluded |
| Registry URL | `https://registry.npmjs.org/` |
| Registry reachability | `npm ping` → **exit 0** |
| npm authentication | `npm whoami` → **exit 1, `ENEEDAUTH`** — this machine is not logged in |
| Scope ownership / publish permission | **UNVERIFIED** — requires authenticated access to the `@ctrans` scope |
| Package names | All eleven `npm view <pkg> version` calls returned **404**; they are not publicly visible at check time. A 404 does not prove scope ownership. |
| Publish-time 2FA/OTP | **UNVERIFIED** — requires authenticated account access |

The public registry was checked read-only. No credentials were read, printed,
stored, or modified.

## 3. Preconditions before the first publish

All must be true; otherwise stop.

1. Maintainer has authenticated npm as an account with publish rights to
   `@ctrans`, and has the required 2FA/OTP mechanism ready.
2. Scope ownership and publish permission have been confirmed. The package names
   are rechecked immediately before publishing.
3. The working tree is clean at an approved commit, and `pnpm verify` is green at
   that exact commit.
4. The eleven tarballs were rebuilt from that commit and inspected; no source or
   metadata changes are made between packing and publishing.
5. The maintainer has approved the version, package set, and documented
   limitations.
6. No release tag exists. Do not create one until publication and the post-publish
   smoke test succeed.

## 4. Publish order

Publish one package at a time, in this order. Stop immediately on any failure.
The order ensures every `@ctrans/*` dependency is already available.

1. `@ctrans/core`
2. `@ctrans/parser-py`, `@ctrans/parser-js`, `@ctrans/registry`, `@ctrans/sandbox`
3. `@ctrans/codegen-js`, `@ctrans/codegen-py`, `@ctrans/ai`
4. `@ctrans/validator`, `@ctrans/repair`
5. `@ctrans/cli`

The command form for each package is:

```bash
pnpm --filter <package-name> publish \
  --access public \
  --tag latest \
  --no-git-checks \
  --ignore-scripts
```

`--no-git-checks` is required because this repository has no remote and its branch
is `main`, not pnpm's default publish branch. It does not create a tag.
`--ignore-scripts` avoids lifecycle scripts; the packages are already built.
If npm prompts for an OTP, enter it interactively; never put an OTP or token in a
command line, shell history, file, or log.

Do not use `pnpm -r publish` for this release: explicit per-package commands make
the dependency order and failure stop point unambiguous.

## 5. Per-package verification

After each publish, wait for registry propagation and verify the package before
continuing:

```bash
npm view <package-name>@0.1.0 version dist.integrity dependencies --json
```

Assert:

- `version` is `0.1.0`;
- `dist.integrity` is present;
- every `@ctrans/*` dependency is `0.1.0` (never `workspace:*`);
- the package is visible at the intended `latest` tag.

If verification has not propagated after a short bounded poll, stop and
investigate before publishing dependents. Do not republish `0.1.0`; npm versions
are immutable.

## 6. Post-publish smoke (network required; not executed here)

After all eleven packages are verified, install the public CLI in a fresh
temporary project:

```bash
tmpdir="$(mktemp -d)"
cd "$tmpdir"
npm init -y
npm install @ctrans/cli@0.1.0
./node_modules/.bin/ctrans --version
./node_modules/.bin/ctrans doctor --json
```

Then run at least one translation per direction that the host supports. Python
execution and sandboxed validation depend on the operator environment
(`python3`, `bwrap`, optional Docker image).

## 7. Abort and rollback policy

- Stop at the first failed publish or verification. Do not continue with
  dependents.
- Never delete or mutate an already-published version to "retry" it. Prepare a new
  patch version instead.
- npm unpublish/deprecate actions are a maintainer decision and are subject to
  registry policy; they are not part of this plan.
- Do not create a git tag until every package and the post-publish smoke pass.
- If publication is aborted after some packages are public, record exactly which
  versions and dist-tags exist before deciding on a corrective release.

## 8. Authorization boundary

This document is a plan only. Executing any publish, dist-tag, unpublish,
deprecation, tag, push, or GitHub release operation requires explicit maintainer
authorization. The preflight checks above did not publish or mutate registry
state.
