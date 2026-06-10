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
  saveKeyStore,
  type StoredKey,
  validateGithubUsername,
} from "./keys.ts";

const isWindows = Deno.build.os === "windows";

// 実鍵フィクスチャ（ssh-keygen で生成、指紋は ssh-keygen -lf の出力）
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
  name: "keyStore: 往復保存・未作成は空 store",
  ignore: isWindows,
  fn() {
    withTempHome(() => {
      assertEquals(loadKeyStore().keys.length, 0);
      saveKeyStore({ version: 1, keys: [storedKey(ED25519_A, "manual")] });
      const loaded = loadKeyStore();
      assertEquals(loaded.keys.length, 1);
      assertEquals(loaded.keys[0].label, "manual");
      assertEquals(loaded.keys[0].base64, field(ED25519_A, 1));
    });
  },
});

Deno.test({
  name: "keyStore: 破損 JSON / 形式不正は明示エラー（空扱いにしない）",
  ignore: isWindows,
  fn() {
    withTempHome((tmp) => {
      Deno.mkdirSync(resolve(tmp, ".ssh", "cloopy"), { recursive: true });
      Deno.writeTextFileSync(keyStorePath(), "{ broken");
      assertThrows(() => loadKeyStore(), Error, "JSON");
      Deno.writeTextFileSync(keyStorePath(), `{"version":2,"keys":[]}`);
      assertThrows(() => loadKeyStore(), Error, "形式が不正");
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
      saveKeyStore({
        version: 1,
        keys: [storedKey(ED25519_B, "github:foo")],
      });

      const count = rebuildAuthorizedKeys();
      assertEquals(count, 1);
      const bundle = Deno.readTextFileSync(authorizedKeysPath());
      const keyLines = bundle.split("\n").filter((l) =>
        l && !l.startsWith("#")
      );
      assertEquals(keyLines.length, 2);
      assertEquals(keyLines[0], ED25519_A); // 自動鍵が先頭
      assertStringIncludes(keyLines[1], "github:foo");

      // 一時ファイルの残骸なし
      for (const entry of Deno.readDirSync(dir)) {
        assertEquals(entry.name.endsWith(".tmp~"), false, entry.name);
      }
    });
  },
});

Deno.test({
  name: "rebuildAuthorizedKeys: 自動鍵がなければエラー（空の束を書かない）",
  ignore: isWindows,
  fn() {
    withTempHome(() => {
      assertThrows(() => rebuildAuthorizedKeys(), Error, "setup");
      // 束ファイルは生成されていない
      assertThrows(() => Deno.statSync(authorizedKeysPath()));
    });
  },
});
