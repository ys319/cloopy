import { resolve } from "@std/path";
import { knownHostsDir, sshDir, writeFileAtomic } from "./ssh.ts";

/**
 * A remote cloopy connection profile. The store is the source of truth;
 * the SSH config Host block and the per-remote known_hosts file are
 * regenerated from it (same design as keys.json / authorized_keys).
 */
export interface RemoteProfile {
  /** SSH Host alias (also the known_hosts.d file name) */
  name: string;
  /** Remote host (IP or DNS name) */
  hostName: string;
  /** SSH port as string */
  port: string;
  /** IdentityFile path; "" = omitted (ssh agent / default keys) */
  identityFile: string;
  addedAt: string;
}

export interface RemoteStore {
  version: 1;
  remotes: RemoteProfile[];
}

/** Path to the remote profile store (~/.ssh/cloopy/remotes.json) */
export function remoteStorePath(): string {
  return resolve(sshDir(), "remotes.json");
}

/** Per-remote known_hosts file (~/.ssh/cloopy/known_hosts.d/<name>) */
export function remoteKnownHostsPath(name: string): string {
  return resolve(knownHostsDir(), name);
}

/**
 * Load the remote store. A missing file is an empty store; a corrupt file is
 * an ERROR (never silently treated as empty — a rebuild from "empty" would
 * orphan the user's existing entries).
 */
export function loadRemoteStore(): RemoteStore {
  let raw: string;
  try {
    raw = Deno.readTextFileSync(remoteStorePath());
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return { version: 1, remotes: [] };
    throw e;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `リモート接続 store (${remoteStorePath()}) が JSON として読めません。` +
        `修復するか削除してから再実行してください`,
    );
  }
  const store = data as RemoteStore;
  // name は known_hosts.d のファイル名・SSH config のブロック名・ssh の
  // 引数へ、hostName/port は config 行へ流れる。手編集された store 経由の
  // パストラバーサル ("../") やオプション注入 ("-o...") を入口で潰すため、
  // 入力時と同じバリデータを load 時にも再適用する。
  if (
    store === null || typeof store !== "object" || store.version !== 1 ||
    !Array.isArray(store.remotes) ||
    !store.remotes.every((r) =>
      r !== null && typeof r === "object" &&
      // バリデータは trim 後を検査するので、raw 値との一致も要求して
      // 前後空白がそのまま config 行へ流れるのを防ぐ
      typeof r.name === "string" && r.name === r.name.trim() &&
      validateRemoteName(r.name) === true &&
      typeof r.hostName === "string" && r.hostName === r.hostName.trim() &&
      validateRemoteHost(r.hostName) === true &&
      typeof r.port === "string" && r.port === r.port.trim() &&
      validateRemotePort(r.port) === true
    )
  ) {
    throw new Error(
      `リモート接続 store (${remoteStorePath()}) の形式が不正です。` +
        `修復するか削除してから再実行してください`,
    );
  }
  for (const r of store.remotes) {
    r.identityFile = typeof r.identityFile === "string" ? r.identityFile : "";
    r.addedAt = typeof r.addedAt === "string" ? r.addedAt : "";
  }
  return store;
}

/** Save the remote store (atomic, 0600). */
export function saveRemoteStore(store: RemoteStore): void {
  Deno.mkdirSync(sshDir(), { recursive: true });
  writeFileAtomic(remoteStorePath(), JSON.stringify(store, null, 2) + "\n");
}

/**
 * Validate a remote entry name. Doubles as the known_hosts.d file name, so
 * the charset is restricted to path-safe characters (same rule as instance
 * names — they share the SSH Host namespace).
 */
export function validateRemoteName(name: string): boolean | string {
  const t = name.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(t)) {
    return "英字で始まり、英数字・ハイフン・アンダースコアのみ使用できます";
  }
  if (t.length > 64) return "64 文字以内で入力してください";
  return true;
}

/**
 * Validate a remote host (IP or DNS name; bare IPv6 literals allowed).
 * Whitespace and `#` would corrupt the generated SSH config line.
 */
export function validateRemoteHost(host: string): boolean | string {
  const t = host.trim();
  if (!t) return "ホスト名または IP アドレスを入力してください";
  if (!/^[A-Za-z0-9._:-]+$/.test(t)) {
    return "ホスト名に使用できない文字が含まれています";
  }
  if (t.length > 253) return "ホスト名が長すぎます";
  return true;
}

/** Validate an SSH port string (1-65535). */
export function validateRemotePort(s: string): boolean | string {
  const n = Number(s.trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return "1〜65535 の整数を入力してください";
  }
  return true;
}

export interface ScannedHostKey {
  type: string;
  base64: string;
}

/**
 * Parse ssh-keyscan stdout into host key entries. Lines are
 * `<host> <type> <base64>` (host is hashed under -H); comments and
 * malformed lines are skipped. Pure — exported for tests.
 */
export function parseKeyscanOutput(
  text: string,
): { lines: string[]; keys: ScannedHostKey[] } {
  const lines: string[] = [];
  const keys: ScannedHostKey[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 3) continue;
    lines.push(line);
    keys.push({ type: fields[1], base64: fields[2] });
  }
  return { lines, keys };
}

export type ScanResult =
  | { ok: true; lines: string[]; keys: ScannedHostKey[] }
  | { ok: false; error: string };

/**
 * Fetch a remote host's SSH host keys via ssh-keyscan (-H hashed, same
 * format as the local known_hosts). One attempt with a short timeout —
 * unlike the local refreshKnownHosts there is no "container still booting"
 * race to retry around.
 */
export async function scanRemoteHostKeys(
  host: string,
  port: string,
): Promise<ScanResult> {
  try {
    const cmd = new Deno.Command("ssh-keyscan", {
      args: ["-p", port, "-T", "5", "-H", host],
      stdout: "piped",
      stderr: "null",
    });
    const { code, stdout } = await cmd.output();
    if (code !== 0) {
      return { ok: false, error: `ssh-keyscan が失敗しました (exit ${code})` };
    }
    const { lines, keys } = parseKeyscanOutput(
      new TextDecoder().decode(stdout),
    );
    if (lines.length === 0) {
      return { ok: false, error: "ホスト鍵を取得できませんでした" };
    }
    return { ok: true, lines, keys };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return { ok: false, error: "ssh-keyscan コマンドが見つかりません" };
    }
    return { ok: false, error: String(e) };
  }
}

/** Write a remote entry's known_hosts file (atomic, 0600). */
export function writeRemoteKnownHosts(name: string, lines: string[]): void {
  Deno.mkdirSync(knownHostsDir(), { recursive: true });
  writeFileAtomic(remoteKnownHostsPath(name), lines.join("\n") + "\n");
}

/** Remove a remote entry's known_hosts file (no-op when missing). */
export function removeRemoteKnownHosts(name: string): void {
  try {
    Deno.removeSync(remoteKnownHostsPath(name));
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}
