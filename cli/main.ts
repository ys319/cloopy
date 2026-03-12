import { doctor } from "./commands/doctor.ts";
import { manage } from "./commands/manage.ts";
import { setup } from "./commands/setup.ts";

const command = Deno.args[0];

switch (command) {
  case "setup":
    await setup();
    break;
  case "doctor":
    await doctor();
    break;
  default: {
    const needsSetup = await doctor();
    if (needsSetup) {
      await setup();
    }
    await manage();
  }
}
