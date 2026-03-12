import { resolve } from "@std/path";

/** Resolve the project root (parent of cli/) */
export function getProjectRoot(): string {
  const cliDir = new URL(".", import.meta.url).pathname;
  // On Windows, Deno returns /C:/... — normalize
  const normalized = Deno.build.os === "windows"
    ? cliDir.replace(/^\//, "").replaceAll("/", "\\")
    : cliDir;
  // cli/lib/ → cli/ → project root
  return resolve(normalized, "..", "..");
}

/** Build the compose file arguments, auto-detecting docker-compose.local.yml */
export function getComposeFiles(projectRoot: string, quiet = false): string[] {
  const args = ["-f", resolve(projectRoot, "docker-compose.yml")];
  const localFile = resolve(projectRoot, "docker-compose.local.yml");
  try {
    Deno.statSync(localFile);
    if (!quiet) console.log("[cloopy] Found docker-compose.local.yml, including in config");
    args.push("-f", localFile);
  } catch {
    // No local override
  }
  return args;
}

/** Run a docker compose command. Returns the exit code. */
export async function compose(
  projectRoot: string,
  subArgs: string[],
  options?: { inherit?: boolean },
): Promise<number> {
  const files = getComposeFiles(projectRoot);
  const cmd = new Deno.Command("docker", {
    args: ["compose", ...files, ...subArgs],
    cwd: projectRoot,
    stdin: options?.inherit ? "inherit" : "null",
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  return code;
}

/** Spawn a docker compose command, returning the child process. */
export function composeSpawn(
  projectRoot: string,
  subArgs: string[],
): Deno.ChildProcess {
  const files = getComposeFiles(projectRoot);
  const cmd = new Deno.Command("docker", {
    args: ["compose", ...files, ...subArgs],
    cwd: projectRoot,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  });
  return cmd.spawn();
}

/** Get the container ID (if running) */
export async function getContainerId(projectRoot: string): Promise<string | null> {
  const files = getComposeFiles(projectRoot, true);
  const cmd = new Deno.Command("docker", {
    args: ["compose", ...files, "ps", "-q"],
    cwd: projectRoot,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  if (code !== 0) return null;
  const id = new TextDecoder().decode(stdout).trim();
  return id || null;
}

/** Get container status as a simple string */
export async function getStatus(projectRoot: string): Promise<string> {
  const files = getComposeFiles(projectRoot, true);
  const cmd = new Deno.Command("docker", {
    args: ["compose", ...files, "ps", "--format", "{{.State}} ({{.Status}})"],
    cwd: projectRoot,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  if (code !== 0) return "not running";
  const output = new TextDecoder().decode(stdout).trim();
  return output || "not running";
}
