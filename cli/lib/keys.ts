import { resolve } from "@std/path";
import { INSTANCE_NAME_PATTERN } from "./constants.ts";
import { pubKeyPath, sshDir, writeFileAtomic } from "./ssh.ts";

// ==============================================================================
// SSH 公開鍵の管理
//
// 鍵の真実は keys.json（メタ情報付き store）に置き、コンテナへ渡す
// authorized_keys 束ファイルは「自動生成鍵 + store の追加鍵」から毎回再生成する。
// 束ファイルは CLOOPY_PUBKEY_PATH 経由で /etc/cloopy/authorized_keys に
// :ro ステージされ、init-ssh-keys が毎起動コピーする（Docker 側変更なし）。
//
// store / 束はインスタンスごとに ~/.ssh/cloopy/instances/<名前>/ へ分離する
// （自動生成鍵 id_ed25519 は CLI 自身の接続性の生命線なので全インスタンス共有）。
// 旧グローバル store (~/.ssh/cloopy/keys.json) は初回アクセス時にインスタンス側へ
// コピー移行する。レガシーは残置 — 別チェックアウトの他インスタンスも同じ
// ファイルから移行するため、最初の 1 つが消すと残りの鍵が黙って失われる。
// ==============================================================================

/**
 * Get the per-instance key directory (~/.ssh/cloopy/instances/<name>).
 * The name is re-validated here even though setup validates its prompt input:
 * a hand-edited .env can carry any string (e.g. "../../evil"), and resolve()
 * would happily walk out of the instances tree with it.
 */
export function instanceKeysDir(instanceName: string): string {
  if (!INSTANCE_NAME_PATTERN.test(instanceName)) {
    throw new Error(
      `インスタンス名が不正です: "${instanceName}" ` +
        `(.env の CLOOPY_INSTANCE_NAME を確認するか、再 setup してください)`,
    );
  }
  return resolve(sshDir(), "instances", instanceName);
}

/** Get the managed authorized_keys bundle path for an instance */
export function authorizedKeysPath(instanceName: string): string {
  return resolve(instanceKeysDir(instanceName), "authorized_keys");
}

/** Get the key metadata store path for an instance */
export function keyStorePath(instanceName: string): string {
  return resolve(instanceKeysDir(instanceName), "keys.json");
}

/** Pre-separation global store path (migration source only) */
function legacyKeyStorePath(): string {
  return resolve(sshDir(), "keys.json");
}

/** A validated OpenSSH public key, split into its three fields. */
export interface ParsedKey {
  type: string;
  base64: string;
  comment: string;
  /** RSA modulus size in bits (undefined for non-RSA keys) */
  rsaBits?: number;
}

/** A key in the metadata store (extra keys only — the auto key is never stored). */
export interface StoredKey {
  type: string;
  base64: string;
  /** Original comment from the key line ("" if none) */
  comment: string;
  /** Origin label, e.g. "github:octocat" ("" if none) */
  label: string;
  /** ISO 8601 timestamp */
  addedAt: string;
}

export interface KeyStore {
  version: 1;
  keys: StoredKey[];
}

export type ParseResult =
  | { ok: true; key: ParsedKey }
  | { ok: false; error: string };

/**
 * Key types accepted for authorized_keys. ssh-dss (DSA) is deliberately
 * excluded (deprecated; GitHub dropped it in 2022). Lines with options
 * (`command="..." ssh-...`) are rejected too — the CLI only manages plain keys.
 */
const KEY_TYPES = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
]);

/** Minimum RSA modulus size before we warn the user. */
export const RSA_MIN_BITS = 2048;

function decodeBase64(b64: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function readUint32(buf: Uint8Array, off: number): number {
  return (
    ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) |
      buf[off + 3]) >>> 0
  );
}

/** Read the RSA modulus size from a decoded ssh-rsa blob (algo, e, n mpints). */
function rsaModulusBits(blob: Uint8Array): number | undefined {
  let off = 0;
  const readField = (): Uint8Array | null => {
    if (off + 4 > blob.length) return null;
    const len = readUint32(blob, off);
    off += 4;
    if (len > blob.length - off) return null;
    const v = blob.subarray(off, off + len);
    off += len;
    return v;
  };
  if (readField() === null) return undefined; // algorithm name
  if (readField() === null) return undefined; // public exponent e
  const n = readField(); // modulus n
  if (n === null) return undefined;
  let i = 0;
  while (i < n.length && n[i] === 0) i++;
  if (i === n.length) return 0;
  return (n.length - i - 1) * 8 + (32 - Math.clz32(n[i]));
}

/**
 * Parse and validate one OpenSSH public key line.
 * Beyond the type whitelist, the base64 blob is decoded and its embedded
 * algorithm name must match the line's type prefix (catches truncated or
 * mislabeled keys that sshd would silently ignore at login time).
 */
export function parsePublicKey(line: string): ParseResult {
  const trimmed = line.replace(/\r/g, "").trim();
  if (!trimmed) return { ok: false, error: "公開鍵を入力してください" };

  const parts = trimmed.split(/\s+/);
  const [type, base64, ...commentParts] = parts;

  if (type === "ssh-dss") {
    return {
      ok: false,
      error: "ssh-dss (DSA) は廃止された鍵種別のため追加できません",
    };
  }
  if (!KEY_TYPES.has(type)) {
    return {
      ok: false,
      error:
        `未対応の鍵種別です: ${type} (対応: ed25519 / rsa / ecdsa / sk-*。` +
        `options 付きの行は追加できません)`,
    };
  }
  if (!base64) {
    return { ok: false, error: "鍵データ (base64) がありません" };
  }

  const blob = decodeBase64(base64);
  if (blob === null) {
    return { ok: false, error: "鍵データが base64 として解読できません" };
  }
  if (blob.length < 4) {
    return { ok: false, error: "鍵データが短すぎます (破損の可能性)" };
  }
  const algoLen = readUint32(blob, 0);
  if (algoLen === 0 || algoLen > 64 || 4 + algoLen > blob.length) {
    return { ok: false, error: "鍵データの形式が不正です (破損の可能性)" };
  }
  const algo = new TextDecoder().decode(blob.subarray(4, 4 + algoLen));
  if (algo !== type) {
    return {
      ok: false,
      error: `鍵種別と鍵データが一致しません (${type} と ${algo})`,
    };
  }

  const key: ParsedKey = {
    type,
    base64,
    comment: commentParts.join(" "),
  };
  if (type === "ssh-rsa") key.rsaBits = rsaModulusBits(blob);
  return { ok: true, key };
}

/** Prompt-friendly validator: true or a Japanese error message. */
export function validatePublicKeyInput(s: string): boolean | string {
  const r = parsePublicKey(s);
  return r.ok ? true : r.error;
}

/** Two keys are the same key iff type and key material match (comment ignored). */
export function isSameKey(
  a: { type: string; base64: string },
  b: { type: string; base64: string },
): boolean {
  return a.type === b.type && a.base64 === b.base64;
}

/** OpenSSH-style SHA256 fingerprint (`SHA256:` + unpadded base64 of the blob hash). */
export async function fingerprintSha256(base64: string): Promise<string> {
  const blob = decodeBase64(base64);
  if (blob === null) throw new Error("invalid base64 key material");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", blob.buffer as ArrayBuffer),
  );
  let bin = "";
  for (const b of digest) bin += String.fromCharCode(b);
  return "SHA256:" + btoa(bin).replace(/=+$/, "");
}

/** Parse and validate a key store JSON text (path is for error messages). */
function parseKeyStore(raw: string, path: string): KeyStore {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `鍵 store (${path}) が JSON として読めません。` +
        `修復するか削除してから再実行してください`,
    );
  }
  const store = data as KeyStore;
  if (
    store === null || typeof store !== "object" || store.version !== 1 ||
    !Array.isArray(store.keys) ||
    !store.keys.every((k) =>
      k !== null && typeof k === "object" &&
      typeof k.type === "string" && typeof k.base64 === "string"
    )
  ) {
    throw new Error(
      `鍵 store (${path}) の形式が不正です。` +
        `修復するか削除してから再実行してください`,
    );
  }
  for (const k of store.keys) {
    k.comment = typeof k.comment === "string" ? k.comment : "";
    k.label = typeof k.label === "string" ? k.label : "";
    k.addedAt = typeof k.addedAt === "string" ? k.addedAt : "";
  }
  return store;
}

/**
 * Load an instance's key store. A missing file is an empty store; a corrupt
 * file is an ERROR (never silently treated as empty — that would drop the
 * user's keys from the next bundle rebuild).
 *
 * If the instance store does not exist but the pre-separation global store
 * does, the global store is copied into the instance directory (one-time
 * migration; the legacy file is left in place for other instances).
 */
export function loadKeyStore(instanceName: string): KeyStore {
  const path = keyStorePath(instanceName);
  let raw: string;
  try {
    raw = Deno.readTextFileSync(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    let legacyRaw: string;
    try {
      legacyRaw = Deno.readTextFileSync(legacyKeyStorePath());
    } catch (le) {
      if (le instanceof Deno.errors.NotFound) return { version: 1, keys: [] };
      throw le;
    }
    const migrated = parseKeyStore(legacyRaw, legacyKeyStorePath());
    saveKeyStore(instanceName, migrated);
    return migrated;
  }
  return parseKeyStore(raw, path);
}

/** Save an instance's key store (atomic, 0600). */
export function saveKeyStore(instanceName: string, store: KeyStore): void {
  // 0700: ~/.ssh 慣習に合わせ、インスタンス名の列挙も他ユーザーに許さない
  Deno.mkdirSync(instanceKeysDir(instanceName), {
    recursive: true,
    mode: 0o700,
  });
  writeFileAtomic(
    keyStorePath(instanceName),
    JSON.stringify(store, null, 2) + "\n",
  );
}

/**
 * Build the authorized_keys bundle content. Pure — exported for tests.
 * The auto-generated key always comes first (it is cloopy's own connectivity
 * guarantee); extra keys follow with their origin label as the comment.
 */
export function buildAuthorizedKeysContent(
  autoKeyLine: string,
  keys: StoredKey[],
): string {
  const lines = [
    "# Managed by cloopy (manage.sh). Do not edit - regenerated from keys.json.",
    autoKeyLine.trim(),
  ];
  for (const k of keys) {
    const comment = k.label || k.comment;
    lines.push(`${k.type} ${k.base64}${comment ? ` ${comment}` : ""}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Regenerate an instance's authorized_keys bundle from the auto-generated
 * public key plus the given extra keys (defaults to the instance's store
 * contents). The container boot (init-ssh-keys) refuses an empty staged file,
 * so this throws rather than write a bundle without the auto key.
 */
export function rebuildAuthorizedKeys(
  instanceName: string,
  keys?: StoredKey[],
): number {
  const extra = keys ?? loadKeyStore(instanceName).keys;
  let autoKey: string;
  try {
    autoKey = Deno.readTextFileSync(pubKeyPath()).trim();
  } catch {
    throw new Error(
      `自動生成鍵 (${pubKeyPath()}) が見つかりません。先に setup を実行してください`,
    );
  }
  if (!autoKey) {
    throw new Error(
      `自動生成鍵 (${pubKeyPath()}) が空です。先に setup を実行してください`,
    );
  }
  Deno.mkdirSync(instanceKeysDir(instanceName), {
    recursive: true,
    mode: 0o700,
  });
  writeFileAtomic(
    authorizedKeysPath(instanceName),
    buildAuthorizedKeysContent(autoKey, extra),
  );
  return extra.length;
}

// ==============================================================================
// GitHub .keys 取得
// ==============================================================================

/**
 * GitHub username syntax: alphanumeric + single hyphens, no leading/trailing
 * hyphen, max 39 chars. Validated so the CLI-built URL can't be steered
 * anywhere but https://github.com/<user>.keys.
 */
export function validateGithubUsername(name: string): boolean {
  return /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/.test(name);
}

/** Parse a .keys response body: one key per line, blank lines skipped. */
export function parseKeysText(
  text: string,
): { keys: ParsedKey[]; invalid: string[] } {
  const keys: ParsedKey[] = [];
  const invalid: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const r = parsePublicKey(t);
    if (r.ok) keys.push(r.key);
    else invalid.push(t);
  }
  return { keys, invalid };
}

export type GithubKeysResult =
  | { status: "ok"; keys: ParsedKey[]; invalid: string[] }
  | { status: "not_found" }
  | { status: "empty" }
  | { status: "error"; message: string };

/**
 * Fetch a user's public keys from https://github.com/<user>.keys.
 * HTTPS only, URL built by the CLI (the username is validated, never a URL).
 * 404 = user does not exist; 200 with empty body = user has no keys.
 */
export async function fetchGithubKeys(
  username: string,
  fetchFn: typeof fetch = fetch,
): Promise<GithubKeysResult> {
  if (!validateGithubUsername(username)) {
    return { status: "error", message: "GitHub ユーザー名の形式が不正です" };
  }
  const url = `https://github.com/${username}.keys`;
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch (e) {
    return {
      status: "error",
      message: `取得に失敗しました (ネットワークエラー): ${e}`,
    };
  }
  if (res.status === 404) {
    await res.body?.cancel();
    return { status: "not_found" };
  }
  if (!res.ok) {
    await res.body?.cancel();
    return {
      status: "error",
      message: `取得に失敗しました (HTTP ${res.status})`,
    };
  }
  const text = await res.text();
  const { keys, invalid } = parseKeysText(text);
  if (keys.length === 0 && invalid.length === 0) return { status: "empty" };
  return { status: "ok", keys, invalid };
}
