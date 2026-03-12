import { getProjectRoot, getComposeFiles, getStatus } from "../lib/compose.ts";
import { pubKeyPath, keyPath, mainSshConfigPath } from "../lib/ssh.ts";
import { resolve } from "@std/path";
import { bold, green, red, yellow, dim } from "@std/fmt/colors";

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
    return { name: "Docker", ok: code === 0, detail: code === 0 ? "running" : "not responding" };
  } catch {
    return { name: "Docker", ok: false, detail: "not found" };
  }
}

function checkSshKey(): CheckResult {
  try {
    Deno.statSync(keyPath());
    Deno.statSync(pubKeyPath());
    return { name: "SSH Key", ok: true, detail: keyPath() };
  } catch {
    return { name: "SSH Key", ok: false, detail: "not found" };
  }
}

function checkSshConfig(): CheckResult {
  try {
    const content = Deno.readTextFileSync(mainSshConfigPath());
    if (content.includes("cloopy")) {
      return { name: "SSH Config", ok: true, detail: "Include present" };
    }
    return { name: "SSH Config", ok: false, detail: "Include directive missing" };
  } catch {
    return { name: "SSH Config", ok: false, detail: "~/.ssh/config not found" };
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
  } catch {
    return { name: ".env", ok: false, detail: "not found" };
  }
}

async function checkImage(projectRoot: string): Promise<CheckResult> {
  try {
    const files = getComposeFiles(projectRoot, true);
    const cmd = new Deno.Command("docker", {
      args: ["compose", ...files, "images", "-q"],
      cwd: projectRoot,
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = await cmd.output();
    const output = new TextDecoder().decode(stdout).trim();
    if (code === 0 && output) {
      return { name: "Image", ok: true, detail: "built" };
    }
    return { name: "Image", ok: false, detail: "not built" };
  } catch {
    return { name: "Image", ok: false, detail: "check failed" };
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

async function checkSshConnect(containerRunning: boolean): Promise<CheckResult> {
  if (!containerRunning) {
    return { name: "SSH Connect", ok: false, detail: "skipped (not running)", info: true };
  }
  try {
    const cmd = new Deno.Command("ssh", {
      args: ["-o", "ConnectTimeout=3", "-o", "BatchMode=yes", "cloopy", "exit"],
      stdout: "null",
      stderr: "null",
    });
    const { code } = await cmd.output();
    return { name: "SSH Connect", ok: code === 0, detail: code === 0 ? "OK" : "connection failed" };
  } catch {
    return { name: "SSH Connect", ok: false, detail: "ssh command not found", info: true };
  }
}

/**
 * Run all health checks. Returns true if setup is needed.
 */
export async function doctor(): Promise<boolean> {
  console.log(bold("\n[cloopy] Health checks\n"));

  const projectRoot = getProjectRoot();

  const results: CheckResult[] = [
    await checkDocker(),
    checkSshKey(),
    checkSshConfig(),
    checkEnvFile(),
    await checkImage(projectRoot),
  ];

  const containerResult = await checkContainer(projectRoot);
  results.push(containerResult);
  results.push(await checkSshConnect(containerResult.ok));

  let needsSetup = false;
  for (const r of results) {
    let icon: string;
    if (r.ok) {
      icon = green("OK");
    } else if (r.info) {
      icon = dim("--");
    } else {
      icon = red("!!");
      needsSetup = true;
    }
    const name = r.name.padEnd(12);
    console.log(`  [${icon}] ${name} ${dim(r.detail)}`);
  }

  console.log("");

  if (needsSetup) {
    console.log(yellow("[cloopy] Some checks failed. Setup is required.\n"));
  } else {
    console.log(green("[cloopy] All checks passed.\n"));
  }

  return needsSetup;
}
