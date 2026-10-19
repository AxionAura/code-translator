// Capability detection (docs/security.md §3): probe the isolation tools once per
// runner construction and report honestly what is enforced, degraded, or absent.
// The report is data, not prose — validation stages embed it in their results.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface SandboxCapabilities {
  // bubblewrap: enforces unshare-net/unshare-pid (network + PID isolation).
  readonly bwrap: ToolCapability;
  // prlimit: CPU/address-space/process-count rlimits around the child.
  readonly prlimit: ToolCapability;
  // Honest summary: "enforced" only when bwrap is usable; "policy-only" means
  // no enforced network isolation (static hints + caller policy still apply).
  readonly networkIsolation: "enforced" | "policy-only";
}

export interface ToolCapability {
  readonly available: boolean;
  readonly version: string | null;
  // Why the tool is unavailable (probing failure reason) — null when available.
  readonly unavailableReason: string | null;
}

// Probe a tool by running `<path> --version` with a short timeout. Probing runs
// the tool binary itself — never project code.
async function probeTool(path: string): Promise<ToolCapability> {
  const probeDir = mkdtempSync(join(tmpdir(), "ctrans-probe-"));
  try {
    const { stdout } = await execFileP(path, ["--version"], {
      cwd: probeDir,
      timeout: 5000,
      env: { PATH: process.env["PATH"] ?? "" },
    });
    return {
      available: true,
      version: stdout.trim().split("\n")[0] || null,
      unavailableReason: null,
    };
  } catch (error) {
    const code = (error as { code?: string }).code;
    return {
      available: false,
      version: null,
      unavailableReason:
        code === "ENOENT" ? `${path} not found` : `${path} probe failed (${String(code)})`,
    };
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

// A probe bwrap run that actually exercises the unshare-net profile — version
// presence alone does not prove unprivileged user namespaces are enabled.
async function probeBwrapUnshare(
  bwrapPath: string,
): Promise<{ available: boolean; reason: string | null }> {
  const probeDir = mkdtempSync(join(tmpdir(), "ctrans-bwrap-probe-"));
  try {
    await execFileP(
      bwrapPath,
      [
        "--unshare-net",
        "--unshare-pid",
        "--die-with-parent",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
        "--",
        "true",
      ],
      { cwd: probeDir, timeout: 10000 },
    );
    return { available: true, reason: null };
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    return {
      available: false,
      reason:
        code === 1
          ? "bwrap unshare profile failed (unprivileged user namespaces likely disabled)"
          : `bwrap unshare probe failed (${String(code)})`,
    };
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

export async function detectCapabilities(
  bwrapPath = "bwrap",
  prlimitPath = "prlimit",
): Promise<SandboxCapabilities> {
  const [bwrap, prlimit] = await Promise.all([probeTool(bwrapPath), probeTool(prlimitPath)]);
  if (bwrap.available) {
    const usable = await probeBwrapUnshare(bwrapPath);
    if (!usable.available) {
      return {
        bwrap: { available: false, version: bwrap.version, unavailableReason: usable.reason },
        prlimit,
        networkIsolation: "policy-only",
      };
    }
    return { bwrap, prlimit, networkIsolation: "enforced" };
  }
  return { bwrap, prlimit, networkIsolation: "policy-only" };
}
