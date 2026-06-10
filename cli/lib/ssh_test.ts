import { assertEquals, assertStringIncludes } from "@std/assert";
import { resolve } from "@std/path";
import {
  buildHostBlock,
  ensureIncludeLine,
  hasHostBlock,
  injectSshConfig,
  removeHostBlock,
  removeSshConfigEntry,
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
// buildHostBlock
// --------------------------------------------------------------------------

Deno.test("buildHostBlock: デフォルトはローカル (localhost + 共有 known_hosts)", () => {
  const out = buildHostBlock("cloopy", "10022");
  assertStringIncludes(out, "# --- cloopy ---");
  assertStringIncludes(out, "Host cloopy");
  assertStringIncludes(out, "HostName localhost");
  assertStringIncludes(out, "Port 10022");
  assertStringIncludes(out, "User developer");
  assertStringIncludes(out, "IdentityFile ");
  assertStringIncludes(out, "StrictHostKeyChecking accept-new");
  assertStringIncludes(out, "UserKnownHostsFile ");
});

Deno.test("buildHostBlock: リモート用オプションが反映される", () => {
  const out = buildHostBlock("ucore", "10022", {
    hostName: "192.168.1.50",
    identityFile: "/home/u/.ssh/cloopy/id_ed25519",
    knownHostsFile: "/home/u/.ssh/cloopy/known_hosts.d/ucore",
  });
  assertStringIncludes(out, "HostName 192.168.1.50");
  assertStringIncludes(out, "IdentityFile /home/u/.ssh/cloopy/id_ed25519");
  assertStringIncludes(
    out,
    "UserKnownHostsFile /home/u/.ssh/cloopy/known_hosts.d/ucore",
  );
});

Deno.test("buildHostBlock: identityFile null で IdentityFile 行を省略", () => {
  const out = buildHostBlock("remote", "22", { identityFile: null });
  assertEquals(out.includes("IdentityFile"), false);
  // 省略しても他の行は揃っている
  assertStringIncludes(out, "StrictHostKeyChecking accept-new");
});

// --------------------------------------------------------------------------
// removeHostBlock / hasHostBlock
// --------------------------------------------------------------------------

Deno.test("removeHostBlock: 中間のブロックを除去し他は温存", () => {
  let content = upsertHostBlock("", "a", block("a", "1"));
  content = upsertHostBlock(content, "b", block("b", "2"));
  content = upsertHostBlock(content, "c", block("c", "3"));
  const out = removeHostBlock(content, "b");
  assertEquals(out.includes("Host b"), false);
  assertStringIncludes(out, "# --- a ---");
  assertStringIncludes(out, "# --- c ---");
  assertStringIncludes(out, "Port 3");
  // 除去跡に空行が無限に増えない
  assertEquals(out.includes("\n\n\n"), false);
});

Deno.test("removeHostBlock: 末尾のブロックを除去しても末尾改行は1つ", () => {
  let content = upsertHostBlock("", "a", block("a", "1"));
  content = upsertHostBlock(content, "b", block("b", "2"));
  const out = removeHostBlock(content, "b");
  assertEquals(out.includes("Host b"), false);
  assertStringIncludes(out, "Host a");
  assertEquals(out.endsWith("\n"), true);
  assertEquals(out.endsWith("\n\n\n"), false);
});

Deno.test("removeHostBlock: 存在しない名前は無変更", () => {
  const content = upsertHostBlock("", "a", block("a", "1"));
  assertEquals(removeHostBlock(content, "zzz"), content);
});

Deno.test("removeHostBlock: 似た名前のブロックを巻き込まない", () => {
  let content = upsertHostBlock("", "cloopy", block("cloopy", "1"));
  content = upsertHostBlock(
    content,
    "cloopy-remote",
    block("cloopy-remote", "2"),
  );
  const out = removeHostBlock(content, "cloopy");
  assertEquals(out.match(/^Host cloopy$/gm), null);
  assertStringIncludes(out, "Host cloopy-remote");
});

Deno.test("hasHostBlock: upsert 済みなら true・未登録なら false", () => {
  const content = upsertHostBlock("", "cloopy", block("cloopy", "1"));
  assertEquals(hasHostBlock(content, "cloopy"), true);
  assertEquals(hasHostBlock(content, "cloopy-remote"), false);
  assertEquals(hasHostBlock("", "cloopy"), false);
});

Deno.test("hasHostBlock: ファイル先頭のブロックも検出する", () => {
  // バナー無しでブロックが先頭から始まるケース
  const content = block("top", "1") + "\n";
  assertEquals(hasHostBlock(content, "top"), true);
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
    "CRLF 手編集 config: upsert は二重追加せず remove も効く（読み取り正規化）",
  ignore: isWindows,
  fn() {
    const tmp = Deno.makeTempDirSync();
    const origHome = Deno.env.get("HOME");
    Deno.env.set("HOME", tmp);
    try {
      // LF で生成 → CRLF エディタ保存を模倣
      injectSshConfig("10022");
      injectSshConfig("20022", "ucore", { hostName: "192.168.1.50" });
      const lf = Deno.readTextFileSync(sshConfigPath());
      Deno.writeTextFileSync(sshConfigPath(), lf.replaceAll("\n", "\r\n"));

      // upsert: CRLF でも既存ブロックを検出し二重追加しない
      injectSshConfig("10022");
      const afterUpsert = Deno.readTextFileSync(sshConfigPath());
      assertEquals(afterUpsert.match(/^Host cloopy$/gm)?.length, 1);

      // remove: CRLF 由来の取り残しなくブロックが消える
      removeSshConfigEntry("ucore");
      const afterRemove = Deno.readTextFileSync(sshConfigPath());
      assertEquals(afterRemove.includes("Host ucore"), false);
      assertStringIncludes(afterRemove, "Host cloopy");
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
