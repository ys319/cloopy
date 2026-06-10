import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  loadRemoteStore,
  parseKeyscanOutput,
  remoteKnownHostsPath,
  type RemoteProfile,
  remoteStorePath,
  removeRemoteKnownHosts,
  saveRemoteStore,
  validateRemoteHost,
  validateRemoteName,
  validateRemotePort,
  writeRemoteKnownHosts,
} from "./remote.ts";

const isWindows = Deno.build.os === "windows";

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

function profile(name: string): RemoteProfile {
  return {
    name,
    hostName: "192.168.1.50",
    port: "10022",
    identityFile: "",
    addedAt: "2026-06-11T00:00:00.000Z",
  };
}

// --------------------------------------------------------------------------
// store
// --------------------------------------------------------------------------

Deno.test({
  name: "remoteStore: 往復保存・未作成は空 store",
  ignore: isWindows,
  fn() {
    withTempHome(() => {
      assertEquals(loadRemoteStore().remotes.length, 0);
      saveRemoteStore({ version: 1, remotes: [profile("ucore")] });
      const loaded = loadRemoteStore();
      assertEquals(loaded.remotes.length, 1);
      assertEquals(loaded.remotes[0].name, "ucore");
      assertEquals(loaded.remotes[0].hostName, "192.168.1.50");
    });
  },
});

Deno.test({
  name: "remoteStore: 壊れた JSON はエラー（空扱いにしない）",
  ignore: isWindows,
  fn() {
    withTempHome(() => {
      Deno.mkdirSync(remoteStorePath().replace(/\/remotes\.json$/, ""), {
        recursive: true,
      });
      Deno.writeTextFileSync(remoteStorePath(), "{ broken");
      assertThrows(() => loadRemoteStore(), Error, "JSON として読めません");
    });
  },
});

Deno.test({
  name: "remoteStore: 形式不正はエラー・欠損フィールドは正規化",
  ignore: isWindows,
  fn() {
    withTempHome(() => {
      Deno.mkdirSync(remoteStorePath().replace(/\/remotes\.json$/, ""), {
        recursive: true,
      });
      // hostName 欠落 → 形式不正
      Deno.writeTextFileSync(
        remoteStorePath(),
        JSON.stringify({ version: 1, remotes: [{ name: "x", port: "22" }] }),
      );
      assertThrows(() => loadRemoteStore(), Error, "形式が不正");

      // 任意フィールド (identityFile / addedAt) 欠落 → 空文字に正規化
      Deno.writeTextFileSync(
        remoteStorePath(),
        JSON.stringify({
          version: 1,
          remotes: [{ name: "x", hostName: "h", port: "22" }],
        }),
      );
      const loaded = loadRemoteStore();
      assertEquals(loaded.remotes[0].identityFile, "");
      assertEquals(loaded.remotes[0].addedAt, "");
    });
  },
});

Deno.test({
  name: "remoteStore: 手編集で不正化した name/hostName/port を load 時に拒否",
  ignore: isWindows,
  fn() {
    withTempHome(() => {
      const write = (remotes: unknown[]) => {
        Deno.mkdirSync(remoteStorePath().replace(/\/remotes\.json$/, ""), {
          recursive: true,
        });
        Deno.writeTextFileSync(
          remoteStorePath(),
          JSON.stringify({ version: 1, remotes }),
        );
      };
      // name のパストラバーサル (known_hosts.d 外への書き込み経路)
      write([{ name: "../../evil", hostName: "h", port: "22" }]);
      assertThrows(() => loadRemoteStore(), Error, "形式が不正");
      // name のオプション注入 (ssh 第一引数経路)
      write([{ name: "-oProxyCommand=x", hostName: "h", port: "22" }]);
      assertThrows(() => loadRemoteStore(), Error, "形式が不正");
      // 前後空白 (config 行へ raw が流れる経路)
      write([{ name: " ok ", hostName: "h", port: "22" }]);
      assertThrows(() => loadRemoteStore(), Error, "形式が不正");
      // hostName の空白 / port の範囲外
      write([{ name: "ok", hostName: "h h", port: "22" }]);
      assertThrows(() => loadRemoteStore(), Error, "形式が不正");
      write([{ name: "ok", hostName: "h", port: "99999" }]);
      assertThrows(() => loadRemoteStore(), Error, "形式が不正");
      // 正常値は通る
      write([{ name: "ok", hostName: "fd00::1", port: "10022" }]);
      assertEquals(loadRemoteStore().remotes[0].hostName, "fd00::1");
    });
  },
});

// --------------------------------------------------------------------------
// validators
// --------------------------------------------------------------------------

Deno.test("validateRemoteName: 妥当な名前を受理", () => {
  assertEquals(validateRemoteName("cloopy-remote"), true);
  assertEquals(validateRemoteName("ucore_2"), true);
});

Deno.test("validateRemoteName: 不正な名前を拒否", () => {
  assertEquals(typeof validateRemoteName(""), "string");
  assertEquals(typeof validateRemoteName("1abc"), "string"); // 数字始まり
  assertEquals(typeof validateRemoteName("a/b"), "string"); // パス区切り
  assertEquals(typeof validateRemoteName("a b"), "string"); // 空白
  assertEquals(typeof validateRemoteName("a".repeat(65)), "string");
});

Deno.test("validateRemoteHost: IP・ホスト名・IPv6 を受理", () => {
  assertEquals(validateRemoteHost("192.168.1.50"), true);
  assertEquals(validateRemoteHost("ucore.local"), true);
  assertEquals(validateRemoteHost("fd00::1"), true);
});

Deno.test("validateRemoteHost: config を壊す入力を拒否", () => {
  assertEquals(typeof validateRemoteHost(""), "string");
  assertEquals(typeof validateRemoteHost("host name"), "string");
  assertEquals(typeof validateRemoteHost("host#x"), "string");
  assertEquals(typeof validateRemoteHost("a\nb"), "string");
});

Deno.test("validateRemotePort: 範囲チェック", () => {
  assertEquals(validateRemotePort("10022"), true);
  assertEquals(typeof validateRemotePort("0"), "string");
  assertEquals(typeof validateRemotePort("65536"), "string");
  assertEquals(typeof validateRemotePort("abc"), "string");
});

// --------------------------------------------------------------------------
// parseKeyscanOutput
// --------------------------------------------------------------------------

Deno.test("parseKeyscanOutput: ハッシュ化ホストの鍵行をパース", () => {
  const text = [
    "# 192.168.1.50:10022 SSH-2.0-OpenSSH_9.6", // コメントはスキップ
    "|1|abcSALT=|defHASH= ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEx",
    "|1|abcSALT=|defHASH= ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB",
    "",
    "garbage-line", // フィールド不足はスキップ
  ].join("\n");
  const { lines, keys } = parseKeyscanOutput(text);
  assertEquals(lines.length, 2);
  assertEquals(keys.length, 2);
  assertEquals(keys[0].type, "ssh-ed25519");
  assertEquals(keys[1].type, "ssh-rsa");
  assertStringIncludes(lines[0], "|1|abcSALT=|defHASH= ssh-ed25519");
});

Deno.test("parseKeyscanOutput: 空入力は空結果", () => {
  const { lines, keys } = parseKeyscanOutput("");
  assertEquals(lines.length, 0);
  assertEquals(keys.length, 0);
});

// --------------------------------------------------------------------------
// known_hosts.d
// --------------------------------------------------------------------------

Deno.test({
  name: "knownHosts.d: 書き込み・削除・二重削除は無害・tmp 残骸なし",
  ignore: isWindows,
  fn() {
    withTempHome(() => {
      const lines = ["|1|a|b ssh-ed25519 AAAA", "|1|c|d ssh-rsa BBBB"];
      writeRemoteKnownHosts("ucore", lines);
      const written = Deno.readTextFileSync(remoteKnownHostsPath("ucore"));
      assertEquals(written, lines.join("\n") + "\n");

      const dir = remoteKnownHostsPath("ucore").replace(/\/ucore$/, "");
      for (const entry of Deno.readDirSync(dir)) {
        assertEquals(entry.name.endsWith(".tmp~"), false);
      }

      removeRemoteKnownHosts("ucore");
      assertThrows(() => Deno.statSync(remoteKnownHostsPath("ucore")));
      removeRemoteKnownHosts("ucore"); // 既に無い → no-op
    });
  },
});
