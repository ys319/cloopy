import { assertEquals, assertStringIncludes } from "@std/assert";
import { resolve } from "@std/path";
import {
  ensureIncludeLine,
  injectSshConfig,
  sshConfigPath,
  upsertHostBlock,
} from "./ssh.ts";

const isWindows = Deno.build.os === "windows";

function block(name: string, port: string): string {
  return [
    `# --- ${name} ---`,
    `Host ${name}`,
    `    HostName localhost`,
    `    Port ${port}`,
  ].join("\n");
}

// --------------------------------------------------------------------------
// upsertHostBlock
// --------------------------------------------------------------------------

Deno.test("upsertHostBlock: 空コンテンツにはバナー付きで追加", () => {
  const out = upsertHostBlock("", "cloopy", block("cloopy", "10022"));
  assertStringIncludes(out, "# cloopy - Claude Code sandbox");
  assertStringIncludes(out, "Host cloopy");
  assertEquals(out.endsWith("\n"), true);
});

Deno.test("upsertHostBlock: 既存コンテンツを保持して追記", () => {
  const existing = "# my config\nHost other\n    Port 22\n";
  const out = upsertHostBlock(existing, "cloopy", block("cloopy", "10022"));
  assertStringIncludes(out, "Host other");
  assertStringIncludes(out, "Host cloopy");
  // バナーは新規ファイルのみ
  assertEquals(out.includes("# cloopy - Claude Code sandbox"), false);
});

Deno.test("upsertHostBlock: 既存ブロックをインプレース置換（冪等）", () => {
  const v1 = upsertHostBlock("", "cloopy", block("cloopy", "10022"));
  const v2 = upsertHostBlock(v1, "cloopy", block("cloopy", "10022"));
  assertEquals(v2, v1);
});

Deno.test("upsertHostBlock: ポート変更が既存ブロックに反映される", () => {
  const v1 = upsertHostBlock("", "cloopy", block("cloopy", "10022"));
  const v2 = upsertHostBlock(v1, "cloopy", block("cloopy", "20022"));
  assertStringIncludes(v2, "Port 20022");
  assertEquals(v2.includes("Port 10022"), false);
  // Host 行は1つだけ（重複追記しない）
  assertEquals(v2.match(/^Host cloopy$/gm)?.length, 1);
});

Deno.test("upsertHostBlock: 他インスタンスのブロックは温存", () => {
  let content = upsertHostBlock("", "cloopy", block("cloopy", "10022"));
  content = upsertHostBlock(content, "cloopy2", block("cloopy2", "10023"));
  // cloopy だけ更新
  content = upsertHostBlock(content, "cloopy", block("cloopy", "30022"));
  assertStringIncludes(content, "Port 30022");
  assertStringIncludes(content, "# --- cloopy2 ---");
  assertStringIncludes(content, "Port 10023");
});

Deno.test("upsertHostBlock: ブロック内の $ シーケンスが化けない", () => {
  const v1 = upsertHostBlock("", "cloopy", block("cloopy", "10022"));
  const weird = block("cloopy", "10022") + "\n    IdentityFile /tmp/$&/key";
  const v2 = upsertHostBlock(v1, "cloopy", weird);
  assertStringIncludes(v2, "/tmp/$&/key");
});

// --------------------------------------------------------------------------
// ensureIncludeLine
// --------------------------------------------------------------------------

Deno.test("ensureIncludeLine: 未追加なら先頭に挿入", () => {
  const out = ensureIncludeLine(
    "Host example\n    Port 22\n",
    "Include /home/u/.ssh/cloopy/config",
  );
  assertEquals(
    out,
    "# --- cloopy ---\nInclude /home/u/.ssh/cloopy/config\n\n" +
      "Host example\n    Port 22\n",
  );
});

Deno.test("ensureIncludeLine: 追加済みなら null（書き込み不要）", () => {
  const content = "# --- cloopy ---\nInclude /home/u/.ssh/cloopy/config\n\n";
  assertEquals(
    ensureIncludeLine(content, "Include /home/u/.ssh/cloopy/config"),
    null,
  );
});

// --------------------------------------------------------------------------
// injectSshConfig（統合: HOME を一時ディレクトリに向けて実ファイルを検証）
// --------------------------------------------------------------------------

Deno.test({
  name: "injectSshConfig: 生成・更新・Include 非重複・tmp 残骸なし",
  ignore: isWindows,
  fn() {
    const tmp = Deno.makeTempDirSync();
    const origHome = Deno.env.get("HOME");
    Deno.env.set("HOME", tmp);
    try {
      injectSshConfig("10022");

      const cloopyConfig = Deno.readTextFileSync(sshConfigPath());
      assertStringIncludes(cloopyConfig, "Host cloopy");
      assertStringIncludes(cloopyConfig, "Port 10022");

      const mainConfig = Deno.readTextFileSync(
        resolve(tmp, ".ssh", "config"),
      );
      assertStringIncludes(mainConfig, `Include ${sshConfigPath()}`);

      // 2回目: ポート更新が反映され、Include は重複しない
      injectSshConfig("20022");
      const updated = Deno.readTextFileSync(sshConfigPath());
      assertStringIncludes(updated, "Port 20022");
      assertEquals(updated.includes("Port 10022"), false);
      const main2 = Deno.readTextFileSync(resolve(tmp, ".ssh", "config"));
      assertEquals(main2.match(/Include /g)?.length, 1);

      // アトミック書き込みの一時ファイルが残っていない
      for (
        const dir of [resolve(tmp, ".ssh"), resolve(tmp, ".ssh", "cloopy")]
      ) {
        for (const entry of Deno.readDirSync(dir)) {
          assertEquals(
            entry.name.endsWith(".tmp~"),
            false,
            `leftover temp file: ${dir}/${entry.name}`,
          );
        }
      }
    } finally {
      if (origHome === undefined) Deno.env.delete("HOME");
      else Deno.env.set("HOME", origHome);
      Deno.removeSync(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "injectSshConfig: ユーザーの既存 ~/.ssh/config を温存して先頭に Include",
  ignore: isWindows,
  fn() {
    const tmp = Deno.makeTempDirSync();
    const origHome = Deno.env.get("HOME");
    Deno.env.set("HOME", tmp);
    try {
      const mainPath = resolve(tmp, ".ssh", "config");
      Deno.mkdirSync(resolve(tmp, ".ssh"), { recursive: true });
      Deno.writeTextFileSync(mainPath, "Host myserver\n    Port 2222\n");

      injectSshConfig("10022");

      const main = Deno.readTextFileSync(mainPath);
      assertStringIncludes(main, "Host myserver");
      assertStringIncludes(main, "Port 2222");
      assertEquals(main.startsWith("# --- cloopy ---\n"), true);
    } finally {
      if (origHome === undefined) Deno.env.delete("HOME");
      else Deno.env.set("HOME", origHome);
      Deno.removeSync(tmp, { recursive: true });
    }
  },
});
