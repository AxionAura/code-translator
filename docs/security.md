# Security

Status: **implemented layers**. Local-first; user code is untrusted; execution is the only high-risk operation and is always sandboxed. The M11 review checklist with per-threat evidence is [security-review-checklist.md](security-review-checklist.md).

## 1. Trust boundaries and threats

| Threat | Vector | Mitigation |
| --- | --- | --- |
| T1 Malicious source project | crafted code/comments parsed or executed | parsing never executes (§2); execution only in sandbox (§3); size caps; path confinement |
| T2 Malicious translated output | generated code run by user later | honest reporting of unsupported constructs; no fabricated code; provenance headers |
| T3 Source exfiltration | AI provider calls | local-first default; secret-scan hard gate; no telemetry; journaling stores hashes not content by default |
| T4 Prompt injection via code | comments/docstrings instructing the model | code-as-data delimiting (per-request nonce), option-choice/patch-only outputs, no tool use, output re-validated (ai-architecture.md §4) |
| T5 API key theft | config files, logs, repo | keychain-first storage, 0600 fallback + warning, keys banned from config/logs/reports/git |
| T6 Supply chain | our npm deps; lifecycle scripts | lockfile pinned, pnpm script-block on, license allowlist, no trufflehog-style AGPL embedding, provenance noted as insufficient alone (2026-05-19 bypass) |
| T7 Sandbox escape / resource abuse | translated code consuming CPU/mem/net | hardened spawn + bwrap default; Docker/Podman strict driver with no network, read-only rootfs, dropped capabilities, cgroup limits, cleanup; timeouts; output caps |
| T8 Path traversal / file bombs | input archives, deep trees | output confined to declared out-dir; entry count/size caps; symlink policy (no following out-of-root); S7 harness files workspace-relative with size/count caps |
| T9 Model cost abuse (self-DoS) | repair loops | hard caps per run (calls/tokens/USD/wall-clock); central attempt caps (3/unit, 8/run); patch dedupe + state-hash loop detection |
| T10 Model-driven validation weakening | repair patches | unit-scoped diff grammar; policy guard on added lines (`@ts-ignore`/`@ts-nocheck`/`declare module`/lint suppression/test `.skip`/`.only`); tests and generated artifacts are not patchable; real validators re-run |
| T11 Fake capability / downgraded isolation | doctor, strict mode, stage skips | functional probes (daemon query, bwrap unshare run, tool execution); strict mode requires runtime+image and refuses without them; skipped stages never count as pass |

## 2. Translation path (no execution)

- Parsing uses: CPython stdlib `ast`/`symtable`/`tokenize` (syntax only — the bridge never imports user modules) and oxc/tsc (in-process, memory-safe, no eval).
- The Python bridge (`packages/parser-py/python/bridge.py`) is spawned one-shot per parse as `python3 -I -B` with a whitelisted environment: source arrives as raw bytes on stdin, results leave as one JSON envelope on stdout. `-I` (isolated mode) keeps `PYTHON*` env, user site-packages, and the caller's cwd off the import path, so a malicious `.py` cannot escalate through parsing — verified by hostile-input tests that prove module-level side effects, decorators, and default values never execute (packages/parser-py/README.md).
- Installed dependency of the tool = trusted code; user project = untrusted data. The two never share a process except through the sandbox runner.

## 3. Sandbox design (`@ctrans/sandbox`)

**Implemented (M6):** `SandboxRunner.run` is the only execution path for source or translated code. Baseline = hardened spawn (argv arrays, env allowlist with `HOME` pinned to a non-user path, fresh temp workspace materialized per run, process-group SIGKILL on timeout, per-stream output caps). `prlimit` wraps the command with rlimits when available. bwrap (`--unshare-net --unshare-pid --die-with-parent --ro-bind / /` + explicit workspace bind) is autodetected with a probe that actually exercises the network block; the capability report travels with every run and `networkIsolation: "enforced" | "policy-only"` distinguishes real isolation from policy-only. Strict mode (`requireNetworkIsolation: true`) throws `SandboxIsolationError` when enforced isolation is unavailable — execution is refused, never downgraded (S5/S6 run strict).

**Baseline (always, no privileges):**
- `child_process.spawn` with argv arrays (`shell:false`), explicit env whitelist (`PATH`, `HOME`=temp, `LANG`, plus runtime-specific minimals), `cwd` = temp copy of the minimum file set, `stdio` piped with size caps, wall-clock timeout + SIGKILL, no TTY.
- Resource limits via `prlimit` wrapper when present (CPU seconds, address space, file size, nproc); otherwise limits degrade to timeout-only — **recorded in capability report**.
- No network at baseline: tests known/likely to require network are flagged (static hints) and skipped in default mode.

**Isolation layer (auto-detected, opt-in via `sandbox: "auto"`):**
- **bubblewrap**: `--unshare-net --unshare-pid --die-with-parent --ro-bind / /`, a writable tmpfs `/tmp`, and an explicit read-write bind of the sandbox workspace. Toolchain mount paths that live under the host `/tmp` (clean-clone layouts) are re-bound read-only inside the bubble after the tmpfs, so dependency resolution cannot reach outside the declared mounts. Degrades gracefully (capability probe) where unprivileged user namespaces are disabled.
- **Docker/Podman strict mode (M10, implemented):** `project --strict` runs S4–S7 inside an ephemeral container per execution. The driver uses `docker run`/`podman run` with `--rm --pull=never --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 2g --cpus 2`, a tmpfs `/tmp`, the fresh workspace bind-mounted read-write (its only writable path), and tool-controlled toolchain mounts read-only. No host environment is forwarded (only `LANG`/`HOME` plus the spec's explicit additions), no container-engine socket or credential path is mounted, and the image entrypoint is replaced so argv semantics are explicit. A unique `--cidfile` plus `rm -f` cleanup runs after success, validation errors, timeouts, and interruptions; the runtime CLI itself is killed by the process-group timeout. Strict mode requires a usable runtime (daemon probe, not just a binary) AND an explicit image (`--sandbox-image` / `CTRANS_SANDBOX_IMAGE`) with the validation toolchain; pulls are disabled, so a missing image is a hard `container-error`/refusal, never a host fallback. gVisor is optional: `CTRANS_SANDBOX_GVISOR=1` adds `--runtime runsc` only when the `runsc` probe succeeded; requesting it when unavailable refuses the run, and doctor never reports it active unless detected.

**Never:** `shell:true` with interpolated input; execution of `pre/post` lifecycle scripts from generated manifests; `pip install`/`npm install` of the *translated* project during validation without explicit `--consent-install`; execution outside the runner API (unit tests included); container image pulls during validation (`--pull=never`); mounting the container-engine socket, host credentials, or unrelated host paths.

## 4. Secrets and keys

- Embedded secret scanning (secretlint rules, MIT) before any AI request and optionally on input projects (`--scan-secrets`): findings block the request with a report. **Implemented (M8):** the gate (`packages/ai/src/secret-gate.ts`) scans the exact outgoing payload with `@secretlint/core` + the recommended preset; a finding, a scanner exception, or an empty rule set BLOCKS the call (fail-closed, never bypassed), and journal entries record rule ids/locations only — never matching text.
- Key storage (M11): resolution order is `CTRANS_AI_KEY` (CI/explicit) → OS keychain (macOS `security`, Linux `secret-tool`) → `~/.config/ctrans/keys.json` at 0600 with a warning. The file path must be a regular file (symlinks rejected), owner-only permissions are enforced (0644+ is ignored with a warning), size is capped, and malformed entries are ignored without echoing values. Keychain commands are bounded (3 s), use an argv/env allowlist, and never log their output. Windows Credential Manager retrieval is not implemented (documented limitation; the 0600 file fallback remains). Keys never enter flags, configuration files (secret-bearing keys are rejected), logs, journals, or cache keys. Evidence: `apps/cli/test/keys.test.ts`.
- Cross-run AI cache (M11): **opt-in** (`--ai-cache disk` / `ai.cache: "disk"`), because cached model output may contain code-derived text. Placement is per-user (`$XDG_CACHE_HOME/ctrans/responses` or `~/.cache/...`), the root must be a real directory (symlinks refused), directory mode is 0700 and files 0600, file names are sha256 hex keys, reads reject symlinks/oversized/malformed values, and writes are atomic (`O_EXCL` temp + rename) with oldest-first pruning beyond 2000 entries. The in-memory cache remains the default. Cache contents are never prompts or credentials; see `packages/ai/test/disk-cache.test.ts`.
- Logs/reports/ledger never contain key material, source contents, or absolute paths outside the project root.
- **Repair journal (M9):** `.ctrans/repairs/repairs.json` at a FIXED path (unit ids are never used as path segments, so traversal is impossible by construction; the writer additionally containment-checks against the output root, creates the directory, and writes mode 0600). It is hash-only provenance: unit/target path, attempt number, failure code/category, baseline/candidate state hashes, patch hash, proposal outcome, decision + bounded reason, stage snapshot, provider/model names, token counts, and secret-rule ids. Diffs, prompts, model responses, and source text are never written. The loader tolerates malformed/partial files (unreadable data is preserved as `repairs.corrupt.json` and recovery is reported), and a write failure raises a typed error instead of being presented as a successful repair. Journal write failures never silently discard acceptance state: the CLI exits non-zero with the error.

## 5. Generated project policy

- The translator **never** runs install commands; it writes manifests only. Validation installs happen solely with `--consent-install`, inside the sandbox, from a generated lockfile the user can inspect first.
- Generated `package.json`/`pyproject.toml` contain no postinstall hooks; `ctransUnmapped` lists anything the registry couldn't map (nothing silently dropped).

## 6. Input handling caps

Defaults (configurable, never unlimited): 25k files/project, 5 MB/file, 400 MB/project, parse depth limit, bridge subprocess memory cap. Exceeding caps is a reported skip, not a crash or a truncated translation.

## 7. Responsible AI usage summary

Provider-agnostic adapters; no provider SDK coupling; code-as-data; outputs are option-choices or validated, unit-scoped patches (grammar + scope + policy guarded, then re-validated by the engine); caps in code; prompts journaled by hash, repair history by state/patch hash; no test/config edits through repair; deterministic CI never calls providers. OWASP LLM v2 mapping table lives in [ai-architecture.md](ai-architecture.md) §4.
