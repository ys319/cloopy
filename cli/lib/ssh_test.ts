import { assertEquals, assertStringIncludes } from "@std/assert";
import { resolve } from "@std/path";
import {
  buildHostBlock,
  ensureIncludeLine,
  filterKnownHostsContent,
  hasHostBlock,
  injectSshConfig,
  knownHostsToken,
  removeHostBlock,
  removeKnownHostsEntry,
  removeSshConfigEntry,
  sshConfigPath,
  upsertHostBlock,
  upsertKnownHosts,
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

Deno.test("buildHostBlock: デフォルトはローカル (localhost)", () => {
  const out = buildHostBlock("cloopy", "10022");
  assertStringIncludes(out, "# --- cloopy ---");
  assertStringIncludes(out, "Host cloopy");
  assertStringIncludes(out, "HostName localhost");
  assertStringIncludes(out, "Port 10022");
  assertStringIncludes(out, "User developer");
  assertStringIncludes(out, "IdentityFile ");
  assertStringIncludes(out, "StrictHostKeyChecking accept-new");
  // ホスト鍵は標準 ~/.ssh/known_hosts に固定する (Claude Desktop の SSH は
  // UserKnownHostsFile を解釈せず標準ファイルしか見ないため、指定しない)
  assertEquals(out.includes("UserKnownHostsFile"), false);
});

Deno.test("buildHostBlock: リモート用オプションが反映される", () => {
  const out = buildHostBlock("ucore", "10022", {
    hostName: "192.168.1.50",
    identityFile: "/home/u/.ssh/cloopy/id_ed25519",
  });
  assertStringIncludes(out, "HostName 192.168.1.50");
  assertStringIncludes(out, "IdentityFile /home/u/.ssh/cloopy/id_ed25519");
  assertEquals(out.includes("UserKnownHostsFile"), false);
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

// --------------------------------------------------------------------------
// known_hosts 管理（標準 ~/.ssh/known_hosts のマーカー付き upsert）
// --------------------------------------------------------------------------

const KH_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHQyApelvmNP36aS5YbPI4X3a5TvQgsjb5QuMn9jaxCi";
// `ssh-keygen -H` が実際に生成したハッシュ行（HMAC-SHA1 照合の実フィクスチャ）
const KH_HASHED_LOCALHOST = // [localhost]:10022
  `|1|JufXJkq/rbS2JiVagr76gHJz82k=|c4c6ejVVkJiozB4Ny2kWkGANOp4= ${KH_KEY}`;
const KH_HASHED_OTHER = // [192.168.1.50]:10022
  `|1|+Q8PZ/obUgF+BaSKvXC1HYk7b3w=|Lj6MJtQesIhNGaQ0KR6E0gWH6JU= ${KH_KEY}`;

Deno.test("knownHostsToken: 22 番は素のホスト・それ以外は [host]:port", () => {
  assertEquals(knownHostsToken("example.com", "22"), "example.com");
  assertEquals(knownHostsToken("localhost", "10022"), "[localhost]:10022");
});

Deno.test("filterKnownHostsContent: マーカー行と token 完全一致行のみ除去", async () => {
  const content = [
    "# user comment",
    "",
    `[localhost]:10022 ${KH_KEY} cloopy:dev`, // マーカー → 除去
    `[LOCALHOST]:10022 ${KH_KEY}`, // 大文字 → 除去 (ssh のホスト名照合は大小無視)
    `[localhost]:20022 ${KH_KEY}`, // 別ポート → 温存
    `github.com ${KH_KEY}`, // 無関係 → 温存
    `@cert-authority [localhost]:10022 ${KH_KEY}`, // @ 行 → 温存
    `@revoked [localhost]:10022 ${KH_KEY}`, // @ 行 → 温存
    `*.example.com ${KH_KEY}`, // ワイルドカード → 温存
    "",
  ].join("\n");
  const out = await filterKnownHostsContent(content, "cloopy:dev", [
    "[localhost]:10022",
  ]);
  assertEquals(out.includes("cloopy:dev"), false);
  assertEquals(out.includes("[LOCALHOST]"), false);
  assertStringIncludes(out, "# user comment");
  assertStringIncludes(out, "[localhost]:20022");
  assertStringIncludes(out, "github.com");
  assertStringIncludes(out, "@cert-authority [localhost]:10022");
  assertStringIncludes(out, "@revoked [localhost]:10022");
  assertStringIncludes(out, "*.example.com");
});

Deno.test("filterKnownHostsContent: マーカー一致は host 不一致でも除去 (旧 pin 追跡)", async () => {
  // CLAUDE.md の不変条件「マーカー一致 = そのエントリ自身の旧 pin はホスト変更後も
  // 追える」を token 経路と分離して固定する。host が token に一致しない行が
  // マーカーだけで落ちること = マーカー経路の単独検証。
  const content = `[oldhost]:9999 ${KH_KEY} cloopy:dev\n`;
  const out = await filterKnownHostsContent(content, "cloopy:dev", [
    "[localhost]:10022",
  ]);
  assertEquals(out, "");
});

Deno.test("filterKnownHostsContent: カンマ複数別名行は一致した別名だけ落とす", async () => {
  // ユーザーが同一ホストの複数別名を 1 行にまとめて pin しているケース。
  // 行ごと消すと他の別名の pin まで失われる (敵対レビュー指摘) ため、
  // 一致した別名のみ落とし、全別名が一致したときだけ行ごと除去する。
  const grouped = `[192.168.1.50]:10022,[homelab.local]:10022 ${KH_KEY}`;
  const partial = await filterKnownHostsContent(grouped, "cloopy:dev", [
    "[192.168.1.50]:10022",
  ]);
  assertEquals(partial, `[homelab.local]:10022 ${KH_KEY}`);

  const full = await filterKnownHostsContent(grouped, "cloopy:dev", [
    "[192.168.1.50]:10022",
    "[homelab.local]:10022",
  ]);
  assertEquals(full, "");
});

Deno.test("filterKnownHostsContent: HashKnownHosts 行を HMAC 照合で除去", async () => {
  const content = [KH_HASHED_LOCALHOST, KH_HASHED_OTHER, ""].join("\n");
  const out = await filterKnownHostsContent(content, "cloopy:dev", [
    knownHostsToken("localhost", "10022"),
  ]);
  assertEquals(out.includes("JufXJkq"), false); // [localhost]:10022 → 除去
  assertStringIncludes(out, "+Q8PZ"); // 別ホスト → 温存
});

Deno.test("filterKnownHostsContent: 他エントリのマーカー・壊れた行は触らない", async () => {
  const content = [
    `[10.0.0.5]:10022 ${KH_KEY} cloopy:other`, // 別エントリのマーカー → 温存
    "|1|broken", // フィールド不足 → 温存
    `|1|not-base64!|??? ${KH_KEY}`, // 壊れたハッシュ → 温存
    "",
  ].join("\n");
  const out = await filterKnownHostsContent(content, "cloopy:dev", [
    "[localhost]:10022",
  ]);
  assertStringIncludes(out, "cloopy:other");
  assertStringIncludes(out, "|1|broken");
  assertStringIncludes(out, "|1|not-base64!");
});

Deno.test({
  name: "upsertKnownHosts: 新規作成 → 鍵差し替え → マーカー削除の一連動作",
  ignore: isWindows,
  async fn() {
    const tmp = Deno.makeTempDirSync();
    const origHome = Deno.env.get("HOME");
    Deno.env.set("HOME", tmp);
    try {
      const path = resolve(tmp, ".ssh", "known_hosts");

      // ファイル未存在 → 作成され、マーカー付きで追記される
      await upsertKnownHosts("dev", "localhost", "10022", [
        `[localhost]:10022 ${KH_KEY}`,
      ]);
      let content = Deno.readTextFileSync(path);
      assertEquals(content, `[localhost]:10022 ${KH_KEY} cloopy:dev\n`);

      // ユーザー行（末尾改行なし）の後ろに追記しても行が壊れない
      const KEY2 = "ssh-ed25519 AAAAtestSecondKey";
      Deno.writeTextFileSync(path, `github.com ${KH_KEY}`);
      await upsertKnownHosts("dev", "localhost", "10022", [
        `[localhost]:10022 ${KEY2}`,
      ]);
      content = Deno.readTextFileSync(path);
      assertEquals(
        content,
        `github.com ${KH_KEY}\n[localhost]:10022 ${KEY2} cloopy:dev\n`,
      );

      // 鍵が変わった体で再 upsert → 旧 pin は置換され重複しない
      await upsertKnownHosts("dev", "localhost", "10022", [
        `[localhost]:10022 ${KH_KEY}`,
      ]);
      content = Deno.readTextFileSync(path);
      assertEquals(content.includes(KEY2), false);
      assertEquals(content.match(/cloopy:dev/g)?.length, 1);
      assertStringIncludes(content, `github.com ${KH_KEY}`);

      // removeKnownHostsEntry はマーカー行のみ除去（ユーザー行は残す）
      await removeKnownHostsEntry("dev");
      content = Deno.readTextFileSync(path);
      assertEquals(content.includes("cloopy:dev"), false);
      assertStringIncludes(content, "github.com");

      // tmp 残骸なし
      for (const entry of Deno.readDirSync(resolve(tmp, ".ssh"))) {
        assertEquals(entry.name.endsWith(".tmp~"), false);
      }

      // ファイルが無い状態での remove は no-op
      Deno.removeSync(path);
      await removeKnownHostsEntry("dev");
    } finally {
      if (origHome === undefined) Deno.env.delete("HOME");
      else Deno.env.set("HOME", origHome);
      Deno.removeSync(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name: "upsertKnownHosts: ハッシュ化された旧エントリも token 一致で置換",
  ignore: isWindows,
  async fn() {
    const tmp = Deno.makeTempDirSync();
    const origHome = Deno.env.get("HOME");
    Deno.env.set("HOME", tmp);
    try {
      const path = resolve(tmp, ".ssh", "known_hosts");
      Deno.mkdirSync(resolve(tmp, ".ssh"), { recursive: true });
      // Ubuntu (HashKnownHosts yes) で手動 ssh した残骸を模倣
      Deno.writeTextFileSync(
        path,
        [KH_HASHED_LOCALHOST, KH_HASHED_OTHER, ""].join("\n"),
      );
      await upsertKnownHosts("dev", "localhost", "10022", [
        `[localhost]:10022 ${KH_KEY}`,
      ]);
      const content = Deno.readTextFileSync(path);
      assertEquals(content.includes("JufXJkq"), false); // 旧ハッシュ pin 除去
      assertStringIncludes(content, "+Q8PZ"); // 別ホストは温存
      assertStringIncludes(content, `[localhost]:10022 ${KH_KEY} cloopy:dev`);
    } finally {
      if (origHome === undefined) Deno.env.delete("HOME");
      else Deno.env.set("HOME", origHome);
      Deno.removeSync(tmp, { recursive: true });
    }
  },
});
