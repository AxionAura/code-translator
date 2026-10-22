// Least-privilege bubblewrap filesystem profile (pre-release security gate): do NOT
// bind the host root. Only the runtime system trees required to execute trusted
// toolchain binaries, a minimal read-only /etc subset, /dev, /proc, a writable
// tmpfs /tmp, the declared sandbox workspace, toolchain mounts, and the executable
// directory are visible. User home directories, SSH keys, the rest of /etc, /var,
// /root, and unrelated project data are not mounted.
import { existsSync } from "node:fs";

const READONLY_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32"] as const;

// World-readable runtime configuration needed by the dynamic loader and by
// Python/Node identity lookups. Machine-specific secret files (ssh keys, shadow,
// sudoers, certificate private keys, etc.) and host service configuration are
// deliberately absent; the network is unshared, so no CA store is mounted.
const READONLY_FILES = [
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/passwd",
  "/etc/group",
  "/etc/nsswitch.conf",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/localtime",
] as const;

export function bwrapSystemMountArgs(): readonly string[] {
  const args: string[] = [];
  for (const path of READONLY_DIRS) {
    if (existsSync(path)) args.push("--ro-bind", path, path);
  }
  for (const path of READONLY_FILES) {
    if (existsSync(path)) args.push("--ro-bind", path, path);
  }
  return args;
}

// Toolchain and executable paths are tool-controlled (never user input): they are
// always bound read-only. The workspace is the only writable host path; writable
// container mounts are rejected by SandboxRunner's spec validation.
export function bwrapMountArgs(mounts: readonly { readonly path: string }[]): readonly string[] {
  const args: string[] = [];
  for (const mount of mounts) {
    if (!existsSync(mount.path)) continue;
    args.push("--ro-bind", mount.path, mount.path);
  }
  return args;
}
