import { doctor } from "./commands/doctor.ts";
import { manage } from "./commands/manage.ts";
import { setup } from "./commands/setup.ts";

const command = Deno.args[0];

switch (command) {
  case undefined: {
    const needsSetup = await doctor();
    if (needsSetup) {
      await setup();
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
