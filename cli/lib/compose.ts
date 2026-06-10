import { resolve } from "@std/path";
import { yellow } from "@std/fmt/colors";

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

/**
 * Build the compose file arguments, auto-detecting docker-compose.local.yml.
 * @param projectRoot Absolute path to the project root
 * @param quiet Suppress log output when local override is found
 * @returns Array of `-f <path>` arguments for docker compose
 */
export function getComposeFiles(projectRoot: string, quiet = false): string[] {
  const args = ["-f", resolve(projectRoot, "docker-compose.yml")];
  const localFile = resolve(projectRoot, "docker-compose.local.yml");
  try {
    Deno.statSync(localFile);
    if (!quiet) {
      console.log(
        "[cloopy] Found docker-compose.local.yml, including in config",
      );
    }
    args.push("-f", localFile);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      console.error(`[cloopy] docker-compose.local.yml の確認に失敗: ${e}`);
    }
  }
  return args;
}

/**
 * Run a docker compose command and wait for completion.
 * Logs the local-override notice (getComposeFiles with quiet=false) — fine
 * for user-initiated actions, use getComposeFiles(root, true) directly where
 * silence is needed.
 * @param projectRoot Absolute path to the project root
 * @param subArgs Arguments passed after `docker compose -f ...`
 * @param options Set `inherit: true` to pipe stdin from the terminal
 * @returns Exit code of the docker compose process
 */
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

/**
 * Spawn a docker compose command without waiting for completion.
 * @param projectRoot Absolute path to the project root
 * @param subArgs Arguments passed after `docker compose -f ...`
 * @returns The spawned child process
 */
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

/**
 * Get the running container ID for the cloopy service.
 * @param projectRoot Absolute path to the project root
 * @returns Container ID string, or null if not running
 */
export async function getContainerId(
  projectRoot: string,
): Promise<string | null> {
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

/**
 * Check container logs for bootstrap status after startup.
 * Warns if bootstrap failed or is still running.
 */
export async function checkBootstrapStatus(
  projectRoot: string,
): Promise<void> {
  const files = getComposeFiles(projectRoot, true);
  const cmd = new Deno.Command("docker", {
    args: ["compose", ...files, "logs", "--tail", "200"],
    cwd: projectRoot,
    stdout: "piped",
    stderr: "piped",
  });
  const { stdout } = await cmd.output();
  const logs = new TextDecoder().decode(stdout);

  if (logs.includes("[bootstrap] ERROR:")) {
    console.log(
      yellow(
        "[cloopy] bootstrap でエラーが発生しています。「ログ確認」で詳細を確認してください",
      ),
    );
  } else if (logs.includes("[bootstrap] Complete")) {
    // bootstrap completed successfully — no message needed
  } else if (logs.includes("[bootstrap] Starting")) {
    console.log(
      yellow(
        "[cloopy] bootstrap がまだ実行中です。完了まで数分かかる場合があります",
      ),
    );
  }
}

/**
 * Get container status as a human-readable string (e.g. "running (Up 5 minutes)").
 * @param projectRoot Absolute path to the project root
 * @returns Status string, or "not running" if the container is down
 */
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
