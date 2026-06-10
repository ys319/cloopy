import { basename, dirname, resolve } from "@std/path";

// docker-compose.yml はワークスペースを `z` フラグ付きで bind mount する。
// SELinux ホスト（Fedora CoreOS / uCore 等）では docker がマウント元ツリー
// 全体を container_file_t に再帰リラベルするため、$HOME やシステム
// ディレクトリを指定するとホスト側が壊れる — 特に ~/.ssh が ssh_home_t を
// 失うとホストへの SSH ログイン自体が不能になる。SELinux のないホストでも
// これらをワークスペースにする正当な理由はないので、一律で拒否する。
const FORBIDDEN_PATHS = new Set([
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/media",
  "/mnt",
  "/opt",
  "/proc",
  "/root",
  "/run",
  "/srv",
  "/sys",
  "/tmp",
  "/usr",
  "/var",
  "/var/home",
  "/var/lib",
  "/var/log",
]);

/**
 * Resolve symlinks in a path. If the path itself does not exist yet, resolve
 * the nearest existing ancestor and re-append the remainder, so a workspace
 * that will be created later is still checked against its real location.
 * Falls back to the input unchanged if nothing up to the root exists.
 */
function toRealPath(path: string): string {
  const suffix: string[] = [];
  let current = path;
  while (true) {
    try {
      const real = Deno.realPathSync(current);
      return suffix.length ? resolve(real, ...suffix) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Validate a workspace host path for the bind mount.
 * Returns true if safe, or a Japanese error message for the prompt.
 * Checks both the literal path and its symlink-resolved form — e.g. on
 * Fedora CoreOS / uCore, /home is a symlink to /var/home, so "/home/core"
 * would otherwise slip past the $HOME comparison.
 */
export function validateWorkspacePath(input: string): boolean | string {
  const raw = input.trim();
  if (!raw) return "パスを入力してください";
  // Windows paths don't hit the SELinux relabel (Docker Desktop) — skip.
  if (Deno.build.os === "windows") return true;

  const home = Deno.env.get("HOME") ?? "";
  const expanded = raw === "~"
    ? home
    : raw.startsWith("~/")
    ? resolve(home, raw.slice(2))
    : raw;
  const path = resolve(expanded);
  const candidates = new Set([path, toRealPath(path)]);
  const homes = home
    ? new Set([resolve(home), toRealPath(resolve(home))])
    : new Set<string>();

  for (const p of candidates) {
    if (FORBIDDEN_PATHS.has(p)) {
      return `システムディレクトリは指定できません (${p})`;
    }
    for (const h of homes) {
      if (p === h || h.startsWith(p + "/")) {
        return "ホームディレクトリ全体（やその親）は指定できません。" +
          "SELinux ホストでは :z リラベルで ~/.ssh が壊れ、ホストに SSH できなくなります";
      }
      const sshDir = resolve(h, ".ssh");
      if (p === sshDir || p.startsWith(sshDir + "/")) {
        return "~/.ssh 配下は指定できません";
      }
    }
  }
  return true;
}
