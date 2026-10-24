# v0.1.2 publication plan

**Status: prepared locally; NOT PUBLISHED.** This plan is a checklist, not an
authorization to publish. No package, dist-tag, commit, tag, push, or registry
state has been changed while preparing it. The previous plan is
[publication-plan-v0.1.1.md](publication-plan-v0.1.1.md) (historical; its
release is live and immutable). Companion documents:
[release-notes-v0.1.2.md](release-notes-v0.1.2.md) (what ships) and
[release.md](release.md) (packaging rules).

## 1. Release set and invariant

Eleven packages, all `0.1.2`, MIT, `engines.node >= 22.18`:

1. `@axion-ct/core`
2. `@axion-ct/parser-py`, `@axion-ct/parser-js`, `@axion-ct/registry`,
   `@axion-ct/sandbox`
3. `@axion-ct/codegen-js`, `@axion-ct/codegen-py`, `@axion-ct/ai`
4. `@axion-ct/validator`, `@axion-ct/repair`
5. `@axion-ct/cli`

The private root `code-translator` package (also at `0.1.2`) is not a release
artifact. Do not use `pnpm -r publish` or `pnpm -r pack` as a publication
command — recursive commands include the private root and hide the stop point.

Every internal dependency stays declared as `workspace:*` in the repository.
pnpm rewrites those ranges to `0.1.2` when packing/publishing (verified during
the packaging stage: all 11 tarball manifests carry exactly `0.1.2` internal
ranges); a tarball containing `workspace:*` or an `@axion-ct/*@0.1.1`
dependency is a blocker.

## 2. Preconditions — all must be true

1. **Maintainer approval for the release commit.** The prepared v0.1.2 work is
   intentionally uncommitted (**83 modified/untracked paths at HEAD
   `84c6ce6`, including this release-plan document itself — the plan ships in
   the release commit**). The review-to-commit sequence is:
   (a) the maintainer reviews the full diff (`git status --porcelain`,
   `git diff`), guided by the evidence trail (the three 2026-10-24 audits,
   PROJECT_STATE §19 entries, and the verify/coverage/packaging runs recorded
   there); (b) the Section 2 battery and the Section 2.5 tarball inspection
   run on the working tree; (c) the maintainer explicitly approves the commit
   contents; (d) one release commit is created; (e) Section 2 is re-run
   against that exact commit. Publication happens only from that commit (see
   Section 8). Until it exists, the tree is not publishable. If the step-(e)
   re-run fails **before anything is pushed**, fix the issue and create a new
   local commit (or amend locally — permitted only pre-push); never rewrite a
   release commit that has already been pushed.
2. At the approved commit, `git status --porcelain` is empty.
3. `pnpm install --frozen-lockfile --offline --ignore-scripts` succeeds.
4. `pnpm verify` exits 0 — expected **119 files, 1159/1159 tests** (the count
   recorded by the bump-preparation run; re-run at the commit and record the
   actual numbers). `pnpm test:coverage -- --maxWorkers=4` exits 0 and
   `pnpm coverage:check` holds the floors (expected: core 91.89%, parser-py
   91.82%, parser-js 91.75%, codegen-js 90.93%, codegen-py 90.76%).
5. The eleven tarballs are rebuilt **from that exact commit** and re-inspected
   (the 2026-10-24 packaging verification is evidence for the current tree
   only; it must be repeated at the commit):
   - version is `0.1.2`; every `@axion-ct/*` dependency is exactly `0.1.2`;
   - no source maps, raw `.ts` sources, logs, `node_modules`, or `.ctrans`
     artifacts;
   - `@axion-ct/parser-py` contains `dist/` and `python/bridge.py`;
   - `@axion-ct/cli` contains `dist/` and `bin/ctrans-dist.mjs`;
   - every `bin`/`exports` target resolves inside its tarball.
6. `git diff --check` is clean; no staged leftovers from preparation.

## 3. Registry preflight, authentication, and OTP

Read-only checks; do not publish from this section. As of 2026-10-24 the
automation session is **unauthenticated** (`npm whoami` → 401) and npm 2FA for
this account is `auth-and-writes`: every publish requires a one-time password
entered at an **interactive** prompt. Non-TTY sessions fail with `EOTP` (this
happened during the v0.1.0 attempt and is documented in PROJECT_STATE §19).
Therefore publication must be run by the maintainer in an OTP-capable
terminal; automation must never ask for, store, or echo credentials.

```bash
npm whoami                                    # must identify the maintainer
npm org ls axion-ct --json                    # role owner
npm profile get --json                        # 2FA enabled, auth-and-writes
for pkg in \
  @axion-ct/core @axion-ct/parser-py @axion-ct/parser-js \
  @axion-ct/registry @axion-ct/sandbox @axion-ct/codegen-js \
  @axion-ct/codegen-py @axion-ct/ai @axion-ct/validator \
  @axion-ct/repair @axion-ct/cli
do
  echo "== $pkg"
  npm view "$pkg@0.1.2" version --json || true   # must be 404 before publishing
done
npm view @axion-ct/cli version                 # latest must still be 0.1.1
```

If any `0.1.2` already exists, stop. Do not overwrite, unpublish, or deprecate
any published version as part of this plan.

## 4. Exact publication commands — dependency order

Run one at a time, only after Section 2 and Section 3 pass and the maintainer
has authorized publication in this session. `--access public` is mandatory for
scoped packages; `--no-git-checks` avoids branch/upstream checks (it creates no
tag); `--ignore-scripts` keeps lifecycle scripts off (packages are built).

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

If npm prompts for an OTP, the maintainer enters it directly at the prompt.
**Stop at the first failure.** Never continue with dependents after a failed
publish.

## 5. Per-package verification after each publish

Wait briefly for registry propagation, then for the package just published:

```bash
npm view @axion-ct/<name>@0.1.2 version dist.integrity dependencies --json
```

Assert: `version` is `0.1.2`; `dist.integrity` is present and non-empty; every
`@axion-ct/*` dependency is exactly `0.1.2` (never `workspace:*`); the
`latest` dist-tag points at `0.1.2`. Do not publish the next package until
this passes. If propagation is delayed, stop and investigate — never republish
an existing version.

## 6. Post-publish smoke

Only after all eleven packages verify:

```bash
tmpdir="$(mktemp -d)"
cd "$tmpdir"
npm init -y
npm install --ignore-scripts @axion-ct/cli@0.1.2
./node_modules/.bin/ctrans --version          # must print 0.1.2
./node_modules/.bin/ctrans --help
./node_modules/.bin/ctrans doctor --json      # requiredAvailable: true
```

Then run the six-direction translation smoke and a claim-5 project run
following `scripts/public-cli-smoke.mjs` with `0.1.2` as the expected version
(the script takes the version as an argument, so it can be exercised before
its default is repointed). Record unavailable host capabilities honestly; do
not claim stages that did not run. A further optional check, already proven
against the local tarballs on 2026-10-24 (149-package clean install,
both-direction translations whose outputs executed): repeat the tarball
clean-install smoke for registry-resolved packages.

## 7. Published-version CI transition — timing

`scripts/public-cli-smoke.mjs` (default `expectedVersion = "0.1.1"`) and
`.github/workflows/ci.yml` (line `run: node scripts/public-cli-smoke.mjs
0.1.1`) intentionally still reference the **published** registry version.
Sequence matters:

1. **Before publication:** leave both at `0.1.1`. Pushing the release commit
   runs CI against the still-published `0.1.1` — the smoke passes. Changing
   them earlier would break CI against a nonexistent `0.1.2`.
2. **After all eleven packages verify on the registry (Section 5):** create
   the transition commit (Section 8, step 4) — change the script default and
   the workflow invocation to `0.1.2`, push it, and confirm the CI job passes
   against the newly published version.
3. Keep this follow-up separate from the release commit so a CI failure
   during transition never contaminates the published tree. This ordering
   agrees with `docs/release.md` (which gates the tag on registry checks and
   post-publish smoke, and requires non-force pushes with authorization); no
   conflict.

## 8. Commit, tag, push, CI transition, and GitHub release — approval gates

Each numbered step is a distinct approval gate; do not bundle them:

1. **Release commit (maintainer approval required).** Commit the entire
   prepared v0.1.2 tree — all 83 paths, this plan included — as one reviewed
   release commit, following the Section 2.1 sequence. Re-run Section 2 at the
   commit. Publishing happens from this commit only.
2. **Annotated tag (only after Section 6 passes):**
   `git tag -a v0.1.2 -m "Code Translator v0.1.2"`. Never tag before the
   registry checks and smoke pass.
3. **Push (explicit authorization):** push the release commit and the tag to
   `main` on `AxionAura/code-translator` (non-force only). CI runs the verify
   matrix; the published-CLI smoke still expects `0.1.1` per Section 7 until
   the transition commit lands.
4. **CI-transition commit (explicit authorization):** after the release
   commit and tag are pushed and CI is green on the `0.1.1` smoke pin, change
   `scripts/public-cli-smoke.mjs`'s default and the
   `.github/workflows/ci.yml` invocation to `0.1.2` in one small separate
   commit, push it, and require CI to pass against the newly published
   `0.1.2`. Keep it separate from the release commit (Section 7).
5. **GitHub Release (explicit authorization, only after steps 1–4 pass):**
   create the release from the tag with `gh release create v0.1.2 --title
   "Code Translator v0.1.2" --notes-file docs/release-notes-v0.1.2.md` (or the
   GitHub UI). Do not rewrite the `v0.1.0`/`v0.1.1` releases.
6. **Publication record:** write `docs/release-report-v0.1.2.md` (sections
   modeled on release-report-v0.1.1.md: published packages, public-registry
   installation, CLI verification, six-direction smoke, project validation,
   pre-publication evidence, warnings/limitations, finalization) and update
   PROJECT_STATE §19. Never rewrite historical reports.

The step order above follows the requested sequence (publish and verify all
packages → post-publish smoke → release commit/tag push as repository policy
allows → CI smoke pin bump in a separate commit → GitHub Release after the
required checks pass) and is consistent with `docs/release.md`: the tag is
gated on registry checks and smoke, pushes are non-force with authorization,
and nothing in `docs/release.md` constrains CI-transition timing beyond that.

## 9. Abort and rollback policy

General rules: stop at the first failed publish, dependency mismatch, or smoke
failure. Never delete, republish, or mutate an already-published version —
prepare a new patch version (`0.1.3`) instead. `npm unpublish` and `npm
deprecate` are maintainer decisions outside this plan. Do not create the
`v0.1.2` tag or GitHub release before every package and the post-publish smoke
pass.

**9.1 Partial publication (some packages published, a later one failed).**

1. Record exactly which versions and dist-tags exist before deciding anything:
   `npm view <pkg> versions` and `npm view <pkg> dist-tags --json` for all
   eleven packages.
2. Partial states are consumer-safe by construction: the CLI publishes last
   and every internal dependency is an exact pin, so `@axion-ct/cli@0.1.1`
   keeps resolving its immutable `0.1.1` dependencies regardless of how many
   `0.1.2` packages are live. Do not unpublish anything out of panic.
3. Resume only after the failure is understood: rebuild from the **same
   approved release commit** (Section 2.5 provenance), continue in the
   Section 4 dependency order skipping the already-published packages, and
   run the Section 5 verification after each remaining package.
4. If the failure is a content defect in an already-published package, that
   version can never change — move to the corrective `0.1.3` procedure
   (9.2 step 4).

**9.2 All eleven published but the post-publish smoke fails.**

1. Stop. Do not tag, push the tag, or announce the GitHub Release (none exist
   yet at this point by construction).
2. Diagnose against the published artifacts (`npm pack @axion-ct/<pkg>@0.1.2`
   in a scratch directory), not against local builds.
3. Containment while a fix is prepared is a maintainer decision; the two
   reversible options are moving the CLI's mutable `latest` pointer back —
   `npm dist-tag add @axion-ct/cli@0.1.1 latest` (a dist-tag is a pointer,
   not a version mutation) — and/or `npm deprecate @axion-ct/cli@0.1.2
   "<reason>"`. Never unpublish or republish the `0.1.2` versions.
4. Corrective release outline: fix the defect, bump all twelve manifests to
   `0.1.3`, regenerate goldens/version-dependent tests, re-run this plan from
   Section 2 with `0.1.3` substituted throughout.

**9.3 CI-transition failure (post-publication).**

1. The published packages and the release commit are unaffected — never alter
   the already-published release commit.
2. Fix the transition (script default, workflow pin, or whatever failed) in a
   separate follow-up commit and push it; CI on `main` stays green throughout
   because the previous pin (`0.1.1`) smoke keeps passing until the corrected
   transition lands.
3. Repeat until the `0.1.2`-pinned CI job is green; only then proceed to the
   GitHub Release gate (Section 8, step 5).

## 10. Authorization boundary

This document and the local version bump are preparation only. Authentication
as an organization owner, a clean approved commit, or a green checklist
establishes technical readiness, not approval to release. Each of the
following requires its own explicit maintainer authorization, in the session in
which it runs: creating the release commit (Section 8.1), publishing each
package (Section 4), creating the tag and pushing (Sections 8.2–8.3), the
CI-transition commit and push (Section 8.4), the GitHub Release (Section 8.5),
any containment action in Section 9 (dist-tag move or deprecate), and any
corrective `0.1.3` release. No registry, git, or GitHub mutation may be
performed by preparation or automation work; OTP entry happens only at npm's
interactive prompt by the maintainer.

## 11. Go/no-go checklist and outstanding uncertainties

Go, only if every box is checked:

- [ ] Maintainer has explicitly approved the release commit and its contents
      (all 83 paths, this plan included — Section 10 authorization boundary).
- [ ] Release commit exists; `git status --porcelain` empty; verify/coverage
      re-run at the commit with recorded counts (expected 1159/1159, floors
      held).
- [ ] Eleven tarballs rebuilt from the commit and re-inspected (Section 2.5).
- [ ] Interactive OTP-capable npm session: `npm whoami` identifies the
      maintainer, 2FA `auth-and-writes` confirmed.
- [ ] All eleven `@0.1.2` versions return 404 immediately before publishing;
      `latest` is still `0.1.1`.
- [ ] Publication executed one package at a time in Section 4 order, each
      followed by Section 5 verification.
- [ ] Post-publish clean-consumer smoke passes (`--version` → `0.1.2`,
      doctor required capabilities, six directions, claim-level run).
- [ ] CI transition commit (Sections 7 and 8.4) pushed and green against
      published `0.1.2`.

Outstanding uncertainties (documented, none blocking preparation):

- **OTP delivery** depends on the maintainer's authenticator; automation
  cannot supply it (EOTP history). If the session cannot authenticate, stop —
  nothing else in this plan is time-sensitive.
- **Registry propagation delays** between publish and `npm view`
  verification: wait and re-check; never republish.
- **npm provenance/attestations** are not configured and are not required by
  the project's release documentation; adding them would be a separate
  decision for a future release.
- **CI coverage**: Linux-only matrix on GitHub-hosted runners; the strict
  container image remains operator-provided (unchanged from v0.1.1).
