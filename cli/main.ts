import { doctor } from "./commands/doctor.ts";
import { manage } from "./commands/manage.ts";
import { manageRemotes } from "./commands/remote.ts";
import { buildAndStart, setup } from "./commands/setup.ts";
import { Confirm } from "./lib/prompt.ts";

const command = Deno.args[0];

switch (command) {
  case undefined: {
    const result = await doctor();
    if (result.dockerMissing) {
      // docker 未インストールのマシン (リモートの cloopy に繋ぐだけの
      // クライアント等) でもリモート接続設定だけは使えるようにする。
      // デーモン停止 (not responding) はここに来ない — Docker Desktop の
      // 起動忘れで既存ユーザーをリモート専用モードへ逸らさないため。
      const remoteOnly = await Confirm.prompt({
        message:
          "Docker が見つかりません (未インストール)。リモート接続設定のみ利用しますか？ (docker 不要)",
        default: true,
      });
      if (remoteOnly) {
        await manageRemotes();
        console.log("お疲れ様でした！");
        break;
      }
    }
    if (result.needsEnv) {
      // .env / SSH 鍵 / SSH 設定が未整備 → 対話セットアップ（起動まで含む）
      await setup();
    } else if (result.needsImage) {
      // イメージ未ビルドのみ → 対話なしでビルド＆起動
      await buildAndStart();
    }
    await manage();
    break;
  }
  case "setup":
    await setup();
    break;
  case "doctor":
    await doctor();
    break;
  default:
    console.error(`[cloopy] 不明なコマンド: ${command}`);
    console.error("使用方法: ./manage.sh [setup|doctor]");
    Deno.exit(1);
}
