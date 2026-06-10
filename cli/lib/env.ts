import { resolve } from "@std/path";
import { dim } from "@std/fmt/colors";

const END_MARKER = "# END cloopy auto-managed";

/**
 * Set a key=value in a .env file.
 * If the key is auto-managed, it goes inside the BEGIN/END block.
 * Otherwise updates existing or appends. Inserted lines reuse the file's
 * existing line-ending style (CRLF files stay CRLF).
 * @param filePath Absolute path to the .env file
 * @param key Environment variable name
 * @param value Environment variable value
 * @param auto If true, insert into the auto-managed block (between BEGIN/END markers)
 */
export function setEnvVar(
  filePath: string,
  key: string,
  value: string,
  auto = false,
): void {
  let content: string;
  try {
    content = Deno.readTextFileSync(filePath);
  } catch {
    content = "";
  }

  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const regex = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;

  if (regex.test(content)) {
    // Update existing (wherever it is). Use a function replacer so `$`-sequences
    // in the value (e.g. $&, $1, $`) are inserted literally, not interpreted as
    // replacement patterns. `.` and multiline `$` both stop before `\r`, so a
    // CRLF line keeps its `\r`.
    content = content.replace(regex, () => line);
  } else if (auto && content.includes(END_MARKER)) {
    // Insert just before the END marker (function replacer: same reason).
    content = content.replace(END_MARKER, () => `${line}${eol}${END_MARKER}`);
  } else {
    const base = content.trimEnd();
    content = (base ? base + eol : "") + line + eol;
  }

  Deno.writeTextFileSync(filePath, content);
  console.log(dim(`  [env] ${key}=${value}`));
}

/**
 * Ensure .env exists by copying from .env.example if needed.
 * @param projectRoot Absolute path to the project root
 * @returns Absolute path to the .env file
 */
export function ensureEnvFile(projectRoot: string): string {
  const envPath = resolve(projectRoot, ".env");
  const examplePath = resolve(projectRoot, ".env.example");

  try {
    Deno.statSync(envPath);
  } catch {
    // .env doesn't exist, copy from example
    try {
      Deno.copyFileSync(examplePath, envPath);
      console.log("[cloopy] Created .env from .env.example");
    } catch {
      console.error(
        "[cloopy] ERROR: .env.example not found. Cannot create .env.",
      );
      Deno.exit(1);
    }
  }

  return envPath;
}

/**
 * Read all key=value pairs from .env into a Map.
 * Comments and blank lines are skipped. Returns an empty map if .env is missing.
 * @param projectRoot Absolute path to the project root
 * @returns Map of environment variable name to value
 */
export function readEnvFile(projectRoot: string): Map<string, string> {
  const envPath = resolve(projectRoot, ".env");
  const map = new Map<string, string>();
  try {
    const content = Deno.readTextFileSync(envPath);
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        map.set(trimmed.slice(0, eqIdx), trimmed.slice(eqIdx + 1));
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      console.error(`[cloopy] .env の読み込みに失敗: ${e}`);
    }
  }
  return map;
}
