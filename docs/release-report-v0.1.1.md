# Code Translator v0.1.1 — release report

Status: **published and verified on npm.** Publication window:
**2026-10-23 15:44:22.016–15:49:18.320 UTC**. Post-publication registry,
installation, CLI, six-direction, and project checks completed at
**2026-10-23 15:59:33 UTC**.

- Authorized source commit: **`5a9ed870892a46b80bc589d7251cceef3917f9f8`**
  (`fix: prevent silent integer precision loss`)
- Annotated tag: **`v0.1.1` → `5a9ed870892a46b80bc589d7251cceef3917f9f8`**
- Tag annotation: **`Code Translator v0.1.1`**
- Previous release: [`v0.1.0`](release-report-v0.1.0.md), published 2026-10-22
  and immutable
- Release scope: [release-notes-v0.1.1.md](release-notes-v0.1.1.md) — exact
  constant-integer precision analysis, integral-float/hex-token corrections, and
  disclosed limitations

No package was republished, unpublished, deprecated, or dist-tag-mutated while
creating this report.

## Published packages

Registry checks used `npm view <package>@0.1.1 version dist.integrity
dependencies time --json` and `npm view <package> dist-tags.latest --json`.
Every package is version `0.1.1`, has a SHA-512 `dist.integrity`, has
`latest=0.1.1`, and resolves every internal dependency to
`@axion-ct/*@0.1.1`.

| Package | Version | Latest | Published (UTC) | `dist.integrity` |
| --- | --- | --- | --- | --- |
| `@axion-ct/core` | `0.1.1` | `0.1.1` | `2026-10-23T15:44:22.016Z` | `sha512-XHrIR5BkyqnTWZJcVJW8VTWz7dsThC1naxSV9vXt3e6GtM2r9R407HMnIMfAhm39ORkov9do9DSdIO9vVmOyWg==` |
| `@axion-ct/parser-py` | `0.1.1` | `0.1.1` | `2026-10-23T15:45:40.402Z` | `sha512-D7Kt2jIMYpzQu9/iRczjnUmrSDIe0Xb+SMbBW5AK/OAZLRQA4eahabpH2rwPC0v/fdLYOwLeICaMy7kwj8LK3Q==` |
| `@axion-ct/parser-js` | `0.1.1` | `0.1.1` | `2026-10-23T15:46:02.493Z` | `sha512-+Lx0/P9HqGTXDXorRLaXaRykvyCR70Tv48hIAVFtYtqNqbT14FNnPnFKlglT7bf1jOjoXU9AkHFuUTLRzOtCOg==` |
| `@axion-ct/registry` | `0.1.1` | `0.1.1` | `2026-10-23T15:47:07.919Z` | `sha512-fewVDpcT2J9JBk/4Dptph4wAzCQ22i8QfBv3kL4ytu7Bx/FuwwSo1ayHtaBlCEpqxJVdzAoFcwPRYr1rR1NJcA==` |
| `@axion-ct/sandbox` | `0.1.1` | `0.1.1` | `2026-10-23T15:46:38.285Z` | `sha512-owApOlMng7gYAgbRcYsv1pQv4a9E2CoVaFpwedQ8OUyd6Gns1VNWO+vH11TsuQm5PR0eJEGdzg5v7l16ld4DNA==` |
| `@axion-ct/codegen-js` | `0.1.1` | `0.1.1` | `2026-10-23T15:48:18.438Z` | `sha512-uHIc52C4sfhMDNE3g6qf/Zp7PgRJZ2wrnOg1foJLB79FzqMp62QkYRdo4KzyR6+sPUGT0z8E6qn5m+WifzCyFw==` |
| `@axion-ct/codegen-py` | `0.1.1` | `0.1.1` | `2026-10-23T15:47:43.984Z` | `sha512-uT0XpWE2hCyeW1H3uKBwS0x54/fotV4DtHhoTSk504skHsLBuR/XfdOUWOHeWD7+KpGEMl/NYoXpXp2WvaC5lQ==` |
| `@axion-ct/ai` | `0.1.1` | `0.1.1` | `2026-10-23T15:48:08.401Z` | `sha512-dArrImj4xyi5EJl/VHA4CDcdfnlGbl4CDBsxH73HspRYDzBHR625uVIlhT7FbY989ytpIuymd0KWGjPctbsl0w==` |
| `@axion-ct/validator` | `0.1.1` | `0.1.1` | `2026-10-23T15:48:39.855Z` | `sha512-02eM6vNMI4EmpqPxgTvKgBLFiRUkhdnfSRJ0dCg8vkhwn+K6urlVdcYDByGmzshitrKMHRtZd7R5FJf55VAxnA==` |
| `@axion-ct/repair` | `0.1.1` | `0.1.1` | `2026-10-23T15:49:16.577Z` | `sha512-NFJkjc0W63fpsVE2wPXKQYgzaJyCmgYGVsWy0BcgUBRsahMQGscLc7AH8HAfvFY8l+e8875j7RrhrzsyQc6LTw==` |
| `@axion-ct/cli` | `0.1.1` | `0.1.1` | `2026-10-23T15:49:18.320Z` | `sha512-c/4cvaA7roN9EwwcTPTgHQrjt/fGCYu/O1Rrak9m3lMCSMA+t5U/mb/Sj66yyEGW2qKxkHKsnE/4OCOPqDy/mg==` |

The registry also retains the historical `0.0.0-stage` and `0.1.0` versions;
normal `latest` installs now resolve `0.1.1`.

## Public-registry installation

A fresh temporary project outside the repository installed only from npm:

```bash
npm init -y
npm install --ignore-scripts --no-audit --no-fund @axion-ct/cli@0.1.1
```

Environment: Node.js `v24.15.0`, npm `11.12.1`. Result: **exit 0**, 149 packages
added. The lockfile resolved all eleven `@axion-ct/*` packages from
`https://registry.npmjs.org/`; every installed package was `0.1.1`, and every
internal dependency was `@axion-ct/*@0.1.1`. No local workspace links or local
tarballs were used.

Earlier pre-publication verification separately installed all eleven locally
packed tarballs and passed the same CLI/project smoke sequence. That evidence is
pre-publication and is not counted as the public-registry check above.

## CLI verification

The public-registry CLI reported:

```text
0.1.1
```

`ctrans doctor --json` exited **0**:

- `requiredAvailable: true`
- `strictAvailable: true`
- Required capabilities available: node, python3, bwrap, pyright, tsc, vitest
- Optional capabilities: prlimit, Docker, and Podman available; gVisor optional
  (not used)

## Six-direction smoke tests

Each command used a minimal supported `add(a, b)` example and exited 0:

| Direction | Exit | Reported claim | Notes |
| --- | ---: | --- | --- |
| Python → TypeScript | 0 | claim 3 | S1/S2/S3 pass |
| Python → JavaScript | 0 | claim 1 | S2 skipped for the JavaScript target |
| JavaScript → TypeScript | 0 | claim 3 | S1/S2/S3 pass |
| JavaScript → Python | 0 | claim 3 | S1/S2/S3 pass |
| TypeScript → JavaScript | 0 | claim 1 | S2 skipped for the JavaScript target |
| TypeScript → Python | 0 | claim 3 | S1/S2/S3 pass |

Claim levels are validation claims, not universal semantic-equivalence proofs.

## Project validation

The public-registry CLI translated and validated
`tests/fixtures/project-barrels-multi-module/input`:

- Exit code: **0**
- Claim: **5**
- S1 syntax, S2 types, S3 dependencies, S4 build, S5 tests, and S6 differential:
  **pass**
- S5: 5 outcomes passed
- S6 differential: 5 matched
- S7 smoke: skipped by design because no smoke harness was supplied

## Pre-publication verification evidence

At authorized commit `5a9ed870892a46b80bc589d7251cceef3917f9f8`, with a clean
working tree:

- `pnpm verify`: **exit 0**; 113 test files, **1116/1116 tests**, documentation
  links passed.
- `pnpm test:coverage -- --maxWorkers=4`: **exit 0**; 1116/1116 tests.
- Coverage: overall **90.27% lines**; `@axion-ct/codegen-js` **90.86%**;
  `@axion-ct/sandbox` **86.39%**.
- Targeted sandbox/container/project-golden checks had passed **35/35**,
  including a real Docker `fedora:44` strict-driver run.
- All eleven tarballs rebuilt from the authorized commit were inspected: version
  `0.1.1`, internal dependencies `0.1.1`, MIT license, expected runtime files,
  no workspace protocol, old scope, source/test files, or generated caches.

## Warnings, limitations, and unexecuted checks

- The coverage command prints the known Vitest `5.0.3` /
  `@vitest/coverage-v8` `5.0.5` mixed-version warning; both verification and
  coverage exited 0.
- S7 smoke is opt-in and was not supplied; it is reported outside the claim
  ladder.
- Number-mode `0 ** -1` remains a disclosed pre-existing gap: generated
  JavaScript evaluates `Infinity` where Python raises `ZeroDivisionError`.
- Indirect/runtime integer values are not value-tracked; precision warnings
  cover statically constant integer expressions.
- A broader JavaScript sample using `console.log` still has no Python mapping and
  can produce a pyright S2 failure/claim 1; this pre-existing limitation is not
  part of the minimal supported smoke matrix.
- A full strict toolchain-image S4–S7 run was not part of this release check;
  `doctor` only reports that strict-capable container runtimes are available.
- Windows CredMan retrieval and live OS-keychain round-trips remain unverified.
- No Git remote is configured and nothing was pushed.

## Release finalization

- `v0.1.1` annotated tag was created only after all registry and public-install
  checks passed.
- Tag target: **`5a9ed870892a46b80bc589d7251cceef3917f9f8`**
- `v0.1.0` remains at `716a11b11c0d174dafb5f57d1762c4f3507d7b5f` and was not
  moved.
- This report and `PROJECT_STATE.md` are committed separately after the source
  tag so the tag continues to identify the authorized source release commit.
