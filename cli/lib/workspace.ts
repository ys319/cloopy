import { resolve } from "@std/path";

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
 * Validate a workspace host path for the bind mount.
 * Returns true if safe, or a Japanese error message for the prompt.
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

  if (FORBIDDEN_PATHS.has(path)) {
    return `システムディレクトリは指定できません (${path})`;
  }
  if (home) {
    if (path === resolve(home) || resolve(home).startsWith(path + "/")) {
      return "ホームディレクトリ全体（やその親）は指定できません。" +
        "SELinux ホストでは :z リラベルで ~/.ssh が壊れ、ホストに SSH できなくなります";
    }
    const sshDir = resolve(home, ".ssh");
    if (path === sshDir || path.startsWith(sshDir + "/")) {
      return "~/.ssh 配下は指定できません";
    }
  }
  return true;
}
