import { bold, cyan, dim, green, red, yellow } from "@std/fmt/colors";
import {
  compose,
  composeSpawn,
  getContainerId,
  getProjectRoot,
  getStatus,
} from "../lib/compose.ts";
import { readEnvFile } from "../lib/env.ts";
import { Confirm, Select } from "../lib/prompt.ts";
import { setup } from "./setup.ts";

function statusColor(status: string): string {
  if (status.includes("running")) return green(status);
  if (status === "not running") return red(status);
  return yellow(status);
}

const SEPARATOR = Select.separator("────────────────────────────");

export async function manage(): Promise<void> {
  const projectRoot = getProjectRoot();

  while (true) {
    const status = await getStatus(projectRoot);

    console.log("");
    console.log(bold(cyan("  cloopy manager")));
    console.log(dim("  状態: ") + statusColor(status));
    console.log("");

    const choice = await Select.prompt({
      message: "操作を選択",
      options: [
        { name: "起動", value: "start" },
        { name: "停止", value: "stop" },
        { name: "再起動", value: "restart" },
        { name: "ログ確認", value: "logs" },
        SEPARATOR,
        { name: "SSH 接続", value: "ssh" },
        { name: "VS Code で開く", value: "vscode" },
        { name: "シェル (docker exec)", value: "shell" },
        SEPARATOR,
        { name: "リビルド", value: "rebuild" },
        { name: "セットアップ (再設定)", value: "setup" },
        { name: "設定を表示", value: "config" },
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
          console.log("[cloopy] ログを追っています... (Enter で停止)\n");
          const child = composeSpawn(projectRoot, ["logs", "-f"]);
          const buf = new Uint8Array(64);
          Deno.stdin.readSync(buf);
          try {
            child.kill("SIGTERM");
          } catch { /* already exited */ }
          await child.status;
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
        const code = new Deno.Command("code", {
          args: ["--remote", "ssh-remote+cloopy", "/home/developer/workspace"],
          stdout: "inherit",
          stderr: "inherit",
        });
        await code.output();
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
        } else {
          console.error(red("[cloopy] ビルドに失敗しました"));
        }
        break;
      }
      case "setup": {
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
