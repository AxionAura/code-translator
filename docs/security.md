# Security

Status: **approved blueprint**. Local-first; user code is untrusted; execution is the only high-risk operation and is always sandboxed.

## 1. Trust boundaries and threats

| Threat | Vector | Mitigation |
| --- | --- | --- |
| T1 Malicious source project | crafted code/comments parsed or executed | parsing never executes (§2); execution only in sandbox (§3); size caps; path confinement |
| T2 Malicious translated output | generated code run by user later | honest reporting of unsupported constructs; no fabricated code; provenance headers |
| T3 Source exfiltration | AI provider calls | local-first default; secret-scan hard gate; no telemetry; journaling stores hashes not content by default |
| T4 Prompt injection via code | comments/docstrings instructing the model | code-as-data delimiting (per-request nonce), option-choice/patch-only outputs, no tool use, output re-validated (ai-architecture.md §4) |
| T5 API key theft | config files, logs, repo | keychain-first storage, 0600 fallback + warning, keys banned from config/logs/reports/git |
| T6 Supply chain | our npm deps; lifecycle scripts | lockfile pinned, pnpm script-block on, license allowlist, no trufflehog-style AGPL embedding, provenance noted as insufficient alone (2026-05-19 bypass) |
| T7 Sandbox escape / resource abuse | translated code consuming CPU/mem/net | hardened spawn + optional bwrap/docker (§3); timeouts; output caps; no network by default |
| T8 Path traversal / file bombs | input archives, deep trees | output confined to declared out-dir; entry count/size caps; symlink policy (no following out-of-root) |
| T9 Model cost abuse (self-DoS) | repair loops | hard caps per run (calls/tokens/USD/wall-clock); loop detection |

## 2. Translation path (no execution)

- Parsing uses: CPython stdlib `ast`/`symtable`/`tokenize` (syntax only — the bridge never imports user modules) and oxc/tsc (in-process, memory-safe, no eval).
- The Python bridge (`packages/parser-py/python/bridge.py`) is spawned one-shot per parse as `python3 -I -B` with a whitelisted environment: source arrives as raw bytes on stdin, results leave as one JSON envelope on stdout. `-I` (isolated mode) keeps `PYTHON*` env, user site-packages, and the caller's cwd off the import path, so a malicious `.py` cannot escalate through parsing — verified by hostile-input tests that prove module-level side effects, decorators, and default values never execute (packages/parser-py/README.md).
- Installed dependency of the tool = trusted code; user project = untrusted data. The two never share a process except through the sandbox runner.

## 3. Sandbox design (`@ctrans/sandbox`)

**Baseline (always, no privileges):**
- `child_process.spawn` with argv arrays (`shell:false`), explicit env whitelist (`PATH`, `HOME`=temp, `LANG`, plus runtime-specific minimals), `cwd` = temp copy of the minimum file set, `stdio` piped with size caps, wall-clock timeout + SIGKILL, no TTY.
- Resource limits via `prlimit` wrapper when present (CPU seconds, address space, file size, nproc); otherwise limits degrade to timeout-only — **recorded in capability report**.
- No network at baseline: tests known/likely to require network are flagged (static hints) and skipped in default mode.

**Isolation layer (auto-detected, opt-in via `sandbox: "auto"`):**
- **bubblewrap**: `--unshare-net --unshare-pid --die-with-parent --ro-bind / / --bind tmpfs /tmp` style profile; degrades gracefully (capability probe) where unprivileged user namespaces are disabled.
- **Docker/Podman strict mode** (`sandbox: "strict"`): ephemeral container per run, no network, read-only rootfs + tmpfs workdir, cgroup caps; gVisor `runsc` used if configured. Requires daemon; refusal to run unsandboxed execution when `strict` is requested and unavailable — it errors, it does not silently downgrade.

**Never:** `shell:true` with interpolated input; execution of `pre/post` lifecycle scripts from generated manifests; `pip install`/`npm install` of the *translated* project during validation without explicit `--consent-install`; execution outside the runner API (unit tests included).

## 4. Secrets and keys

- Embedded secret scanning (secretlint rules, MIT) before any AI request and optionally on input projects (`--scan-secrets`): findings block the request with a report.
- Key storage: OS keychain via CLI shelling (macOS `security`, Linux `secret-tool`, Windows CredMan) → fallback `~/.config/ctrans/keys.json` at 0600 with a warning banner, mirroring the gh CLI model. Env-var reference (`CTRANS_OPENAI_KEY`) supported for CI.
- Logs/reports/ledger never contain key material, source contents, or absolute paths outside the project root.

## 5. Generated project policy

- The translator **never** runs install commands; it writes manifests only. Validation installs happen solely with `--consent-install`, inside the sandbox, from a generated lockfile the user can inspect first.
- Generated `package.json`/`pyproject.toml` contain no postinstall hooks; `ctransUnmapped` lists anything the registry couldn't map (nothing silently dropped).

## 6. Input handling caps

Defaults (configurable, never unlimited): 25k files/project, 5 MB/file, 400 MB/project, parse depth limit, bridge subprocess memory cap. Exceeding caps is a reported skip, not a crash or a truncated translation.

## 7. Responsible AI usage summary

Provider-agnostic adapters; no provider SDK coupling; code-as-data; outputs are option-choices or validated patches; caps in code; prompts journaled by hash; deterministic CI never calls providers. OWASP LLM v2 mapping table lives in [ai-architecture.md](ai-architecture.md) §4.
