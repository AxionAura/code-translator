# Security review checklist (M11)

Status: **executed against the M11 tree (2026-10-22)**. Scope: input handling,
subprocess execution, sandbox boundaries, configuration, secrets, temporary files,
filesystem access, distribution, and dependency risk. A checked item cites the
implementation and the test that proves it; unverified environment-dependent items
are marked explicitly and are never presented as verified.

## Threat coverage (docs/security.md §1)

| Threat | Implementation | Evidence | Status |
| --- | --- | --- | --- |
| T1 malicious source project | non-executing parsers (CPython `ast`/`symtable`/`tokenize`; oxc/Babel), intake caps, symlink policy, sandbox-only execution | parser hostile-input/protocol tests; `packages/core/test/project.test.ts`; sandbox tests | Verified |
| T2 malicious translated output | provenance ledger, explicit unsupported markers, no fabricated behavior, validation claims capped by executed stages | ConstructMatrix/golden fixtures; validator claim tests | Verified |
| T3 source exfiltration via AI | local-first default; secretlint hard gate before every request; hash-only journals; opt-in disk cache (model text only, owner-only files) | `packages/ai/test/{fail-closed,resolver,disk-cache}.test.ts`; repair journal tests | Verified |
| T4 prompt injection via code | content-derived data fences, option-only/patch-only outputs, strict validation, no tools | M8/M9 tests; repair policy guard | Verified |
| T5 API key theft | `CTRANS_AI_KEY` → OS keychain (`security`/`secret-tool`) → 0600 file with warning; symlink/permission checks; keys never in config/flags/logs/cache keys | `apps/cli/test/keys.test.ts`; AI missing-key tests | Verified for env + file; keychain command path unit-injected, no live credential stored in this environment |
| T6 supply chain | lockfile pinned, pnpm lifecycle-script blocking with an explicit allowlist, MIT/Apache/BSD-only policy, no GPL copying | `AGENTS.md` §5; `pnpm-lock.yaml`; dependency review below | Verified for current tree |
| T7 sandbox escape / resource abuse | hardened spawn + `prlimit` + bwrap; Docker/Podman strict driver with no network, read-only rootfs, cap-drop, pids/memory/cpu limits, workspace-only rw mount, cleanup; timeouts/output caps | `packages/sandbox/test/{sandbox,container}.test.ts`; project/CLI tests | Verified for host/bwrap; real Docker run with `fedora:44`; no live gVisor |
| T8 path traversal / file bombs | output confined to out-dir; intake caps; workspace-relative sandbox paths; cache keys are hex; S7 harness paths validated; config smoke path resolved relative to its file | sandbox spec tests; journal tests; cache tests; S7 tests | Verified |
| T9 model cost abuse | call/token/request/run caps, attempt caps 3/8, loop detection, cache | M8/M9 tests | Verified |
| T10 validation weakening | unit-scoped diffs, policy guard, tests/generated artifacts not patchable, real validators re-run | M9/M10 repair tests | Verified |
| T11 fake capability / silent downgrade | functional probes (daemon query, bwrap unshare, tool execution); strict mode requires runtime+image and refuses; skipped stages never count as pass | M10 capability/evidence tests; `doctor` tests | Verified |

## M11-specific review items

- **Configuration** (`apps/cli/src/config.ts`): strict object schema, unknown keys
  rejected, secret-bearing keys rejected with a security-specific error, image
  reference validated, URLs reject embedded credentials, `format: false` rejected
  rather than silently ignored, file size cap, malformed JSON typed error. CLI
  flags override config; config never supplies an API key. Evidence:
  `apps/cli/test/cli-m11.test.ts`.
- **Subprocess execution**: every spawn uses argv arrays (no shell), bounded
  timeouts, env allowlists; keychain commands use `execFileSync` with a 3s timeout
  and no output logging. No `shell: true` in the tree.
- **Temporary files**: sandbox workspaces are fresh temp dirs and removed in
  `finally`; smoke harnesses are materialized only inside the workspace; benchmark
  projects write to per-iteration temp dirs and clean them up.
- **Filesystem writes**: CLI output is confined to `-o`; repair journal fixed path
  with containment check; cache root validated as a real directory (symlink
  refused) with 0700 directory/0600 files and atomic writes; config reads capped at
  64 KiB; key file requires owner-only permissions and rejects symlinks.
- **Secrets and logs**: key values are never logged; AI journal stores hashes; the
  benchmark/JSON outputs contain counts and timings, not prompts or keys; error
  messages are secret-free (tested).
- **Distribution**: compiled dist entry uses package exports → `dist`; package
  `files` whitelists only `dist` (plus the Python bridge script for `parser-py`);
  no repository TypeScript sources are required at runtime. Tests:
  `tests/dist-entry.test.ts`.
- **Dependencies**: no new runtime dependencies were added in M11. M10 dependencies
  remain pinned (`pyright`, ruff WASM, secretlint, oxc, Babel, TypeScript, Prettier,
  tree-sitter WASM). No GPL/AGPL code or packages were introduced.

## Residual risks and unverified environments

- **OS keychain retrieval**: implemented via `security` (macOS) and `secret-tool`
  (Linux); this environment has no stored `ctrans-ai` credential, so the real
  keychain round-trip is not exercised. The file fallback and all rejection paths
  are tested. Windows Credential Manager retrieval is not implemented; the 0600
  file fallback is documented there.
- **Disk cache**: opt-in (`--ai-cache disk` / `ai.cache: "disk"`) because cached
  model output may contain code-derived text. It is per-user and owner-only, but a
  compromised user account can read it; there is no encryption at rest.
- **Strict containers**: a real Docker run was executed with a local image, but no
  image providing the full node+python validation toolchain was available, so an
  end-to-end S4–S7 strict validation was not executed. Podman was unit-tested but
  not run live; gVisor (`runsc`) is not installed.
- **Performance numbers** are machine-local; benchmark results are correctness
  gates plus timing observations, not cross-host comparisons.
