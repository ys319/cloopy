import { resolve } from "@std/path";
import { dim } from "@std/fmt/colors";

const BEGIN_MARKER = "# BEGIN cloopy auto-managed";
const END_MARKER = "# END cloopy auto-managed";

/**
 * Set a key=value in a .env file.
 * If the key is auto-managed, it goes inside the BEGIN/END block.
 * Otherwise updates existing or appends.
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

  const regex = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;

  if (regex.test(content)) {
    // Update existing (wherever it is)
    content = content.replace(regex, line);
  } else if (auto && content.includes(END_MARKER)) {
    // Insert just before the END marker
    content = content.replace(END_MARKER, `${line}\n${END_MARKER}`);
  } else {
    content = content.trimEnd() + "\n" + line + "\n";
  }

  Deno.writeTextFileSync(filePath, content);
  console.log(dim(`  [env] ${key}=${value}`));
}

/**
 * Ensure .env exists by copying from .env.example if needed.
 * Returns the path to the .env file.
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
  } catch { /* no .env */ }
  return map;
}
