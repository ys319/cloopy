import { doctor } from "./commands/doctor.ts";
import { manage } from "./commands/manage.ts";
import { buildAndStart, setup } from "./commands/setup.ts";

const command = Deno.args[0];

switch (command) {
  case undefined: {
    const result = await doctor();
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
