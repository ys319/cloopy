import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { resolve } from "@std/path";
import {
  authorizedKeysPath,
  buildAuthorizedKeysContent,
  fetchGithubKeys,
  fingerprintSha256,
  isSameKey,
  keyStorePath,
  loadKeyStore,
  parseKeysText,
  parsePublicKey,
  rebuildAuthorizedKeys,
  RSA_MIN_BITS,
  saveKeyStore,
  type StoredKey,
  validateGithubUsername,
  validatePublicKeyInput,
} from "./keys.ts";

const isWindows = Deno.build.os === "windows";

// 実鍵フィクスチャ。すべて ssh-keygen で生成した本物の公開鍵:
//   ED25519_A/B = ssh-keygen -t ed25519、RSA2048/RSA1024 = ssh-keygen -t rsa -b <bits>、
//   ECDSA256 = ssh-keygen -t ecdsa -b 256。
// *_FP は対応する鍵の `ssh-keygen -lf` 出力 (SHA256 指紋) の実値。
const ED25519_A =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN1jvHqJGAUHG3RopolrRulV2YzqdsYg2xkNbRsWfkw+ alice@example";
const ED25519_A_FP = "SHA256:JfEE3AlUF+JgiShAmqSULf/+Yv5YAAQQFI71jBe2xaE";
const ED25519_B =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIbwxP1QRJ6TwnMrHYB9Nw8PvBaTMFPWmGnNf96k6/Lv";
const RSA2048 =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDUeDa/8URykmn2q5UPT/Daq2uV7ZBlMoXAhf8j7pcDBC938auVKBgMISIGYYkZi1SQJ/wo7+YD/U1v2N3q5id68WLoyrHySsNZPGkvC2FfxZupbqcx6lFvZmAsGMYvOrE7Wafb+qJjPA4AEvFy5++00bJEef6irfL3WUZnXPoeDgpUa38NzyqntJAxo0VADu4Mv/zwyJETr0muWZ6h4jqwoUIF77c8k77YoFWVbXz8cpoXXIuWOQT5ljF64gWjGpslMY7r3SJfwdAzlUj91ycteMxuXjJXOORQOMaAZhPoHoEXUFE6r6F2PgxscL7wx7Wg7a+evHaGqpXJYK2/SV0t bob@example";
const RSA2048_FP = "SHA256:Xq13h83967rXqMyBs5oa2CzYQQOJX7bK5EoyAPBiaNg";
const RSA1024 =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDDFv1d+26bedHLj2MfA2Hfxjf9Bo50VsR7hTkCijg2akJ6RFuFRnOFFwOHpfM24c/sZ+PVphcnePH4GrIVZkEVfEcsHn6QnGyIgWA2TCXMLYH5IFych4xQ3JAaBimzmaaFjyt/9Gyrf3GtqiZslqb7i5QB8xw64n2yHI5ikEB4dQ== weak@example";
const ECDSA256 =
  "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBIHbRmOgmYr30lYq2XnzeOJmWkkBkj4KYsxCgrzuwKc/CHKNHxzlgP/syXXZIl1j4SAx+xYnSu0a63N8aDEZmQY= carol@example";

function field(line: string, i: number): string {
  return line.split(/\s+/)[i];
}

function storedKey(line: string, label = ""): StoredKey {
  const r = parsePublicKey(line);
  if (!r.ok) throw new Error(r.error);
  return { ...r.key, comment: r.key.comment, label, addedAt: "2026-06-10" };
}

// --------------------------------------------------------------------------
// parsePublicKey
// --------------------------------------------------------------------------

Deno.test("parsePublicKey: ed25519 (コメント付き) を受理", () => {
  const r = parsePublicKey(ED25519_A);
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.key.type, "ssh-ed25519");
    assertEquals(r.key.base64, field(ED25519_A, 1));
    assertEquals(r.key.comment, "alice@example");
    assertEquals(r.key.rsaBits, undefined);
  }
});

Deno.test("parsePublicKey: コメントなし・CRLF/空白付きを受理", () => {
  const r = parsePublicKey(`  ${ED25519_B}\r\n`);
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.key.comment, "");
});

Deno.test("parsePublicKey: 空白を含むコメントを保持", () => {
  const r = parsePublicKey(ED25519_A + " extra words");
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.key.comment, "alice@example extra words");
});

Deno.test("parsePublicKey: rsa の鍵長を検出 (2048 / 1024)", () => {
  const r2048 = parsePublicKey(RSA2048);
  const r1024 = parsePublicKey(RSA1024);
  if (r2048.ok && r1024.ok) {
    assertEquals(r2048.key.rsaBits, 2048);
    assertEquals(r1024.key.rsaBits, 1024);
  } else {
    throw new Error("RSA keys should parse");
  }
});

Deno.test("RSA_MIN_BITS: 1024 bit 鍵は警告閾値を下回る", () => {
  const r = parsePublicKey(RSA1024);
  if (!r.ok) throw new Error("RSA1024 should parse");
  assertEquals(
    r.key.rsaBits !== undefined && r.key.rsaBits < RSA_MIN_BITS,
    true,
  );
});

Deno.test("validatePublicKeyInput: 受理は true、拒否は理由文字列", () => {
  assertEquals(validatePublicKeyInput(ED25519_A), true);
  assertEquals(typeof validatePublicKeyInput(""), "string");
  assertEquals(typeof validatePublicKeyInput("not a key"), "string");
});

Deno.test("parsePublicKey: ecdsa-sha2-nistp256 を受理", () => {
  assertEquals(parsePublicKey(ECDSA256).ok, true);
});

Deno.test("parsePublicKey: ssh-dss は拒否", () => {
  const r = parsePublicKey("ssh-dss AAAAB3NzaC1kc3M= legacy@example");
  assertEquals(r.ok, false);
  if (!r.ok) assertStringIncludes(r.error, "DSA");
});

Deno.test("parsePublicKey: 未知の鍵種別 / options 付き行は拒否", () => {
  assertEquals(parsePublicKey("ssh-foo AAAA bar").ok, false);
  assertEquals(
    parsePublicKey(`command="echo" ${ED25519_A}`).ok,
    false,
  );
});

Deno.test("parsePublicKey: 種別と blob の不一致を拒否", () => {
  // ed25519 プレフィックス + rsa の鍵データ
  const r = parsePublicKey(`ssh-ed25519 ${field(RSA2048, 1)}`);
  assertEquals(r.ok, false);
  if (!r.ok) assertStringIncludes(r.error, "一致しません");
});

Deno.test("parsePublicKey: 不正 base64 / 破損 blob を拒否", () => {
  assertEquals(parsePublicKey("ssh-ed25519 not-base64!!").ok, false);
  assertEquals(parsePublicKey("ssh-ed25519 QQ==").ok, false); // 1 byte
  assertEquals(parsePublicKey("ssh-ed25519").ok, false); // データなし
  assertEquals(parsePublicKey("").ok, false);
});

// --------------------------------------------------------------------------
// fingerprintSha256 / isSameKey
// --------------------------------------------------------------------------

Deno.test("fingerprintSha256: ssh-keygen -lf と一致", async () => {
  assertEquals(await fingerprintSha256(field(ED25519_A, 1)), ED25519_A_FP);
  assertEquals(await fingerprintSha256(field(RSA2048, 1)), RSA2048_FP);
});

Deno.test("isSameKey: コメント差は同一、鍵データ差は別物", () => {
  const a = storedKey(ED25519_A);
  const b = storedKey(ED25519_A + " renamed comment");
  const c = storedKey(ED25519_B);
  assertEquals(isSameKey(a, b), true);
  assertEquals(isSameKey(a, c), false);
});

// --------------------------------------------------------------------------
// buildAuthorizedKeysContent
// --------------------------------------------------------------------------

Deno.test("buildAuthorizedKeysContent: 自動鍵が先頭・ラベル優先・末尾改行", () => {
  const content = buildAuthorizedKeysContent("auto-key-line", [
    storedKey(ED25519_A), // comment あり・label なし → comment
    storedKey(ED25519_B, "github:foo"), // comment なし・label あり → label
  ]);
  const lines = content.split("\n");
  assertEquals(lines[0].startsWith("#"), true);
  assertEquals(lines[1], "auto-key-line");
  assertEquals(lines[2], ED25519_A);
  assertEquals(
    lines[3],
    `${field(ED25519_B, 0)} ${field(ED25519_B, 1)} github:foo`,
  );
  assertEquals(content.endsWith("\n"), true);
});

Deno.test("buildAuthorizedKeysContent: 追加鍵なしでも自動鍵のみで成立", () => {
  const content = buildAuthorizedKeysContent(ED25519_A, []);
  assertStringIncludes(content, ED25519_A);
});

// --------------------------------------------------------------------------
// GitHub username / .keys レスポンス
// --------------------------------------------------------------------------

Deno.test("validateGithubUsername: 正常系と異常系", () => {
  for (const ok of ["octocat", "a", "a-b-c", "A1", "a".repeat(39)]) {
    assertEquals(validateGithubUsername(ok), true, ok);
  }
  for (
    const bad of ["", "-a", "a-", "a--b", "a".repeat(40), "a_b", "a.b", "a/b"]
  ) {
    assertEquals(validateGithubUsername(bad), false, bad);
  }
});

Deno.test("parseKeysText: 複数鍵 + 空行 + 不正行", () => {
  const { keys, invalid } = parseKeysText(
    `${ED25519_A}\n\n${RSA2048}\nnot a key\n`,
  );
  assertEquals(keys.length, 2);
  assertEquals(invalid, ["not a key"]);
});

Deno.test("fetchGithubKeys: 200 → ok / 404 → not_found / 空 → empty / 500 → error", async () => {
  let requestedUrl = "";
  const mock = (body: string | null, status: number): typeof fetch =>
    ((input: string | URL | Request) => {
      requestedUrl = String(input);
      return Promise.resolve(new Response(body, { status }));
    }) as typeof fetch;

  const ok = await fetchGithubKeys("octocat", mock(`${ED25519_B}\n`, 200));
  assertEquals(ok.status, "ok");
  if (ok.status === "ok") assertEquals(ok.keys.length, 1);
  assertEquals(requestedUrl, "https://github.com/octocat.keys");

  assertEquals(
    (await fetchGithubKeys("octocat", mock("Not Found", 404))).status,
    "not_found",
  );
  assertEquals(
    (await fetchGithubKeys("octocat", mock("", 200))).status,
    "empty",
  );
  assertEquals(
    (await fetchGithubKeys("octocat", mock("oops", 500))).status,
    "error",
  );
  // 不正なユーザー名は fetch 自体に到達しない
  requestedUrl = "";
  const bad = await fetchGithubKeys("a--b", mock("", 200));
  assertEquals(bad.status, "error");
  assertEquals(requestedUrl, "");
});

Deno.test("fetchGithubKeys: fetch の例外 (DNS 失敗等) は error に落ちる", async () => {
  const netErr: typeof fetch = () => Promise.reject(new Error("ENOTFOUND"));
  const res = await fetchGithubKeys("octocat", netErr);
  assertEquals(res.status, "error");
});

// --------------------------------------------------------------------------
// store / rebuild（統合: HOME を一時ディレクトリへ）
// --------------------------------------------------------------------------

function withTempHome(fn: (tmp: string) => void): void {
  const tmp = Deno.makeTempDirSync();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmp);
  try {
    fn(tmp);
  } finally {
    if (origHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", origHome);
    Deno.removeSync(tmp, { recursive: true });
  }
}

Deno.test({
  name: "keyStore: 往復保存・未作成は空 store（インスタンス別パス）",
  ignore: isWindows,
  fn() {
    withTempHome((tmp) => {
      assertEquals(loadKeyStore("cloopy").keys.length, 0);
      saveKeyStore("cloopy", {
        version: 1,
        keys: [storedKey(ED25519_A, "manual")],
      });
      // store はインスタンスディレクトリ配下に置かれる
      assertEquals(
        keyStorePath("cloopy"),
        resolve(tmp, ".ssh", "cloopy", "instances", "cloopy", "keys.json"),
      );
      const loaded = loadKeyStore("cloopy");
      assertEquals(loaded.keys.length, 1);
      assertEquals(loaded.keys[0].label, "manual");
      assertEquals(loaded.keys[0].base64, field(ED25519_A, 1));
    });
  },
});

Deno.test({
  name: "keyStore: インスタンスごとに独立（片方への追加が他方に波及しない）",
  ignore: isWindows,
  fn() {
    withTempHome(() => {
      saveKeyStore("alpha", { version: 1, keys: [storedKey(ED25519_A)] });
      saveKeyStore("beta", { version: 1, keys: [] });
      assertEquals(loadKeyStore("alpha").keys.length, 1);
      assertEquals(loadKeyStore("beta").keys.length, 0);
    });
  },
});

Deno.test({
  name: "keyStore: 破損 JSON / 形式不正は明示エラー（空扱いにしない）",
  ignore: isWindows,
  fn() {
    withTempHome(() => {
      saveKeyStore("cloopy", { version: 1, keys: [] });
      Deno.writeTextFileSync(keyStorePath("cloopy"), "{ broken");
      assertThrows(() => loadKeyStore("cloopy"), Error, "JSON");
      Deno.writeTextFileSync(keyStorePath("cloopy"), `{"version":2,"keys":[]}`);
      assertThrows(() => loadKeyStore("cloopy"), Error, "形式が不正");
    });
  },
});

Deno.test({
  name:
    "keyStore: 旧グローバル store を初回アクセスでコピー移行（レガシーは残置）",
  ignore: isWindows,
  fn() {
    withTempHome((tmp) => {
      const legacyPath = resolve(tmp, ".ssh", "cloopy", "keys.json");
      Deno.mkdirSync(resolve(tmp, ".ssh", "cloopy"), { recursive: true });
      Deno.writeTextFileSync(
        legacyPath,
        JSON.stringify({
          version: 1,
          keys: [storedKey(ED25519_A, "legacy")],
        }),
      );

      // 初回ロード: レガシーの内容が返り、インスタンス store が作成される
      const migrated = loadKeyStore("cloopy");
      assertEquals(migrated.keys.length, 1);
      assertEquals(migrated.keys[0].label, "legacy");
      assertEquals(Deno.statSync(keyStorePath("cloopy")).isFile, true);
      // レガシーは消さない（別インスタンスの移行元として残す）
      assertEquals(Deno.statSync(legacyPath).isFile, true);
      // 移行が作るのは store のみ — 束の生成は setup / 鍵管理の責務
      assertThrows(() => Deno.statSync(authorizedKeysPath("cloopy")));

      // 移行後は独立: レガシーを書き換えてもインスタンス側は変わらない
      Deno.writeTextFileSync(
        legacyPath,
        JSON.stringify({ version: 1, keys: [] }),
      );
      assertEquals(loadKeyStore("cloopy").keys.length, 1);
      // 別インスタンスは（書き換え後の）レガシーから改めて移行する
      assertEquals(loadKeyStore("second").keys.length, 0);
    });
  },
});

Deno.test({
  name: "keyStore: レガシー store が破損していても明示エラー（空扱いにしない）",
  ignore: isWindows,
  fn() {
    withTempHome((tmp) => {
      Deno.mkdirSync(resolve(tmp, ".ssh", "cloopy"), { recursive: true });
      Deno.writeTextFileSync(
        resolve(tmp, ".ssh", "cloopy", "keys.json"),
        "{ broken",
      );
      assertThrows(() => loadKeyStore("cloopy"), Error, "JSON");
      // 破損レガシーからインスタンス store を作らない
      assertThrows(() => Deno.statSync(keyStorePath("cloopy")));
    });
  },
});

Deno.test({
  name: "rebuildAuthorizedKeys: 自動鍵 + store の鍵で束を生成",
  ignore: isWindows,
  fn() {
    withTempHome((tmp) => {
      const dir = resolve(tmp, ".ssh", "cloopy");
      Deno.mkdirSync(dir, { recursive: true });
      Deno.writeTextFileSync(resolve(dir, "id_ed25519.pub"), ED25519_A + "\n");
      saveKeyStore("cloopy", {
        version: 1,
        keys: [storedKey(ED25519_B, "github:foo")],
      });

      const count = rebuildAuthorizedKeys("cloopy");
      assertEquals(count, 1);
      assertEquals(
        authorizedKeysPath("cloopy"),
        resolve(dir, "instances", "cloopy", "authorized_keys"),
      );
      const bundle = Deno.readTextFileSync(authorizedKeysPath("cloopy"));
      const keyLines = bundle.split("\n").filter((l) =>
        l && !l.startsWith("#")
      );
      assertEquals(keyLines.length, 2);
      assertEquals(keyLines[0], ED25519_A); // 自動鍵が先頭
      assertStringIncludes(keyLines[1], "github:foo");

      // 一時ファイルの残骸なし
      for (
        const entry of Deno.readDirSync(resolve(dir, "instances", "cloopy"))
      ) {
        assertEquals(entry.name.endsWith(".tmp~"), false, entry.name);
      }

      // 束ファイルは 0600 (writeFileAtomic の回帰防止)
      const st = Deno.statSync(authorizedKeysPath("cloopy"));
      assertEquals(st.mode! & 0o777, 0o600);

      // instances ツリーは 0700 (インスタンス名の列挙も他ユーザーに許さない)
      for (
        const d of [
          resolve(dir, "instances"),
          resolve(dir, "instances", "cloopy"),
        ]
      ) {
        assertEquals(Deno.statSync(d).mode! & 0o777, 0o700, d);
      }
    });
  },
});

Deno.test({
  name: "rebuildAuthorizedKeys: keys 省略時はレガシー移行込みで store を読む",
  ignore: isWindows,
  fn() {
    withTempHome((tmp) => {
      const dir = resolve(tmp, ".ssh", "cloopy");
      Deno.mkdirSync(dir, { recursive: true });
      Deno.writeTextFileSync(resolve(dir, "id_ed25519.pub"), ED25519_A + "\n");
      // インスタンス store なし・レガシーのみの状態
      Deno.writeTextFileSync(
        resolve(dir, "keys.json"),
        JSON.stringify({
          version: 1,
          keys: [storedKey(ED25519_B, "legacy-key")],
        }),
      );

      const count = rebuildAuthorizedKeys("cloopy");
      assertEquals(count, 1);
      assertStringIncludes(
        Deno.readTextFileSync(authorizedKeysPath("cloopy")),
        "legacy-key",
      );
      // 移行も完了している
      assertEquals(Deno.statSync(keyStorePath("cloopy")).isFile, true);
    });
  },
});

Deno.test("instanceKeysDir: 不正なインスタンス名はパス構築前に拒否", () => {
  // .env 手編集で CLOOPY_INSTANCE_NAME に何が入っていても instances/ の
  // 外へ書き込まないこと (resolve は ../ を畳んでしまう)
  for (const bad of ["../evil", "..", "a/b", "/abs", "", "1abc", "a b"]) {
    assertThrows(() => keyStorePath(bad), Error, "インスタンス名", bad);
  }
  assertStringIncludes(keyStorePath("dev-2"), "instances");
});

Deno.test({
  name: "rebuildAuthorizedKeys: 自動鍵がなければエラー（空の束を書かない）",
  ignore: isWindows,
  fn() {
    withTempHome(() => {
      assertThrows(() => rebuildAuthorizedKeys("cloopy"), Error, "setup");
      // 束ファイルは生成されていない
      assertThrows(() => Deno.statSync(authorizedKeysPath("cloopy")));
    });
  },
});
