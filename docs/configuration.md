# Configuration (`ctrans.config.json`)

Status: **implemented (M11)**. Configuration is optional; CLI flags always win.
Schema validation is strict: unknown keys, secret-bearing keys, invalid enums, and
unsafe combinations are rejected with actionable errors instead of being ignored.

## Discovery and precedence

1. `--config <file>` (missing file is an error).
2. `ctrans.config.json` beside the input path (in the directory for a directory, in
   the parent directory for a single file).
3. `ctrans.config.json` in the current working directory.

Precedence for each setting: **CLI flag > configuration file > built-in default**.
A malformed or unknown configuration aborts the command (exit 1); it never silently
falls back.

## Schema

```json
{
  "$schema": "https://example.invalid/ctrans.config.schema.json",
  "to": "ts",
  "intMode": "number",
  "sandbox": "auto",
  "sandboxImage": "my-ctrans-toolchain:1",
  "smoke": "./smoke.json",
  "format": true,
  "ai": {
    "enabled": true,
    "provider": "openai",
    "model": "gpt-4o-mini",
    "baseUrl": "http://127.0.0.1:11434/v1",
    "cache": "memory"
  }
}
```

| Key | Values | Notes |
| --- | --- | --- |
| `to` | `"ts"`, `"js"`, `"py"` | Target language; `--to` overrides |
| `intMode` | `"number"`, `"bigint"` | D-006 integer policy |
| `sandbox` | `"auto"`, `"strict"` | `strict` requires a container runtime + image |
| `sandboxImage` | image reference | Only with `sandbox: "strict"`; pulls are disabled |
| `smoke` | path | Resolved relative to the config file; S7 opt-in |
| `format` | `true` | `false` is rejected (output is always canonicalized) |
| `ai.enabled` | boolean | `true` requires `ai.provider`; `false` forbids provider/model/baseUrl |
| `ai.provider` | `"openai"`, `"anthropic"` | OpenAI-compatible includes local endpoints via `baseUrl` |
| `ai.model` | string | Defaults per provider |
| `ai.baseUrl` | http(s) URL | Credentials in URLs are rejected |
| `ai.cache` | `"memory"`, `"disk"` | `disk` is opt-in (cached model text may contain code) |
| `$schema` | string | Editor hint, ignored by the engine |

**Credentials are never configuration.** Any `key`, `token`, `secret`, `password`,
or `apiKey` field is rejected with `CONFIG-UNSAFE-KEY`. Keys come from
`CTRANS_AI_KEY`, the OS keychain, or a 0600 `~/.config/ctrans/keys.json` file (see
[security.md](security.md) §4).

## Examples

```bash
# Project defaults, no flags:
ctrans project src/ -o out        # reads src/ctrans.config.json

# CLI overrides the file:
ctrans check src/app.py --to js

# Strict container validation:
ctrans project src/ -o out --strict --sandbox-image my-toolchain:1
```

`ctrans validate` reads the same file for `sandbox`, `sandboxImage`, and `smoke`;
it detects the target language from the directory contents.
