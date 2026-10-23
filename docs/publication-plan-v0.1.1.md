# v0.1.1 patch publication plan

**Status: prepared locally; NOT PUBLISHED.** This plan is a checklist, not an
authorization to publish. No package, dist-tag, tag, or registry state has been
changed. The previous release plan is [publication-plan.md](publication-plan.md)
(historical `v0.1.0`).

## 1. Release set and invariant

Eleven packages, all `0.1.1`, MIT, `engines.node >= 22.18`:

1. `@axion-ct/core`
2. `@axion-ct/parser-py`, `@axion-ct/parser-js`, `@axion-ct/registry`,
   `@axion-ct/sandbox`
3. `@axion-ct/codegen-js`, `@axion-ct/codegen-py`, `@axion-ct/ai`
4. `@axion-ct/validator`, `@axion-ct/repair`
5. `@axion-ct/cli`

The private root `code-translator` package is not a release artifact. Do not use
`pnpm -r publish` or `pnpm -r pack` as a publication command.

Every internal dependency stays declared as `workspace:*` in the repository.
pnpm rewrites those ranges to `0.1.1` when packing/publishing; a tarball containing
`workspace:*` or a dependency on `@axion-ct/*@0.1.0` is a blocker.

## 2. Preconditions — all must be true

1. The exact release commit is reviewed and approved. **The current working tree
   has uncommitted release changes, so it is not yet publishable.**
2. The tree is clean at that commit (`git status --porcelain` empty); no untracked
   release artifacts.
3. `pnpm install --frozen-lockfile --offline --ignore-scripts` succeeds.
4. `pnpm verify` exits 0 at that commit, with **113 files and 1116/1116 tests**.
   `pnpm test:coverage` exits 0 and the coverage floors hold.
5. The eleven tarballs are rebuilt from that exact commit and inspected:
   - version is `0.1.1`;
   - every `@axion-ct/*` dependency is `0.1.1` (no `workspace:`, no `0.1.0`);
   - no `@ctrans/` scope, source files, `__pycache__`, or other generated junk;
   - `@axion-ct/parser-py` contains `dist/` and `python/bridge.py` only;
   - `@axion-ct/cli` contains `dist/` and `bin/ctrans-dist.mjs` only.
6. The registry does not already have `0.1.1` for any package. A pre-existing
   version is a hard stop; npm versions are immutable.
7. The maintainer is authenticated with publish rights to `@axion-ct`, has the
   required 2FA/OTP mechanism ready in an interactive terminal, and has
   explicitly authorized this patch release.
8. The documented limitations in
   [release-notes-v0.1.1.md](release-notes-v0.1.1.md) are accepted, including the
   known number-mode `0 ** -1` gap.

Never place an OTP, token, or credential in a command argument, file, chat, or log.
No publish-capable session exists in the current automation environment (prior
attempts failed with `EOTP` and no TTY); publication must be run by the maintainer
in an OTP-capable interactive session.

## 3. Build and verification commands

```bash
cd /home/sifat/project/code-translator
pnpm install --frozen-lockfile --offline --ignore-scripts
pnpm verify
pnpm test:coverage
pnpm build
```

Rebuild and inspect tarballs (one tarball per package):

```bash
pack_dir="$(mktemp -d)"
for pkg in \
  @axion-ct/core \
  @axion-ct/parser-py @axion-ct/parser-js @axion-ct/registry @axion-ct/sandbox \
  @axion-ct/codegen-js @axion-ct/codegen-py @axion-ct/ai \
  @axion-ct/validator @axion-ct/repair \
  @axion-ct/cli
do
  pnpm --filter "$pkg" pack --pack-destination "$pack_dir" || exit 1
done
ls -1 "$pack_dir"
```

Inspect every tarball before publishing:

```bash
for tgz in "$pack_dir"/*.tgz; do
  echo "== $tgz"
  tar -xOzf "$tgz" package/package.json
  tar -tzf "$tgz" | grep -E '(^package/(dist|python|bin)/|\.ts$|__pycache__|workspace:)' || true
done
```

Local CLI smoke (compiled entry, no registry access):

```bash
node apps/cli/bin/ctrans-dist.mjs --version         # 0.1.1
node apps/cli/bin/ctrans-dist.mjs --help
node apps/cli/bin/ctrans-dist.mjs doctor --json
```

## 4. Registry preflight and availability

Read-only checks; do not publish from this section:

```bash
npm whoami
npm org ls axion-ct --json
npm profile get --json                         # confirm 2FA auth-and-writes
for pkg in \
  @axion-ct/core @axion-ct/parser-py @axion-ct/parser-js \
  @axion-ct/registry @axion-ct/sandbox @axion-ct/codegen-js \
  @axion-ct/codegen-py @axion-ct/ai @axion-ct/validator \
  @axion-ct/repair @axion-ct/cli
do
  echo "== $pkg"
  npm view "$pkg@0.1.1" version --json || true   # must be 404 before publishing
done
```

If any `0.1.1` already exists, stop. Do not overwrite, unpublish, or deprecate as
part of this plan.

## 5. Exact publication commands — dependency order

Run these one at a time, only after Section 2 is satisfied and the maintainer has
authorized publication. `--access public` is mandatory for scoped packages.
`--no-git-checks` is required because the repository has no remote and its branch
is `main`; it does not create a tag. `--ignore-scripts` prevents lifecycle scripts;
the packages are already built.

```bash
pnpm --filter @axion-ct/core publish --access public --tag latest --no-git-checks --ignore-scripts
pnpm --filter @axion-ct/parser-py publish --access public --tag latest --no-git-checks --ignore-scripts
pnpm --filter @axion-ct/parser-js publish --access public --tag latest --no-git-checks --ignore-scripts
pnpm --filter @axion-ct/registry publish --access public --tag latest --no-git-checks --ignore-scripts
pnpm --filter @axion-ct/sandbox publish --access public --tag latest --no-git-checks --ignore-scripts
pnpm --filter @axion-ct/codegen-js publish --access public --tag latest --no-git-checks --ignore-scripts
pnpm --filter @axion-ct/codegen-py publish --access public --tag latest --no-git-checks --ignore-scripts
pnpm --filter @axion-ct/ai publish --access public --tag latest --no-git-checks --ignore-scripts
pnpm --filter @axion-ct/validator publish --access public --tag latest --no-git-checks --ignore-scripts
pnpm --filter @axion-ct/repair publish --access public --tag latest --no-git-checks --ignore-scripts
pnpm --filter @axion-ct/cli publish --access public --tag latest --no-git-checks --ignore-scripts
```

If npm prompts for an OTP, enter it directly at the interactive prompt. Stop at the
first failure. Do not continue with dependents after a failed publish.

## 6. Per-package verification after each publish

Wait briefly for registry propagation, then run:

```bash
npm view @axion-ct/core@0.1.1 version dist.integrity dependencies --json
```

Repeat for the package just published. Assert:

- `version` is `0.1.1`;
- `dist.integrity` is present and non-empty;
- every `@axion-ct/*` dependency is `0.1.1` (never `workspace:*`);
- the `latest` dist-tag points at `0.1.1`.

Do not publish the next package until the dependency check passes. If propagation
is delayed, stop and investigate; do not republish a version.

## 7. Post-publish smoke

Only after all eleven packages verify, install the public CLI in a fresh temporary
project:

```bash
tmpdir="$(mktemp -d)"
cd "$tmpdir"
npm init -y
npm install --ignore-scripts @axion-ct/cli@0.1.1
./node_modules/.bin/ctrans --version          # must print 0.1.1
./node_modules/.bin/ctrans doctor --json
./node_modules/.bin/ctrans --help
```

Then run one translation per supported direction and a project claim-5 run using
the same procedures as the v0.1.0 release report, adapted to the host's available
`python3`, `bwrap`, and optional container runtime. Record unavailable capabilities
honestly; do not claim stages that did not run.

## 8. Tag and publication record

Only if every package and the post-publish smoke pass:

```bash
git tag -a v0.1.1 -m "Code Translator v0.1.1"
```

Do not push unless a remote is configured and the maintainer authorizes it. Record
the publication timestamp, package versions, dist-tags, and smoke results in a new
release report; do not rewrite the historical `v0.1.0` report.

## 9. Abort and rollback policy

- Stop at the first failed publish, dependency mismatch, or smoke failure.
- Never delete, republish, or mutate an already-published version. Prepare a new
  patch version instead.
- npm unpublish/deprecate operations are a maintainer decision and are outside this
  plan.
- If publication stops after some packages are public, record exactly which package
  versions and dist-tags exist before deciding on a corrective release.
- Do not create the `v0.1.1` tag before all packages and post-publish checks pass.

## 10. Authorization boundary

This document and the local version bump are preparation only. Authentication as an
organization owner establishes technical access, not approval to release. Any
publish, dist-tag, unpublish, deprecation, tag, push, or release operation requires
explicit maintainer authorization. No registry mutation was performed during this
preparation; the registry availability and authentication checks in Sections 4 and
5 must be run immediately before publication.
