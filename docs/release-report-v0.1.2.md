# Code Translator v0.1.2 — release report

Release date: **2026-10-24**. Release commit
`742f3eebfe1dacaa491beecdea2be3b8074314e0` ("chore(release): prepare v0.1.2"),
CI-transition commit `d428f00d9169ba71c81628226ed8574f38d81704`, annotated tag
`v0.1.2` (tag object `236c05d5c1ac5111bc949099cfc3b5ad7f853090`) pointing at
the release commit. GitHub Release:
https://github.com/AxionAura/code-translator/releases/tag/v0.1.2 (published
2026-10-24T18:27:52Z; body refreshed from
[release-notes-v0.1.2.md](release-notes-v0.1.2.md) after its publication banner
was updated). Publication was executed by the maintainer in an authenticated
npm session (2FA `auth-and-writes`); every registry fact below was verified
read-only against the public registry after publication.

## Published packages

All eleven `@axion-ct/*` packages are live at `0.1.2` with `latest = 0.1.2`
and SHA-512 integrity. Per-package publish timestamps (UTC, from
`npm view <pkg> time`):

| Package | Version | Published (UTC) | Integrity (sha512) |
| --- | --- | --- | --- |
| `@axion-ct/core` | 0.1.2 | 17:48:49 | `G8fWkF41d2xisTtSqYhSkA3qQqllSF9bxkVXXOZPXlJtzYY+Eimm9ZrtaWqFxZvOJwR/kSXRNsSQF8Zm6+BEwQ==` |
| `@axion-ct/parser-py` | 0.1.2 | 17:47:41 | `hCYADkJ4bo8yYbPRznHdUrDt2kWGfpUMarvVR1BQSgOKhuwMXnHIJJd26ZkUZgZv2Dq45cyVPHDsd9BgOUEK3w==` |
| `@axion-ct/parser-js` | 0.1.2 | 17:47:45 | `vHOn1w196vNWOvq3IYExZt89GXO7hMhOF8ifdxa9i22YY6JNI7l6RzOQk7O4L3fP4Q90S5wHY0q4RzWYS0BuvA==` |
| `@axion-ct/registry` | 0.1.2 | 17:48:32 | `0s/dbR6zJ4s87L0qMDGYtPN430SPS21AHgWjjR1rDioh7aFmTS5fJM7xHNwj0wnqDUvetfVT/QliX0kB534SYA==` |
| `@axion-ct/sandbox` | 0.1.2 | 17:48:35 | `UwctOGck0S1rTv55b+3g+aIxH1gTKg0Km4qmRkAzsEZLPDq7w5yD562Ip0iogVhT6kUMRIN7ve/riGt5Mo+D7Q==` |
| `@axion-ct/codegen-js` | 0.1.2 | 17:47:57 | `JyTQKmiqd9eOj+8OnXXLIGb7p76/eBWKxCapvAsHXFbm4U0v/mmaDHDqbLIlaRBLi1c1kxCVVtVedXM6ZiQgDw==` |
| `@axion-ct/codegen-py` | 0.1.2 | 17:48:03 | `8RTM5LlKKYwOtwCPWQvYTAWZrgq9Dbj8ruJNv6X5dMiNkCQL4yyGjoxb8MO/fUvHtoidIamjXbO9DOmwqkwBjg==` |
| `@axion-ct/ai` | 0.1.2 | 17:48:06 | `qm70lNHvtl2mSjdSKrJ1W/2pZ82WTKStd2eLsnAdFwKhRaX3tmV9IfyCt/mn7WAd18b8z7tYy6adj1eCrpA6yQ==` |
| `@axion-ct/validator` | 0.1.2 | 17:48:11 | `/zPWDEEsbWRoo/21kFPXsczAvCBiybloBexhIMAXVR196w2Dv+xTwHhD4jqjuB4CxNaxbMssJmxvqD3Fj3SmSA==` |
| `@axion-ct/repair` | 0.1.2 | 17:48:13 | `2n9DkRdsmkmLVH3PtvqJokWdUX4sXgatYcyjZ4FlxdjkSsCBE5v+jZS/LwdFGE4hRaztxSZNL10Dr+12CAaftw==` |
| `@axion-ct/cli` | 0.1.2 | 17:48:17 | `FX90B3W7wKF7rlP7FluwEWUfxofWxYSGBzM8kEBj7Yo6as+/vFh7tpnB9RbB2ehlGnRI9z24NQpYDKhOWhtHdg==` |

Every published package's internal dependencies resolve to exactly
`@axion-ct/*@0.1.2` (no `workspace:*` ranges; verified per package via
`npm view <pkg>@0.1.2 dependencies --json`). The observed per-package
timestamps do not follow the plan's dependency-first listing order (the
maintainer published in their own sequence within a 68-second window);
post-publication verification confirmed every dependency resolves at `0.1.2`
and the public smoke below passed, so the outcome is consistent regardless of
interleaving.

## Public-registry installation

CI run [`40119673859`](https://github.com/AxionAura/code-translator/actions/runs/40119673859)
(job "Published CLI install (Linux)", green) installed `@axion-ct/cli@0.1.2`
from the public registry in a clean ephemeral project: the smoke log records
`registry install: all 11 internal packages at 0.1.2` and `ctrans version:
0.1.2`. The same script (`scripts/public-cli-smoke.mjs 0.1.2`) was also run
locally against the public registry with exit 0.

## CLI verification

From the public-registry install (local run; CI job equivalent):

- `ctrans --version` → `0.1.2`
- `ctrans --help` → exit 0
- `ctrans doctor --json` → exit 0, `requiredAvailable: true` and
  `strictAvailable: true` (node, python, bwrap, prlimit, pyright, tsc, vitest
  available on the CI/test hosts)

## Six-direction smoke tests

From `scripts/public-cli-smoke.mjs 0.1.2` (public registry; identical lines
appear in the CI job log of run `40119673859`):

| Direction | Result | Claim level |
| --- | --- | --- |
| Python → TypeScript | exit 0, output present | 3 (file mode) |
| Python → JavaScript | exit 0, output present | 1 (JS target: no S2 oracle) |
| JavaScript → TypeScript | exit 0, output present | 3 |
| JavaScript → Python | exit 0, output present | 3 |
| TypeScript → JavaScript | exit 0, output present | 1 |
| TypeScript → Python | exit 0, output present | 3 |

Claim levels are the documented ladder values for file-mode translation; they
report which validation stages ran and passed, not universal equivalence.

## Project validation

The same smoke run translated the `project-barrels-multi-module` fixture:
**exit 0, claim level 5, S1–S6 pass, S5 5/5, S6 5 matched** (sandboxed build,
translated tests, and source-vs-target differential).

## Pre-publication verification evidence

All performed at release commit `742f3ee` (2026-10-24):

- `pnpm install --frozen-lockfile --offline --ignore-scripts` — exit 0.
- `pnpm verify` — exit 0 (build, typecheck, lint, format, tests, doc links);
  **119 test files, 1159/1159 tests**.
- `pnpm test:coverage -- --maxWorkers=4` + `pnpm coverage:check` — floors held:
  core 91.89%, parser-py 91.82%, parser-js 91.75%, codegen-js 90.93%,
  codegen-py 90.76%.
- All eleven tarballs rebuilt from the commit and inspected: versions 0.1.2,
  exact-0.1.2 internal dependency rewrites, required files/bin/bridge present,
  no junk or secrets; SHA-256 checksums recorded at packing time.
- Clean isolated consumer install of the eleven tarballs (149 packages, no
  workspace symlinks); both-direction translations executed with expected
  output (including the v0.1.2 JS `%` semantics: `-9 % 7` → `-2`) and a
  semantic-classified ledger (`generator.version` 0.1.2).
- CI run [`40119150404`](https://github.com/AxionAura/code-translator/actions/runs/40119150404)
  on the pushed release commit: success (all five jobs), with the published-CLI
  smoke still pinned to `0.1.1` per the plan's sequencing.

## Warnings, limitations, and unexecuted checks

- The GitHub Release body initially carried the notes' preparation banner
  ("not published"); it was refreshed from the updated notes file immediately
  after the banner was corrected (verified via `gh release view`).
- Known product limitations are unchanged from the release notes: leg-1
  unsupported Python builtins, reverse validation capped at claim 3, the
  documented truthiness/instance/callback divergences, and Python
  call-arity/span diagnostics remaining deferred.
- Not exercised in this release: `npm unpublish`/deprecate (none performed),
  gVisor runtime, live OS-keychain retrieval on a consumer host, and the
  optional `--strict` container path on CI (documented as operator-provided
  image).

## Release finalization

This report, the publication banner update in
[release-notes-v0.1.2.md](release-notes-v0.1.2.md), the refreshed GitHub
Release body, the README redesign, and the PROJECT_STATE §19 entry complete
release-plan-v0.1.2 §8.6. Historical reports
([v0.1.1](release-report-v0.1.1.md), [v0.1.0](release-report-v0.1.0.md)) are
unchanged; published versions remain immutable.
