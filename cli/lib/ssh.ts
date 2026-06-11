import { resolve } from "@std/path";

/** Get the home directory */
function homeDir(): string {
  if (Deno.build.os === "windows") {
    return Deno.env.get("USERPROFILE") ?? "C:\\Users\\Default";
  }
  return Deno.env.get("HOME") ?? "/home";
}

/** Get the cloopy SSH directory (~/.ssh/cloopy/) */
export function sshDir(): string {
  return resolve(homeDir(), ".ssh", "cloopy");
}

/** Get the SSH key path */
export function keyPath(): string {
  return resolve(sshDir(), "id_ed25519");
}

/** Get the public key path */
export function pubKeyPath(): string {
  return resolve(sshDir(), "id_ed25519.pub");
}

/** Get the cloopy SSH config path (~/.ssh/cloopy/config) */
export function sshConfigPath(): string {
  return resolve(sshDir(), "config");
}

/**
 * Get the standard known_hosts path (~/.ssh/known_hosts).
 * Host keys are pinned HERE, not in a cloopy-private file: Claude Desktop's
 * SSH client (a bundled ssh2 implementation) only consults the default
 * known_hosts and ignores UserKnownHostsFile / StrictHostKeyChecking from
 * ~/.ssh/config, with no interactive accept UI — a key it cannot find there
 * fails the connection outright. Lines cloopy writes carry a trailing
 * comment marker (knownHostsMarker) so they can be updated/removed without
 * touching the user's own entries.
 */
export function defaultKnownHostsPath(): string {
  return resolve(homeDir(), ".ssh", "known_hosts");
}

/** Get the main SSH config path (~/.ssh/config) */
export function mainSshConfigPath(): string {
  return resolve(homeDir(), ".ssh", "config");
}

/**
 * Generate SSH key pair if not already present.
 * If only the .pub is missing (partial loss / restored private key), it is
 * re-derived from the private key — otherwise every later step that reads
 * the public key (authorized_keys rebuild) would fail with advice to "run
 * setup", which is exactly the step that failed.
 * Returns true if a new key was generated.
 */
export async function ensureKeyPair(): Promise<boolean> {
  const key = keyPath();
  const pub = pubKeyPath();

  let hasPrivateKey = false;
  try {
    Deno.statSync(key);
    hasPrivateKey = true;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      throw e;
    }
  }

  if (hasPrivateKey) {
    try {
      Deno.statSync(pub);
      console.log("[cloopy] SSH key already exists, skipping");
      return false;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        throw e;
      }
    }
    console.log("[cloopy] 公開鍵が見つからないため秘密鍵から再生成します...");
    // -P "": パスフレーズ付き鍵（通常ありえない）でも対話で固まらず即エラーになる
    const derive = new Deno.Command("ssh-keygen", {
      args: ["-y", "-P", "", "-f", key],
      stdout: "piped",
      stderr: "inherit",
    });
    const { code, stdout } = await derive.output();
    const pubContent = new TextDecoder().decode(stdout).trim();
    if (code !== 0 || !pubContent) {
      throw new Error(
        `公開鍵を再生成できませんでした。秘密鍵 (${key}) が壊れている可能性があります。` +
          `削除して再実行すると新しい鍵ペアを生成します`,
      );
    }
    writeFileAtomic(pub, pubContent + "\n");
    console.log("[cloopy] 公開鍵を再生成しました");
    return false;
  }

  const dir = sshDir();
  Deno.mkdirSync(dir, { recursive: true });

  console.log("[cloopy] Generating SSH key...");
  const cmd = new Deno.Command("ssh-keygen", {
    args: ["-t", "ed25519", "-f", key, "-N", "", "-C", "cloopy"],
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) {
    throw new Error("ssh-keygen failed");
  }

  return true;
}

/** Escape a string for literal use inside a RegExp pattern. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** SSH config needs forward slashes even on Windows. */
function toSshPath(p: string): string {
  return p.replaceAll("\\", "/");
}

/**
 * Write via temp file + rename so a crash mid-write can never leave a
 * truncated file. Both ~/.ssh/config and the Included cloopy config are
 * parsed by EVERY ssh invocation — a torn write there breaks SSH for all
 * hosts, not just cloopy.
 */
export function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp~`;
  try {
    Deno.writeTextFileSync(tmp, content, { mode: 0o600 });
    Deno.renameSync(tmp, path);
  } catch (e) {
    try {
      Deno.removeSync(tmp);
    } catch {
      // best effort cleanup
    }
    throw e;
  }
}

/**
 * Insert or replace the instance's Host block in the cloopy config content.
 * An existing block (from "# --- name ---" to the next "# ---" or EOF) is
 * replaced in place; otherwise the block is appended (with a banner header
 * when the file is new). Pure — exported for tests.
 */
export function upsertHostBlock(
  existing: string,
  instanceName: string,
  hostBlock: string,
): string {
  const name = escapeRegExp(instanceName);
  // Lookahead stops BEFORE the separator newlines / trailing newline so the
  // in-place replace preserves them (a bare `$` would swallow the file's
  // final newline on every update).
  const blockRe = new RegExp(
    `# --- ${name} ---\\nHost ${name}\\n[\\s\\S]*?(?=\\n+# ---|\\n?$)`,
  );
  if (blockRe.test(existing)) {
    // Function replacer: `$`-sequences in the block (e.g. paths) stay literal.
    return existing.replace(blockRe, () => hostBlock);
  }
  const separator = existing && !existing.endsWith("\n\n")
    ? (existing.endsWith("\n") ? "\n" : "\n\n")
    : "";
  const header = existing
    ? ""
    : "# cloopy - Claude Code sandbox\n# Auto-generated by cloopy setup. Edit freely.\n\n";
  return existing + separator + header + hostBlock + "\n";
}

/**
 * Remove a named Host block from the cloopy config content.
 * Returns the content unchanged when the block is absent.
 * Pure — exported for tests.
 */
export function removeHostBlock(existing: string, name: string): string {
  const escaped = escapeRegExp(name);
  // Leading \n* also consumes the separator before the block so a removal
  // in the middle of the file doesn't leave a growing run of blank lines.
  const blockRe = new RegExp(
    `\\n*# --- ${escaped} ---\\nHost ${escaped}\\n[\\s\\S]*?(?=\\n+# ---|\\n*$)`,
  );
  if (!blockRe.test(existing)) return existing;
  let result = existing.replace(blockRe, "");
  result = result.replace(/^\n+/, "");
  if (result.trim() === "") return "";
  if (!result.endsWith("\n")) result += "\n";
  return result;
}

/**
 * Prepend the cloopy Include directive when missing.
 * Returns the new content, or null when the directive is already present
 * (callers skip the write — the user's config is never rewritten needlessly).
 * Pure — exported for tests.
 */
export function ensureIncludeLine(
  mainContent: string,
  includeLine: string,
): string | null {
  if (mainContent.includes(includeLine)) return null;
  return `# --- cloopy ---\n${includeLine}\n\n${mainContent}`;
}

export interface HostBlockOptions {
  /** SSH HostName (default: "localhost" — the local container) */
  hostName?: string;
  /**
   * IdentityFile path. undefined = the auto-generated cloopy key,
   * null = omit the line entirely (ssh falls back to agent/default keys).
   */
  identityFile?: string | null;
}

/**
 * Build a cloopy-managed Host block. Pure given explicit options —
 * exported for tests.
 */
export function buildHostBlock(
  name: string,
  port: string,
  opts: HostBlockOptions = {},
): string {
  const identityFile = opts.identityFile === undefined
    ? keyPath()
    : opts.identityFile;
  const lines = [
    `# --- ${name} ---`,
    `Host ${name}`,
    `    HostName ${opts.hostName ?? "localhost"}`,
    `    Port ${port}`,
    `    User developer`,
  ];
  if (identityFile !== null) {
    lines.push(`    IdentityFile ${toSshPath(identityFile)}`);
  }
  // UserKnownHostsFile は指定しない: ホスト鍵は標準 ~/.ssh/known_hosts に
  // 固定する (理由は defaultKnownHostsPath のコメント参照)。
  lines.push(`    StrictHostKeyChecking accept-new`);
  return lines.join("\n");
}

/**
 * Write the cloopy SSH config file and ensure Include in main ~/.ssh/config.
 * Both writes are atomic (temp file + rename).
 * Defaults target the local container (HostName localhost); remote profiles
 * pass hostName/identityFile via opts.
 * @param port SSH port number as string
 * @param instanceName Name used as SSH Host (default: "cloopy")
 */
export function injectSshConfig(
  port: string,
  instanceName = "cloopy",
  opts: HostBlockOptions = {},
): void {
  const dir = sshDir();
  Deno.mkdirSync(dir, { recursive: true });

  const hostBlock = buildHostBlock(instanceName, port, opts);

  // Read existing config (CRLF-normalized) and replace or append the block
  const existing = readCloopyConfig();
  writeFileAtomic(
    sshConfigPath(),
    upsertHostBlock(existing, instanceName, hostBlock),
  );

  // Ensure Include directive in main SSH config
  const mainConfig = mainSshConfigPath();
  const mainDir = resolve(homeDir(), ".ssh");
  Deno.mkdirSync(mainDir, { recursive: true });

  let mainContent: string;
  try {
    mainContent = Deno.readTextFileSync(mainConfig);
  } catch {
    mainContent = "";
  }

  const includeLine = `Include ${toSshPath(sshConfigPath())}`;
  const newContent = ensureIncludeLine(mainContent, includeLine);

  if (newContent !== null) {
    console.log("[cloopy] Adding Include directive to SSH config...");
    writeFileAtomic(mainConfig, newContent);
  } else {
    console.log("[cloopy] SSH config Include already present, skipping");
  }
}

/** True when the cloopy config content already contains a block for name. */
export function hasHostBlock(content: string, name: string): boolean {
  const escaped = escapeRegExp(name);
  return new RegExp(`(^|\\n)# --- ${escaped} ---\\nHost ${escaped}\\n`)
    .test(content);
}

/**
 * Read the cloopy SSH config content ("" when missing).
 * CRLF is normalized to LF: the block regexes in upsertHostBlock /
 * removeHostBlock anchor on "\n", so a config hand-edited with a CRLF
 * editor would otherwise make upsert duplicate blocks and remove a no-op.
 * Our writes are always LF, and ssh accepts both.
 */
export function readCloopyConfig(): string {
  try {
    return Deno.readTextFileSync(sshConfigPath()).replaceAll("\r\n", "\n");
  } catch {
    return "";
  }
}

/**
 * Remove a named Host block from the cloopy SSH config file (atomic write).
 * No-op when the file or the block doesn't exist.
 */
export function removeSshConfigEntry(name: string): void {
  const existing = readCloopyConfig();
  if (!existing) return;
  const updated = removeHostBlock(existing, name);
  if (updated !== existing) {
    writeFileAtomic(sshConfigPath(), updated);
  }
}

/** Trailing-comment marker identifying cloopy-managed known_hosts lines. */
export function knownHostsMarker(name: string): string {
  return `cloopy:${name}`;
}

/**
 * known_hosts host-field token for a host:port pair, in the form ssh and
 * ssh-keyscan use (bare host on port 22, "[host]:port" otherwise).
 */
export function knownHostsToken(host: string, port: string): string {
  return port === "22" ? host : `[${host}]:${port}`;
}

/**
 * Match a HashKnownHosts field (|1|salt|hash, hash = HMAC-SHA1(salt, host))
 * against a host token. ssh lowercases hostnames before hashing/lookup, so
 * callers pass the token already lowercased.
 */
async function hashedHostMatches(
  field: string,
  lowerToken: string,
): Promise<boolean> {
  const parts = field.split("|");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "1") return false;
  try {
    const salt = Uint8Array.from(atob(parts[2]), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      "raw",
      salt,
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(lowerToken),
      ),
    );
    return btoa(String.fromCharCode(...mac)) === parts[3];
  } catch {
    return false;
  }
}

/**
 * Transform a known_hosts line for removal of the given marker/tokens.
 * Returns null to drop the line (marker match, hashed-host match, or every
 * plain alias matched), the original line when untouched, or a rebuilt line
 * when only SOME comma-grouped aliases matched — the other aliases' pins
 * are not ours to delete (dropping the whole line would silently lose them
 * and reopen TOFU for those names). Comments, blank lines,
 * @cert-authority/@revoked lines and wildcard patterns are never touched —
 * only exact entries for our own destination are.
 */
async function transformKnownHostsLine(
  rawLine: string,
  marker: string,
  lowerTokens: string[],
): Promise<string | null> {
  const line = rawLine.trim();
  if (!line || line.startsWith("#") || line.startsWith("@")) return rawLine;
  const fields = line.split(/\s+/);
  if (fields.length < 3) return rawLine;
  if (fields[3] === marker) return null;
  const hostField = fields[0];
  if (hostField.startsWith("|")) {
    for (const t of lowerTokens) {
      if (await hashedHostMatches(hostField, t)) return null;
    }
    return rawLine;
  }
  const names = hostField.split(",");
  const remaining = names.filter((h) => !lowerTokens.includes(h.toLowerCase()));
  if (remaining.length === names.length) return rawLine;
  if (remaining.length === 0) return null;
  return [remaining.join(","), ...fields.slice(1)].join(" ");
}

/**
 * Drop or rewrite matching lines (see transformKnownHostsLine) in
 * known_hosts content; every other line is preserved as-is. Pure —
 * exported for tests.
 */
export async function filterKnownHostsContent(
  content: string,
  marker: string,
  tokens: string[],
): Promise<string> {
  const lower = tokens.map((t) => t.toLowerCase());
  const kept: string[] = [];
  for (const line of content.split("\n")) {
    const transformed = await transformKnownHostsLine(line, marker, lower);
    if (transformed !== null) {
      kept.push(transformed);
    }
  }
  return kept.join("\n");
}

/**
 * Replace the entries for host:port in ~/.ssh/known_hosts with the given
 * keyscan lines, each tagged with the entry's marker comment. Stale lines
 * are removed first — by marker (the entry's own previous pins, even after
 * its host changed) and by host token (user-added or ssh-auto-added lines
 * for the same destination, HashKnownHosts hashed ones included) — so a
 * host key change after reset never leaves a conflicting old pin behind.
 */
export async function upsertKnownHosts(
  name: string,
  host: string,
  port: string,
  lines: string[],
): Promise<void> {
  const tokens = new Set([knownHostsToken(host, port)]);
  for (const l of lines) {
    const field = l.trim().split(/\s+/)[0];
    if (field && !field.startsWith("|") && !field.startsWith("@")) {
      for (const h of field.split(",")) tokens.add(h);
    }
  }
  const marker = knownHostsMarker(name);
  const path = defaultKnownHostsPath();
  let content = "";
  try {
    content = Deno.readTextFileSync(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  let updated = await filterKnownHostsContent(content, marker, [...tokens]);
  if (updated !== "" && !updated.endsWith("\n")) updated += "\n";
  for (const l of lines) updated += `${l} ${marker}\n`;
  Deno.mkdirSync(resolve(homeDir(), ".ssh"), { recursive: true });
  writeFileAtomic(path, updated);
}

/**
 * Remove an entry's cloopy-marked lines from ~/.ssh/known_hosts.
 * Marker-only on purpose: lines the user added by hand for the same host
 * (or ssh auto-added before pinning) are not ours to delete.
 */
export async function removeKnownHostsEntry(name: string): Promise<void> {
  const path = defaultKnownHostsPath();
  let content: string;
  try {
    content = Deno.readTextFileSync(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return;
    throw e;
  }
  const updated = await filterKnownHostsContent(
    content,
    knownHostsMarker(name),
    [],
  );
  if (updated !== content) writeFileAtomic(path, updated);
}

export interface ScannedHostKey {
  type: string;
  base64: string;
}

/**
 * Parse ssh-keyscan stdout into host key entries. Lines are
 * `<host> <type> <base64>`; comments and malformed lines are skipped.
 * Pure — exported for tests.
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

/**
 * Fetch the local container's current host keys via ssh-keyscan and upsert
 * them into ~/.ssh/known_hosts (replacing previous [localhost]:port pins).
 * Call this after container start/rebuild so tools never see a key-changed
 * prompt. Retries up to 3 times (2 s interval) to handle sshd not yet ready.
 * @param port SSH port number as string
 * @param instanceName Instance name used as the known_hosts marker
 */
export async function refreshKnownHosts(
  port: string,
  instanceName: string,
): Promise<void> {
  console.log("[cloopy] known_hosts を更新中...");

  const maxRetries = 3;
  const retryDelay = 2000; // ms

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const cmd = new Deno.Command("ssh-keyscan", {
      args: ["-p", port, "localhost"],
      stdout: "piped",
      stderr: "null",
    });
    const { code, stdout } = await cmd.output();
    if (code !== 0) {
      if (attempt < maxRetries) {
        console.log(
          `[cloopy] ssh-keyscan 失敗 (${attempt}/${maxRetries}), ${
            retryDelay / 1000
          }秒後にリトライ...`,
        );
        await new Promise((r) => setTimeout(r, retryDelay));
        continue;
      }
      console.error("[cloopy] ssh-keyscan に失敗しました");
      return;
    }

    const { lines } = parseKeyscanOutput(new TextDecoder().decode(stdout));
    if (lines.length === 0) {
      if (attempt < maxRetries) {
        console.log(
          `[cloopy] ssh-keyscan: キー未取得 (${attempt}/${maxRetries}), ${
            retryDelay / 1000
          }秒後にリトライ...`,
        );
        await new Promise((r) => setTimeout(r, retryDelay));
        continue;
      }
      console.error("[cloopy] ssh-keyscan: キーが取得できませんでした");
      return;
    }

    await upsertKnownHosts(instanceName, "localhost", port, lines);
    console.log("[cloopy] known_hosts を更新しました");
    return;
  }
}
