# V1 publication plan (`0.1.0`)

Status: **publication authorized and attempted; blocked at the first package by
npm EOTP. 0 of 11 packages published; no registry mutation.** The authenticated
npm account is `code-translator`, owner of `@axion-ct`, with 2FA enabled in
`auth-and-writes` mode. Recovery requires a human-operated interactive terminal;
this automation session has no TTY. No tag or push was performed.

## Publication attempt (2026-10-22)

- Preflight at `main`/`d396f61`: clean tree; `pnpm verify` exit 0 (110 files,
  1091/1091 tests); all eleven tarballs rebuilt and inspected.
- First command attempted: `pnpm --filter @axion-ct/core publish --access public
  --tag latest --no-git-checks --ignore-scripts`.
- Result: **exit 1, `EOTP`** — npm requires a one-time password for this publish.
  The CLI was not run in an interactive OTP-capable session, and no OTP was
  available or exposed. The attempt stopped before the registry accepted the
  package.
- Immediate registry check: all eleven `@axion-ct/*` names still return **404**.
- **Published packages: none (0/11).**
- Resume point: `@axion-ct/core`, only after a publish-capable session can supply
  the OTP (or an authorized automation token with 2FA bypass is configured).
  Re-run the preflight and availability check before resuming; never republish an
  existing version.

### EOTP recovery check (2026-10-22)

- Git: clean `main` at `1c9c651`; no tags or remotes.
- `npm whoami` → `code-translator`.
- All eleven `npm view <pkg> version` checks still return **404**; **0/11
  packages are published**.
- Terminal capability: stdin, stdout, and stderr are **not TTYs**; `tty` reports
  “not a tty”; opening `/dev/tty` fails with `ENXIO`. This tool session cannot
  display an interactive npm OTP prompt or accept secure OTP input.
- Therefore **no publish was attempted** in this session. No 2FA bypass, account
  security change, tag, push, or upload was performed.
- Recovery requires a human-operated interactive terminal on the same machine and
  npm account. Run the documented `@axion-ct/core` command there, enter the OTP
  directly at npm's prompt, verify the package, and only then continue the order.
  Never place the OTP in a command argument, file, chat, or log.

Prepared from `main` at `f4c69ab` (clean working tree, no tags, no remotes); the
report update is a documentation-only follow-up. The scope migration and
parser-py packaging fixes are included (`3918946`, `70d774a`).

## 0. Scope migration

V1 was originally prepared under the `@ctrans` scope. That organization was
unavailable, and the maintainer created `@axion-ct`. On 2026-10-22 all eleven
package names, internal dependency declarations, imports, loaders, TypeScript and
Vitest aliases, lockfile entries, tests, and release documentation were migrated
to `@axion-ct/*`. The version remains `0.1.0`, and the root `code-translator`
package remains private. `@ctrans` was never published; references to it here and
in historical notes are explicitly historical.

## 1. Release set

Eleven publishable packages, all `0.1.0`, MIT, `engines.node >= 22.18`:

| Package | Internal dependencies | External runtime dependencies | Packed content |
| --- | --- | --- | --- |
| `@axion-ct/core` | — | — | `dist/` |
| `@axion-ct/parser-py` | core | `tree-sitter-python`, `web-tree-sitter` | `dist/`, `python/bridge.py` |
| `@axion-ct/parser-js` | core | `@babel/parser`, `oxc-parser`, `typescript` | `dist/` |
| `@axion-ct/registry` | core | — | `dist/` |
| `@axion-ct/sandbox` | core | — | `dist/` |
| `@axion-ct/codegen-js` | core | `prettier` | `dist/` |
| `@axion-ct/codegen-py` | core | `@astral-sh/ruff-wasm-nodejs` | `dist/` |
| `@axion-ct/ai` | core | `secretlint` packages | `dist/` |
| `@axion-ct/validator` | core, sandbox | — | `dist/` |
| `@axion-ct/repair` | core, ai | — | `dist/` |
| `@axion-ct/cli` | all ten above | `pyright`, `typescript`, `vitest` | `dist/`, compiled `bin/ctrans-dist.mjs` |

The root package `code-translator` is `private: true` and is **not** a release
artifact. Do not use `pnpm -r pack` as a publication step: it also produces a
local tarball of the private root. Pack only the eleven named packages.

No package declares `publishConfig`; scoped packages default to restricted
access, so the `--access public` flag in every publish command is mandatory. The
packages also omit `description`, `repository`, and `homepage`; these are registry
presentation metadata, not publish blockers, and cannot be filled accurately
without a maintainer-provided repository URL.

## 2. Preflight results (2026-10-22)

| Check | Result |
| --- | --- |
| Git state | `main` at `f4c69ab`; clean tree; no tags or remotes |
| Lockfile | `pnpm install --frozen-lockfile --offline --ignore-scripts` → **exit 0** |
| Full verification | `pnpm verify` → **exit 0**; 110 files, 1091/1091 tests; doc links OK |
| Package packing | All eleven `pnpm --filter <pkg> pack` commands → **exit 0** |
| Tarball metadata | Every tarball has `package.json`, `LICENSE`, `dist/`; `parser-py` contains only `python/bridge.py` (no `__pycache__` bytecode); no `workspace:` or old-scope specs remain |
| CLI tarball | Contains only `dist/`, `bin/ctrans-dist.mjs` (mode 0755), `package.json`, `LICENSE`; source-mode launchers excluded |
| Version consistency | All eleven packages are `0.1.0`; every internal dependency is `@axion-ct/*@0.1.0` |
| Dependency order | Validated: every internal dependency appears earlier in the planned order; no cycles or unlisted packages |
| Registry URL | `https://registry.npmjs.org/` |
| Registry reachability | `npm ping` → **exit 0** |
| npm authentication | `npm whoami` → **exit 0, account `code-translator`** |
| Organization | `npm org ls axion-ct code-translator --json` → **role `owner`** |
| Scope publish permission | **Appears authorized** (organization owner); exact registry enforcement is only proven by an actual publish, which was not attempted |
| Package names | All eleven `npm view <pkg> version` calls returned **404**; they are not publicly visible at check time |
| Publish-time 2FA | **Enabled** (`npm profile get --json` reports `tfa.mode: "auth-and-writes"`, `pending: null`); OTPs are never requested or stored in the plan |

The public registry was checked read-only. No credentials were read, printed,
stored, or modified.

## 3. Preconditions before the first publish

All must be true; otherwise stop.

1. Maintainer has authenticated npm as an account with publish rights to
   `@axion-ct`, and has the required 2FA/OTP mechanism ready.
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

**Current status (2026-10-22):** items 1–4 and 6 are verified; npm authentication
is active as `code-translator` (owner), and 2FA is enabled in `auth-and-writes`
mode. Item 5 — explicit maintainer approval of the version, package set, and
documented limitations — is the sole remaining gate.

## 4. Publish order

Publish one package at a time, in this order. Stop immediately on any failure.
The order ensures every `@axion-ct/*` dependency is already available.

1. `@axion-ct/core`
2. `@axion-ct/parser-py`, `@axion-ct/parser-js`, `@axion-ct/registry`, `@axion-ct/sandbox`
3. `@axion-ct/codegen-js`, `@axion-ct/codegen-py`, `@axion-ct/ai`
4. `@axion-ct/validator`, `@axion-ct/repair`
5. `@axion-ct/cli`

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
- every `@axion-ct/*` dependency is `0.1.0` (never `workspace:*`);
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
npm install @axion-ct/cli@0.1.0
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
authorization. Authentication as an organization owner establishes technical
access, not approval to release. The preflight checks above did not publish or
mutate registry state.
