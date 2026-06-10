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

/** Get the cloopy known_hosts path (~/.ssh/cloopy/known_hosts) */
export function knownHostsPath(): string {
  return resolve(sshDir(), "known_hosts");
}

/**
 * Get the per-remote known_hosts directory (~/.ssh/cloopy/known_hosts.d).
 * Remote entries each get their own file here: the shared known_hosts is
 * wholly overwritten by refreshKnownHosts on every local rebuild, which
 * would silently drop remote host keys if they shared the file.
 */
export function knownHostsDir(): string {
  return resolve(sshDir(), "known_hosts.d");
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
  /** UserKnownHostsFile path (default: the shared cloopy known_hosts) */
  knownHostsFile?: string;
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
  lines.push(
    `    StrictHostKeyChecking accept-new`,
    `    UserKnownHostsFile ${
      toSshPath(opts.knownHostsFile ?? knownHostsPath())
    }`,
  );
  return lines.join("\n");
}

/**
 * Write the cloopy SSH config file and ensure Include in main ~/.ssh/config.
 * Both writes are atomic (temp file + rename).
 * Defaults target the local container (HostName localhost); remote profiles
 * pass hostName/identityFile/knownHostsFile via opts.
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

/**
 * Fetch the current host key via ssh-keyscan and overwrite known_hosts.
 * Call this after container start/rebuild so tools never see a key-changed prompt.
 * Retries up to 3 times (2 s interval) to handle sshd not yet ready.
 * @param port SSH port number as string
 */
export async function refreshKnownHosts(port: string): Promise<void> {
  console.log("[cloopy] known_hosts を更新中...");

  const maxRetries = 3;
  const retryDelay = 2000; // ms

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const cmd = new Deno.Command("ssh-keyscan", {
      args: ["-p", port, "-H", "localhost"],
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

    const keys = new TextDecoder().decode(stdout).trim();
    if (!keys) {
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

    Deno.mkdirSync(sshDir(), { recursive: true });
    Deno.writeTextFileSync(knownHostsPath(), keys + "\n");
    console.log("[cloopy] known_hosts を更新しました");
    return;
  }
}
