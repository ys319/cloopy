import {
  getComposeFiles,
  getContainerId,
  getProjectRoot,
  getStatus,
} from "../lib/compose.ts";
import { readEnvFile } from "../lib/env.ts";
import { keyPath, mainSshConfigPath, pubKeyPath } from "../lib/ssh.ts";
import { DEFAULT_INSTANCE_NAME } from "../lib/constants.ts";
import { resolve } from "@std/path";
import { bold, dim, green, red, yellow } from "@std/fmt/colors";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  info?: boolean; // info-only: won't trigger needsSetup
}

async function checkDocker(): Promise<CheckResult> {
  try {
    const cmd = new Deno.Command("docker", {
      args: ["info"],
      stdout: "null",
      stderr: "null",
    });
    const { code } = await cmd.output();
    return {
      name: "Docker",
      ok: code === 0,
      detail: code === 0 ? "running" : "not responding",
    };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return { name: "Docker", ok: false, detail: "not found" };
    }
    return { name: "Docker", ok: false, detail: String(e) };
  }
}

function checkSshKey(): CheckResult {
  try {
    Deno.statSync(keyPath());
    Deno.statSync(pubKeyPath());
    return { name: "SSH Key", ok: true, detail: keyPath() };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return { name: "SSH Key", ok: false, detail: "not found" };
    }
    return { name: "SSH Key", ok: false, detail: String(e) };
  }
}

function checkSshConfig(): CheckResult {
  try {
    const content = Deno.readTextFileSync(mainSshConfigPath());
    if (content.includes("cloopy")) {
      return { name: "SSH Config", ok: true, detail: "Include present" };
    }
    return {
      name: "SSH Config",
      ok: false,
      detail: "Include directive missing",
    };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return {
        name: "SSH Config",
        ok: false,
        detail: "~/.ssh/config not found",
      };
    }
    return { name: "SSH Config", ok: false, detail: String(e) };
  }
}

function checkEnvFile(): CheckResult {
  const envPath = resolve(getProjectRoot(), ".env");
  try {
    const content = Deno.readTextFileSync(envPath);
    const hasPubkey = /^CLOOPY_PUBKEY_PATH=.+/m.test(content);
    if (!hasPubkey) {
      return { name: ".env", ok: false, detail: "CLOOPY_PUBKEY_PATH not set" };
    }
    return { name: ".env", ok: true, detail: "configured" };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return { name: ".env", ok: false, detail: "not found" };
    }
    return { name: ".env", ok: false, detail: String(e) };
  }
}

/** Resolve the image refs this compose project would use (version-safe). */
async function resolveImageRefs(
  projectRoot: string,
  files: string[],
): Promise<string[]> {
  // `docker compose config --images` prints one resolved image ref per line.
  // Available on modern Compose v2; if it fails (old version / parse error /
  // empty), fall back to the stable, hard-coded tag from docker-compose.yml.
  try {
    const cmd = new Deno.Command("docker", {
      args: ["compose", ...files, "config", "--images"],
      cwd: projectRoot,
      stdout: "piped",
      stderr: "null",
    });
    const { code, stdout } = await cmd.output();
    if (code === 0) {
      const refs = new TextDecoder()
        .decode(stdout)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (refs.length > 0) return refs;
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) throw e; // docker missing → bubble up
    // any other failure → fall through to the hard-coded ref
  }
  return ["ys319/cloopy:latest"];
}

/** True if `docker image inspect <ref>` succeeds (image exists locally). */
async function imageExists(ref: string): Promise<boolean> {
  const cmd = new Deno.Command("docker", {
    args: ["image", "inspect", ref],
    stdout: "null",
    stderr: "null",
  });
  const { code } = await cmd.output();
  return code === 0;
}

/**
 * Report whether the project's image is available locally.
 *
 * We deliberately do NOT use `docker compose images -q`: on Compose versions
 * where a service declares both `image:` and `build:`, its per-container
 * image-inspect step can emit empty output (exit 0) for a perfectly healthy,
 * running container — indistinguishable from a genuine "not built". Instead we
 * use a positive check: the image is "built" if EITHER
 *   (a) a container for the project is running — it cannot run without an
 *       image, so the image necessarily exists; OR
 *   (b) every compose-resolved image ref passes `docker image inspect`.
 * "not built" (→ needsImage → buildAndStart) is returned only when there is no
 * running container AND a referenced image is missing, so a genuine first run
 * still builds while a healthy stack is never needlessly rebuilt.
 */
async function checkImage(projectRoot: string): Promise<CheckResult> {
  try {
    // (a) A running container proves the image exists.
    if (await getContainerId(projectRoot)) {
      return { name: "Image", ok: true, detail: "built (in use)" };
    }

    // (b) Direct, tag-keyed presence check on every resolved ref.
    const files = getComposeFiles(projectRoot, true);
    const refs = await resolveImageRefs(projectRoot, files);
    const present = await Promise.all(refs.map(imageExists));
    if (present.every((ok) => ok)) {
      return { name: "Image", ok: true, detail: "built" };
    }
    return { name: "Image", ok: false, detail: "not built" };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return { name: "Image", ok: false, detail: "docker not found" };
    }
    return { name: "Image", ok: false, detail: `check failed: ${e}` };
  }
}

async function checkContainer(projectRoot: string): Promise<CheckResult> {
  const status = await getStatus(projectRoot);
  return {
    name: "Container",
    ok: status !== "not running",
    detail: status,
    info: true,
  };
}

async function checkSshConnect(
  containerRunning: boolean,
  instanceName: string,
): Promise<CheckResult> {
  if (!containerRunning) {
    return {
      name: "SSH Connect",
      ok: false,
      detail: "skipped (not running)",
      info: true,
    };
  }
  try {
    const cmd = new Deno.Command("ssh", {
      args: [
        "-o",
        "ConnectTimeout=3",
        "-o",
        "BatchMode=yes",
        instanceName,
        "exit",
      ],
      stdout: "null",
      stderr: "null",
    });
    const { code } = await cmd.output();
    return {
      name: "SSH Connect",
      ok: code === 0,
      detail: code === 0 ? "OK" : "connection failed",
    };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return {
        name: "SSH Connect",
        ok: false,
        detail: "ssh command not found",
        info: true,
      };
    }
    return {
      name: "SSH Connect",
      ok: false,
      detail: String(e),
      info: true,
    };
  }
}

export interface DoctorResult {
  /** いずれかのチェックが失敗している */
  needsSetup: boolean;
  /** .env / SSH 鍵 / SSH 設定が未整備 → 対話セットアップが必要 */
  needsEnv: boolean;
  /** イメージ未ビルドのみ → ビルド＋起動だけでよい */
  needsImage: boolean;
}

/**
 * Run all health checks and print results to console.
 * @returns DoctorResult indicating which setup steps are needed
 */
export async function doctor(): Promise<DoctorResult> {
  console.log(bold("\n[cloopy] Health checks\n"));

  const projectRoot = getProjectRoot();
  const envMap = readEnvFile(projectRoot);
  const instanceName = envMap.get("CLOOPY_INSTANCE_NAME") ??
    DEFAULT_INSTANCE_NAME;

  const results: CheckResult[] = [
    await checkDocker(),
    checkSshKey(),
    checkSshConfig(),
    checkEnvFile(),
    await checkImage(projectRoot),
  ];

  const containerResult = await checkContainer(projectRoot);
  results.push(containerResult);
  results.push(await checkSshConnect(containerResult.ok, instanceName));

  let needsEnv = false;
  let needsImage = false;
  for (const r of results) {
    let icon: string;
    if (r.ok) {
      icon = green("OK");
    } else if (r.info) {
      icon = dim("--");
    } else {
      icon = red("!!");
      if (r.name === "Image") {
        needsImage = true;
      } else {
        needsEnv = true;
      }
    }
    const name = r.name.padEnd(12);
    console.log(`  [${icon}] ${name} ${dim(r.detail)}`);
  }

  console.log("");

  const needsSetup = needsEnv || needsImage;
  if (needsSetup) {
    console.log(yellow("[cloopy] Some checks failed. Setup is required.\n"));
  } else {
    console.log(green("[cloopy] All checks passed.\n"));
  }

  return { needsSetup, needsEnv, needsImage };
}
