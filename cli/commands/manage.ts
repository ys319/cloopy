import { bold, cyan, dim, green, red, yellow } from "@std/fmt/colors";
import { resolve } from "@std/path";
import {
  compose,
  composeSpawn,
  getContainerId,
  getProjectRoot,
  getStatus,
} from "../lib/compose.ts";
import { readEnvFile } from "../lib/env.ts";
import { refreshKnownHosts } from "../lib/ssh.ts";
import { Confirm, Select } from "../lib/prompt.ts";
import { doctor } from "./doctor.ts";
import { setup } from "./setup.ts";

function statusColor(status: string): string {
  if (status.startsWith("running")) return green(status);
  if (status === "not running") return red(status);
  return yellow(status);
}

const SEPARATOR = Select.separator("────────────────────────────");

async function pressAnyKey(): Promise<void> {
  console.log(dim("\n  何かキーを押すと戻ります..."));
  Deno.stdin.setRaw(true);
  try {
    await Deno.stdin.read(new Uint8Array(1));
  } finally {
    Deno.stdin.setRaw(false);
  }
}

export async function manage(): Promise<void> {
  const projectRoot = getProjectRoot();

  while (true) {
    const status = await getStatus(projectRoot);

    console.clear();
    console.log("");
    console.log(bold(cyan("  cloopy manager")));
    console.log(dim("  状態: ") + statusColor(status));
    console.log("");

    const isRunning = status.startsWith("running");
    const choice = await Select.prompt({
      message: "操作を選択",
      maxRows: 20,
      options: [
        isRunning
          ? { name: "停止", value: "stop" }
          : { name: "起動", value: "start" },
        ...(isRunning ? [
          { name: "再起動", value: "restart" },
          { name: "ログ確認", value: "logs" },
          SEPARATOR,
          { name: "SSH 接続", value: "ssh" },
          { name: "VS Code で開く", value: "vscode" },
          { name: "シェル (docker exec)", value: "shell" },
        ] : []),
        SEPARATOR,
        { name: "リビルド", value: "rebuild" },
        { name: "セットアップ (再設定)", value: "setup" },
        { name: "設定を表示", value: "config" },
        { name: "ヘルスチェック", value: "doctor" },
        { name: "バックアップ", value: "backup" },
        { name: dim("リセット"), value: "reset" },
        SEPARATOR,
        { name: red("終了"), value: "quit" },
      ],
    });

    console.log("");

    switch (choice) {
      case "start": {
        console.log("[cloopy] 起動中...");
        const startCode = await compose(projectRoot, [
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          "300",
          "--remove-orphans",
        ]);
        if (startCode !== 0) console.error(red("[cloopy] 起動に失敗しました"));
        break;
      }
      case "stop": {
        console.log("[cloopy] 停止中...");
        const stopCode = await compose(projectRoot, ["down"]);
        if (stopCode !== 0) console.error(red("[cloopy] 停止に失敗しました"));
        break;
      }
      case "restart": {
        console.log("[cloopy] 再起動中...");
        const restartCode = await compose(projectRoot, ["restart"]);
        if (restartCode !== 0) {
          console.error(red("[cloopy] 再起動に失敗しました"));
        }
        break;
      }
      case "logs": {
        if (Deno.stdin.isTerminal()) {
          console.log("[cloopy] ログを追っています... (ESC / q で戻る)\n");
          const child = composeSpawn(projectRoot, ["logs", "-f"]);
          Deno.stdin.setRaw(true);
          try {
            const buf = new Uint8Array(1);
            const waitForKey = async () => {
              while (true) {
                const n = await Deno.stdin.read(buf);
                if (n === null) return;
                // ESC (0x1b), q (0x71), Ctrl-C (0x03)
                if (buf[0] === 0x1b || buf[0] === 0x71 || buf[0] === 0x03) return;
              }
            };
            await Promise.race([child.status, waitForKey()]);
          } finally {
            Deno.stdin.setRaw(false);
          }
          try {
            child.kill("SIGKILL");
          } catch { /* already exited */ }
          await child.status;
          console.log("");
        } else {
          console.log("[cloopy] ログを追っています... (Ctrl+C で停止)\n");
          const child = composeSpawn(projectRoot, ["logs", "-f"]);
          await child.status;
        }
        break;
      }
      case "ssh": {
        console.log("[cloopy] SSH 接続中...");
        const ssh = new Deno.Command("ssh", {
          args: ["cloopy"],
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        await ssh.output();
        break;
      }
      case "vscode": {
        console.log("[cloopy] VS Code を起動中...");
        try {
          const codeCmd = new Deno.Command("code", {
            args: ["--remote", "ssh-remote+cloopy", "/home/developer/workspace"],
            stdout: "inherit",
            stderr: "inherit",
          });
          const { code: exitCode } = await codeCmd.output();
          if (exitCode !== 0) {
            console.error(red("[cloopy] VS Code の起動に失敗しました"));
          }
        } catch {
          console.error(red("[cloopy] VS Code CLI (code) が見つかりません"));
          console.error('  インストール: VS Code → コマンドパレット → "Shell Command: Install \'code\' command in PATH"');
        }
        break;
      }
      case "shell": {
        console.log("[cloopy] シェルを起動中...");
        const containerId = await getContainerId(projectRoot);
        if (!containerId) {
          console.error(red("[cloopy] コンテナが起動していません"));
          break;
        }
        const exec = new Deno.Command("docker", {
          args: ["exec", "-it", "-u", "developer", containerId, "/bin/zsh"],
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        await exec.output();
        break;
      }
      case "rebuild": {
        console.log("[cloopy] リビルド中...");
        const buildCode = await compose(projectRoot, ["build"]);
        if (buildCode === 0) {
          await compose(projectRoot, [
            "up",
            "-d",
            "--wait",
            "--wait-timeout",
            "300",
            "--remove-orphans",
          ]);
          const env = readEnvFile(projectRoot);
          const port = env.get("CLOOPY_SSH_PORT") ?? "10022";
          await refreshKnownHosts(port);
        } else {
          console.error(red("[cloopy] ビルドに失敗しました"));
        }
        break;
      }
      case "doctor": {
        await doctor();
        await pressAnyKey();
        break;
      }
      case "setup": {
        if (isRunning) {
          console.log("[cloopy] 設定変更のため一度停止します...");
          await compose(projectRoot, ["down"]);
          console.log("");
        }
        await setup();
        break;
      }
      case "config": {
        const env = readEnvFile(projectRoot);
        console.log(bold("  現在の設定 (.env):"));
        console.log(dim("  ─────────────────────────────"));
        for (const [key, value] of env) {
          const label = key.replace("CLOOPY_", "");
          console.log(`  ${cyan(label.padEnd(20))} = ${value}`);
        }
        if (env.size === 0) {
          console.log(dim("  (.env ファイルが見つかりません)"));
        }
        await pressAnyKey();
        break;
      }
      case "backup": {
        // nix-store は数 GB になるため対象外 (再構築可能)
        const backupEnv = readEnvFile(projectRoot);
        const targets: { volume: string; file: string }[] = [
          { volume: "cloopy_home-data", file: "home-data.tar.gz" },
          { volume: "cloopy_ssh-config", file: "ssh-config.tar.gz" },
        ];
        if (backupEnv.get("CLOOPY_WORKSPACE_VOLUME") === "true") {
          targets.push({ volume: "cloopy_workspace-data", file: "workspace-data.tar.gz" });
        }
        const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, (c) =>
          c === "T" ? "_" : ""
        );
        const backupDir = resolve(projectRoot, "backups", ts);
        Deno.mkdirSync(backupDir, { recursive: true });
        console.log(`[cloopy] バックアップ先: ${backupDir}`);
        console.log("");
        let allOk = true;
        for (const { volume, file } of targets) {
          console.log(`[cloopy] ${volume} をバックアップ中...`);
          const cmd = new Deno.Command("docker", {
            args: [
              "run", "--rm",
              "-v", `${volume}:/data:ro`,
              "-v", `${backupDir}:/backup`,
              "alpine",
              "tar", "czf", `/backup/${file}`, "-C", "/data", ".",
            ],
            stdout: "inherit",
            stderr: "inherit",
          });
          const { code } = await cmd.output();
          if (code !== 0) {
            console.error(red(`[cloopy] ${volume} のバックアップに失敗しました`));
            allOk = false;
          } else {
            console.log(green(`[cloopy] ${file} 完了`));
          }
        }
        if (allOk) {
          console.log("");
          console.log(green(`[cloopy] バックアップ完了: ${backupDir}`));
        }
        break;
      }
      case "reset": {
        console.log(yellow("  すべての永続データが削除されます:"));
        console.log("    - home-data (ホームディレクトリ)");
        console.log("    - nix-store (Nix/Devbox)");
        console.log("    - ssh-config (SSH ホスト鍵)");
        console.log("");
        const sure = await Confirm.prompt({
          message: "本当にリセットしますか？",
          default: false,
        });
        if (sure) {
          console.log("[cloopy] 停止してボリュームを削除中...");
          await compose(projectRoot, ["down", "-v"]);
          console.log(green("[cloopy] 完了。「起動」で再作成できます。"));
        }
        break;
      }
      case "quit": {
        console.log("お疲れ様でした！");
        return;
      }
    }

    console.log("");
  }
}
