import { bold, cyan, dim, green, red, yellow } from "@std/fmt/colors";
import { resolve } from "@std/path";
import {
  checkBootstrapStatus,
  compose,
  composeSpawn,
  getContainerId,
  getProjectRoot,
  getStatus,
} from "../lib/compose.ts";
import {
  COMPOSE_UP_ARGS,
  DEFAULT_INSTANCE_NAME,
  DEFAULT_SSH_PORT,
} from "../lib/constants.ts";
import { readEnvFile } from "../lib/env.ts";
import { Confirm, Select } from "../lib/prompt.ts";
import { startTimer } from "../lib/spinner.ts";
import { injectSshConfig, refreshKnownHosts } from "../lib/ssh.ts";
import { doctor } from "./doctor.ts";
import { editSettings } from "./settings.ts";
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
  const env = readEnvFile(projectRoot);
  const instanceName = env.get("CLOOPY_INSTANCE_NAME") ?? DEFAULT_INSTANCE_NAME;

  while (true) {
    const status = await getStatus(projectRoot);

    console.clear();
    console.log("");
    console.log(bold(cyan(`  cloopy manager [${instanceName}]`)));
    console.log(dim("  状態: ") + statusColor(status));
    console.log("");

    const isRunning = status.startsWith("running");
    const choice = await Select.prompt({
      message: "操作を選択",
      maxRows: 20,
      options: [
        ...(
          isRunning
            ? [
              { name: "停止", value: "stop" },
              { name: "再起動", value: "restart" },
              { name: "ログ確認", value: "logs" },
              SEPARATOR,
              { name: "SSH 接続", value: "ssh" },
              { name: "VS Code で開く", value: "vscode" },
              { name: "管理シェル", value: "shell" },
            ]
            : [
              { name: "起動", value: "start" },
            ]
        ),
        SEPARATOR,
        { name: "リビルド", value: "rebuild" },
        { name: "再設定", value: "setup" },
        { name: "設定変更", value: "settings" },
        { name: "設定を表示", value: "config" },
        { name: "ヘルスチェック", value: "doctor" },
        { name: "バックアップ", value: "backup" },
        { name: "リストア", value: "restore" },
        { name: red("リセット"), value: "reset" },
        SEPARATOR,
        { name: "終了", value: "quit" },
      ],
    });

    console.log("");

    switch (choice) {
      case "start": {
        console.log("[cloopy] 起動中...");
        const startCode = await compose(projectRoot, [...COMPOSE_UP_ARGS]);
        if (startCode !== 0) {
          console.error(red("[cloopy] 起動に失敗しました"));
        } else {
          await checkBootstrapStatus(projectRoot);
        }
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
                if (buf[0] === 0x1b || buf[0] === 0x71 || buf[0] === 0x03) {
                  return;
                }
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
          args: [instanceName],
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
            args: [
              "--remote",
              `ssh-remote+${instanceName}`,
              "/home/developer/workspace",
            ],
            stdout: "inherit",
            stderr: "inherit",
          });
          const { code: exitCode } = await codeCmd.output();
          if (exitCode !== 0) {
            console.error(red("[cloopy] VS Code の起動に失敗しました"));
          }
        } catch {
          console.error(red("[cloopy] VS Code CLI (code) が見つかりません"));
          console.error(
            "  インストール: VS Code → コマンドパレット → \"Shell Command: Install 'code' command in PATH\"",
          );
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
          args: ["exec", "-it", "-u", "root", containerId, "/bin/bash"],
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        await exec.output();
        break;
      }
      case "rebuild": {
        const timer = startTimer("[cloopy] リビルド中...");
        const buildCode = await compose(projectRoot, ["build"]);
        timer.stop();
        if (buildCode === 0) {
          await compose(projectRoot, [...COMPOSE_UP_ARGS]);
          const env = readEnvFile(projectRoot);
          const port = env.get("CLOOPY_SSH_PORT") ?? DEFAULT_SSH_PORT;
          await refreshKnownHosts(port);
          await checkBootstrapStatus(projectRoot);
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
      case "settings": {
        const changed = await editSettings(projectRoot);
        if (!changed) break;
        if (isRunning) {
          const apply = await Confirm.prompt({
            message: "変更を反映するためコンテナを再作成しますか？",
            default: true,
          });
          if (apply) {
            console.log("[cloopy] 設定を反映中...");
            const code = await compose(projectRoot, [...COMPOSE_UP_ARGS]);
            if (code === 0) {
              const env2 = readEnvFile(projectRoot);
              const port2 = env2.get("CLOOPY_SSH_PORT") ?? DEFAULT_SSH_PORT;
              // Sync the ~/.ssh/config alias to the (possibly new) port the
              // freshly-recreated container now listens on, then refresh the
              // host key. Done only after a successful recreate, so declining
              // leaves the alias pointing at the still-running old container.
              injectSshConfig(port2, instanceName);
              await refreshKnownHosts(port2);
              await checkBootstrapStatus(projectRoot);
              console.log(green("[cloopy] 設定を反映しました"));
            } else {
              console.error(red("[cloopy] コンテナの再作成に失敗しました"));
            }
          } else {
            console.log(
              dim("[cloopy] 変更は次回の起動/再作成時に反映されます"),
            );
          }
        } else {
          console.log(dim("[cloopy] 変更は次回の起動時に反映されます"));
        }
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
        const prefix = backupEnv.get("CLOOPY_INSTANCE_NAME") ??
          DEFAULT_INSTANCE_NAME;
        const targets: { volume: string; file: string }[] = [
          { volume: `${prefix}_home-data`, file: "home-data.tar.gz" },
          { volume: `${prefix}_ssh-config`, file: "ssh-config.tar.gz" },
        ];
        if (backupEnv.get("CLOOPY_WORKSPACE_VOLUME") === "true") {
          targets.push({
            volume: `${prefix}_workspace-data`,
            file: "workspace-data.tar.gz",
          });
        }
        const ts = new Date().toISOString().slice(0, 19).replace(
          /[T:]/g,
          (c) => c === "T" ? "_" : "",
        );
        const backupDir = resolve(projectRoot, "backups", ts);
        Deno.mkdirSync(backupDir, { recursive: true });
        console.log(`[cloopy] バックアップ先: ${backupDir}`);
        console.log("");
        let allOk = true;
        for (const { volume, file } of targets) {
          const bkTimer = startTimer(`[cloopy] ${volume} をバックアップ中...`);
          const cmd = new Deno.Command("docker", {
            args: [
              "run",
              "--rm",
              "-v",
              `${volume}:/data:ro`,
              "-v",
              `${backupDir}:/backup`,
              "alpine",
              "tar",
              "czf",
              `/backup/${file}`,
              "-C",
              "/data",
              ".",
            ],
            stdout: "inherit",
            stderr: "inherit",
          });
          const { code } = await cmd.output();
          bkTimer.stop();
          if (code !== 0) {
            console.error(
              red(`[cloopy] ${volume} のバックアップに失敗しました`),
            );
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
      case "restore": {
        // バックアップ一覧を取得
        const backupsRoot = resolve(projectRoot, "backups");
        let backupDirs: string[] = [];
        try {
          for (const entry of Deno.readDirSync(backupsRoot)) {
            if (entry.isDirectory) backupDirs.push(entry.name);
          }
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) {
            console.error(red(`[cloopy] バックアップ一覧の取得に失敗: ${e}`));
          }
        }
        backupDirs = backupDirs.sort().reverse(); // 新しい順

        if (backupDirs.length === 0) {
          console.log(yellow("[cloopy] バックアップが見つかりません"));
          await pressAnyKey();
          break;
        }

        const selected = await Select.prompt({
          message: "リストアするバックアップを選択",
          options: backupDirs.map((d) => ({ name: d, value: d })),
        });
        const selectedDir = resolve(backupsRoot, selected);

        // バックアップ内の tar.gz を列挙してボリューム名にマッピング
        const restoreEnvMap = readEnvFile(projectRoot);
        const restorePrefix = restoreEnvMap.get("CLOOPY_INSTANCE_NAME") ??
          DEFAULT_INSTANCE_NAME;
        const FILE_TO_VOLUME: Record<string, string> = {
          "home-data.tar.gz": `${restorePrefix}_home-data`,
          "ssh-config.tar.gz": `${restorePrefix}_ssh-config`,
          "workspace-data.tar.gz": `${restorePrefix}_workspace-data`,
        };
        const found: { file: string; volume: string }[] = [];
        for (const [file, volume] of Object.entries(FILE_TO_VOLUME)) {
          try {
            Deno.statSync(resolve(selectedDir, file));
            found.push({ file, volume });
          } catch (e) {
            if (!(e instanceof Deno.errors.NotFound)) {
              console.error(red(`[cloopy] ${file} の確認に失敗: ${e}`));
            }
          }
        }

        if (found.length === 0) {
          console.error(red("[cloopy] リストア可能なファイルが見つかりません"));
          await pressAnyKey();
          break;
        }

        console.log("");
        console.log(yellow("  以下のボリュームを削除して復元します:"));
        for (const { volume } of found) console.log(`    - ${volume}`);
        console.log("");
        const sure = await Confirm.prompt({
          message: "続行しますか？",
          default: false,
        });
        if (!sure) break;

        // コンテナ停止
        console.log("[cloopy] コンテナを停止中...");
        await compose(projectRoot, ["down"]);
        console.log("");

        let allOk = true;
        for (const { file, volume } of found) {
          const rsTimer = startTimer(`[cloopy] ${volume} をリストア中...`);

          // ボリューム削除（存在しない場合はスキップ）
          await new Deno.Command("docker", {
            args: ["volume", "rm", volume],
            stdout: "null",
            stderr: "null",
          }).output();

          // ボリューム作成
          const create = await new Deno.Command("docker", {
            args: ["volume", "create", volume],
            stdout: "null",
            stderr: "inherit",
          }).output();
          if (create.code !== 0) {
            rsTimer.stop();
            console.error(red(`[cloopy] ${volume} の作成に失敗しました`));
            allOk = false;
            continue;
          }

          // tar.gz から展開
          const restore = await new Deno.Command("docker", {
            args: [
              "run",
              "--rm",
              "-v",
              `${volume}:/data`,
              "-v",
              `${selectedDir}:/backup:ro`,
              "alpine",
              "tar",
              "xzf",
              `/backup/${file}`,
              "-C",
              "/data",
            ],
            stdout: "inherit",
            stderr: "inherit",
          }).output();
          rsTimer.stop();
          if (restore.code !== 0) {
            console.error(red(`[cloopy] ${file} の展開に失敗しました`));
            allOk = false;
          } else {
            console.log(green(`[cloopy] ${volume} 完了`));
          }
        }

        if (allOk) {
          console.log("");
          console.log("[cloopy] コンテナを起動中...");
          const upCode = await compose(projectRoot, [...COMPOSE_UP_ARGS]);
          if (upCode === 0) {
            const restoreEnv = readEnvFile(projectRoot);
            const restorePort = restoreEnv.get("CLOOPY_SSH_PORT") ??
              DEFAULT_SSH_PORT;
            await refreshKnownHosts(restorePort);
            await checkBootstrapStatus(projectRoot);
            console.log(green("[cloopy] リストア完了"));
          } else {
            console.error(red("[cloopy] コンテナの起動に失敗しました"));
          }
        }
        await pressAnyKey();
        break;
      }
      case "reset": {
        // `down -v` だと docker-compose.local.yml で定義された workspace-data
        // （ユーザーの作業データ）まで削除してしまうため、消してよい
        // ボリュームだけを名指しで削除する。
        const resetEnv = readEnvFile(projectRoot);
        const resetPrefix = resetEnv.get("CLOOPY_INSTANCE_NAME") ??
          DEFAULT_INSTANCE_NAME;
        const resetVolumes = [
          `${resetPrefix}_home-data`,
          `${resetPrefix}_nix-store`,
          `${resetPrefix}_ssh-config`,
        ];
        console.log(yellow("  以下の永続データが削除されます:"));
        console.log("    - home-data (ホームディレクトリ)");
        console.log("    - nix-store (Nix/Devbox)");
        console.log("    - ssh-config (SSH ホスト鍵)");
        if (resetEnv.get("CLOOPY_WORKSPACE_VOLUME") === "true") {
          console.log(dim("    (workspace-data は保持されます)"));
        }
        console.log("");
        const sure = await Confirm.prompt({
          message: "本当にリセットしますか？",
          default: false,
        });
        if (sure) {
          console.log("[cloopy] 停止してボリュームを削除中...");
          await compose(projectRoot, ["down"]);
          let resetOk = true;
          for (const volume of resetVolumes) {
            const rm = await new Deno.Command("docker", {
              args: ["volume", "rm", volume],
              stdout: "null",
              stderr: "piped",
            }).output();
            if (rm.code !== 0) {
              const msg = new TextDecoder().decode(rm.stderr).trim();
              // 初回起動前などボリューム未作成の場合は正常扱い
              if (!msg.includes("no such volume")) {
                console.error(red(`[cloopy] ${volume} の削除に失敗: ${msg}`));
                resetOk = false;
              }
            }
          }
          if (resetOk) {
            console.log(green("[cloopy] 完了。「起動」で再作成できます。"));
          }
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
