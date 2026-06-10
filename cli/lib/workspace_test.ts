import { assertEquals } from "@std/assert";
import { dirname, resolve } from "@std/path";
import { validateWorkspacePath } from "./workspace.ts";

const HOME = Deno.env.get("HOME") ?? "";
const isWindows = Deno.build.os === "windows";

Deno.test("validateWorkspacePath: デフォルトの相対パスは許可", () => {
  assertEquals(validateWorkspacePath("./workspace"), true);
});

Deno.test("validateWorkspacePath: 空文字は拒否", () => {
  assertEquals(typeof validateWorkspacePath("  "), "string");
});

Deno.test({
  name: "validateWorkspacePath: システムディレクトリは拒否",
  ignore: isWindows,
  fn() {
    for (const p of ["/", "/etc", "/home", "/var/home", "/usr"]) {
      assertEquals(typeof validateWorkspacePath(p), "string", p);
    }
  },
});

Deno.test({
  name: "validateWorkspacePath: $HOME 自体と ~ は拒否",
  ignore: isWindows || !HOME,
  fn() {
    assertEquals(typeof validateWorkspacePath(HOME), "string");
    assertEquals(typeof validateWorkspacePath("~"), "string");
    // 末尾スラッシュでも拒否
    assertEquals(typeof validateWorkspacePath(HOME + "/"), "string");
  },
});

Deno.test({
  name: "validateWorkspacePath: ~/.ssh 配下は拒否",
  ignore: isWindows || !HOME,
  fn() {
    assertEquals(typeof validateWorkspacePath("~/.ssh"), "string");
    assertEquals(
      typeof validateWorkspacePath(resolve(HOME, ".ssh", "cloopy")),
      "string",
    );
  },
});

Deno.test({
  name: "validateWorkspacePath: $HOME 直下のサブディレクトリは許可",
  ignore: isWindows || !HOME,
  fn() {
    assertEquals(validateWorkspacePath("~/projects"), true);
    assertEquals(validateWorkspacePath(resolve(HOME, "work", "repo")), true);
  },
});

Deno.test({
  name: "validateWorkspacePath: $HOME の親ディレクトリは拒否",
  ignore: isWindows || !HOME,
  fn() {
    assertEquals(typeof validateWorkspacePath(dirname(HOME)), "string");
  },
});

Deno.test({
  name: "validateWorkspacePath: $HOME へのシンボリックリンクは拒否",
  ignore: isWindows || !HOME,
  fn() {
    const dir = Deno.makeTempDirSync();
    try {
      const link = resolve(dir, "home-link");
      Deno.symlinkSync(HOME, link);
      assertEquals(typeof validateWorkspacePath(link), "string");
      // リンク配下の ~/.ssh 相当も拒否
      assertEquals(
        typeof validateWorkspacePath(resolve(link, ".ssh")),
        "string",
      );
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});
