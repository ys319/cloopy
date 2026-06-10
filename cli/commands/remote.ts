import { bold, cyan, dim, green, red, yellow } from "@std/fmt/colors";
import { resolve } from "@std/path";
import { DEFAULT_SSH_PORT } from "../lib/constants.ts";
import { fingerprintSha256 } from "../lib/keys.ts";
import { Confirm, Input, Select } from "../lib/prompt.ts";
import {
  loadRemoteStore,
  remoteKnownHostsPath,
  type RemoteProfile,
  type RemoteStore,
  removeRemoteKnownHosts,
  saveRemoteStore,
  scanRemoteHostKeys,
  validateRemoteHost,
  validateRemoteName,
  validateRemotePort,
  writeRemoteKnownHosts,
} from "../lib/remote.ts";
import {
  hasHostBlock,
  injectSshConfig,
  keyPath,
  readCloopyConfig,
  removeSshConfigEntry,
} from "../lib/ssh.ts";

const SEPARATOR = Select.separator("────────────────────────────");

function expandHome(p: string): string {
  const home = Deno.build.os === "windows"
    ? Deno.env.get("USERPROFILE") ?? ""
    : Deno.env.get("HOME") ?? "";
  if (p === "~") return home;
  if (p.startsWith("~/")) return resolve(home, p.slice(2));
  return p;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** BatchMode ssh で疎通確認する (doctor の SSH Connect と同じ要領)。 */
async function testConnection(name: string): Promise<void> {
  console.log(`[cloopy] ssh ${name} で接続テスト中...`);
  try {
    // "--" で以降をオプションとして解釈させない (name は load 時に検証済み
    // だが、ssh をユーザー由来文字列で呼ぶ箇所の深層防御として)
    const cmd = new Deno.Command("ssh", {
      args: [
        "-o",
        "ConnectTimeout=5",
        "-o",
        "BatchMode=yes",
        "--",
        name,
        "exit",
      ],
      stdout: "null",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    if (code === 0) {
      console.log(green("[cloopy] 接続 OK"));
      return;
    }
    const lines = new TextDecoder().decode(stderr).trim().split("\n");
    const last = lines[lines.length - 1] ?? "";
    console.error(
      red(`[cloopy] 接続できませんでした${last ? `: ${last}` : ""}`),
    );
    console.error(
      dim(
        "  リモート側でこのマシンの公開鍵が「SSH 鍵管理」に登録済みか、\n" +
          "  「SSH 公開範囲」が LAN 公開になっているかを確認してください",
      ),
    );
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      console.error(red("[cloopy] ssh コマンドが見つかりません"));
    } else {
      console.error(red(`[cloopy] 接続テストに失敗しました: ${errMsg(e)}`));
    }
  }
}

/**
 * エントリの追加・更新。ホスト鍵は登録前に ssh-keyscan で取得し、指紋を
 * 確認してから known_hosts.d/<名前> に固定する（リモートは MITM があり得る
 * ため）。取得できない場合は TOFU (accept-new) での登録も選べる。
 */
async function addOrUpdate(store: RemoteStore): Promise<void> {
  console.log(
    dim(
      "  リモートマシンで動いている cloopy への接続エントリを作成します。\n" +
        "  あらかじめリモート側で「SSH 鍵管理」にこのマシンの公開鍵を追加し、\n" +
        "  「SSH 公開範囲」を LAN 公開にしておいてください。",
    ),
  );
  console.log("");

  const name = (await Input.prompt({
    message: "エントリ名 (ssh <名前> で接続)",
    default: "cloopy-remote",
    validate: validateRemoteName,
  })).trim();

  const existing = store.remotes.find((r) => r.name === name);
  if (!existing && hasHostBlock(readCloopyConfig(), name)) {
    // 同名ブロックが config にあるのに store に無い = ローカルインスタンス用。
    // 上書きすると `ssh <インスタンス名>` がリモートを向いてしまう。
    console.error(
      red(
        `[cloopy] "${name}" はローカルインスタンスのエントリ名として使用中です。別の名前にしてください`,
      ),
    );
    return;
  }
  if (existing) {
    const overwrite = await Confirm.prompt({
      message:
        `"${name}" は登録済み (${existing.hostName}:${existing.port}) です。上書きしますか？`,
      default: true,
    });
    if (!overwrite) return;
  }

  const hostName = (await Input.prompt({
    message: "リモートホスト (IP または DNS 名)",
    default: existing?.hostName,
    validate: validateRemoteHost,
  })).trim();

  const port = (await Input.prompt({
    message: "SSH ポート",
    default: existing?.port ?? DEFAULT_SSH_PORT,
    validate: validateRemotePort,
  })).trim();

  // 既定は自動生成鍵（このマシンで setup 済みなら存在する）。空 = ssh の
  // 既定の鍵や agent に任せる
  let defaultIdentity = existing?.identityFile ?? "";
  if (!defaultIdentity) {
    try {
      Deno.statSync(keyPath());
      defaultIdentity = keyPath();
    } catch {
      // このマシンに自動生成鍵が無い (docker 無しのクライアント等)
    }
  }
  const identityInput = (await Input.prompt({
    message: "秘密鍵のパス (空 = ssh の既定の鍵 / agent を使用)",
    default: defaultIdentity,
    validate: (v: string) => {
      const t = v.trim();
      if (!t) return true;
      try {
        const st = Deno.statSync(expandHome(t));
        return st.isFile ? true : "ファイルではありません";
      } catch {
        return "ファイルが見つかりません";
      }
    },
  })).trim();
  const identityFile = identityInput ? expandHome(identityInput) : "";

  console.log("");
  console.log(`[cloopy] ${hostName}:${port} のホスト鍵を取得中...`);
  const scan = await scanRemoteHostKeys(hostName, port);
  let knownHostsLines: string[] | null = null;
  if (scan.ok) {
    console.log("");
    console.log(bold("  ホスト鍵の指紋:"));
    for (const k of scan.keys) {
      try {
        console.log(`    ${k.type} ${await fingerprintSha256(k.base64)}`);
      } catch {
        console.log(`    ${k.type} ${dim("(指紋を計算できませんでした)")}`);
      }
    }
    console.log("");
    console.log(
      dim(
        "  ssh-keyscan は認証なしの取得です。可能ならサーバ側で確認した指紋と\n" +
          "  照合してから信頼してください (一致しない場合は中間者攻撃の疑い)",
      ),
    );
    const trust = await Confirm.prompt({
      message: "このホスト鍵を信頼しますか？",
      default: false,
    });
    if (!trust) {
      console.log(dim("  中断しました"));
      return;
    }
    knownHostsLines = scan.lines;
  } else {
    console.error(
      yellow(`[cloopy] ホスト鍵を取得できませんでした: ${scan.error}`),
    );
    console.error(
      dim(
        "  リモートが起動していないか、LAN 公開になっていない可能性があります",
      ),
    );
    const cont = await Confirm.prompt({
      message: "ホスト鍵なしで登録しますか？ (初回接続時に自動で受け入れ)",
      default: false,
    });
    if (!cont) return;
  }

  const profile: RemoteProfile = {
    name,
    hostName,
    port,
    identityFile,
    addedAt: new Date().toISOString(),
  };
  if (existing) {
    store.remotes[store.remotes.indexOf(existing)] = profile;
  } else {
    store.remotes.push(profile);
  }
  saveRemoteStore(store);
  if (knownHostsLines) {
    writeRemoteKnownHosts(name, knownHostsLines);
  } else {
    // 接続先が変わったのに旧ホスト鍵が残ると毎回 mismatch で弾かれるため、
    // TOFU を選んだ場合は既存の固定鍵を捨てて accept-new に任せる
    removeRemoteKnownHosts(name);
  }
  injectSshConfig(port, name, {
    hostName,
    identityFile: identityFile || null,
    knownHostsFile: remoteKnownHostsPath(name),
  });
  console.log(green(`[cloopy] エントリ "${name}" を保存しました`));
  console.log(
    `  接続: ${cyan(`ssh ${name}`)} (VS Code Remote SSH からも選択できます)`,
  );
  console.log("");

  const test = await Confirm.prompt({
    message: "接続テストを実行しますか？",
    default: true,
  });
  if (test) await testConnection(name);
}

async function removeEntry(store: RemoteStore): Promise<void> {
  if (store.remotes.length === 0) {
    console.log(dim("  登録済みのエントリはありません"));
    return;
  }
  const name = await Select.prompt({
    message: "削除するエントリ",
    options: [
      ...store.remotes.map((r) => ({
        name: `${r.name} (${r.hostName}:${r.port})`,
        value: r.name,
      })),
      SEPARATOR,
      { name: "戻る", value: "" },
    ],
  });
  if (!name) return;
  const sure = await Confirm.prompt({
    message: `"${name}" を削除しますか？`,
    default: false,
  });
  if (!sure) return;
  // config ブロック → known_hosts → store の順に消す。store を先に消すと
  // 途中失敗時に「store に無いのに config にブロックが残る」状態になり、
  // addOrUpdate のローカルインスタンス誤判定で再登録も削除もできなくなる。
  // 逆順なら途中失敗してもエントリは store に残り、削除をやり直せる。
  removeSshConfigEntry(name);
  removeRemoteKnownHosts(name);
  store.remotes = store.remotes.filter((r) => r.name !== name);
  saveRemoteStore(store);
  console.log(green(`[cloopy] "${name}" を削除しました`));
}

/**
 * リモート cloopy への接続プロファイル管理。docker 非依存 — SSH config と
 * known_hosts.d を書くだけなので、docker の無いクライアントマシンでも使える。
 */
export async function manageRemotes(): Promise<void> {
  let store: RemoteStore;
  try {
    store = loadRemoteStore();
  } catch (e) {
    console.error(red(`[cloopy] ${errMsg(e)}`));
    return;
  }

  while (true) {
    console.log("");
    console.log(bold(cyan("  リモート接続 (他マシンの cloopy へ)")));
    if (store.remotes.length === 0) {
      console.log(dim("  登録済みのエントリはありません"));
    } else {
      for (const r of store.remotes) {
        const id = r.identityFile ? "" : dim(" [既定の鍵]");
        console.log(`    ${r.name}  ${dim(`→ ${r.hostName}:${r.port}`)}${id}`);
      }
    }
    console.log("");

    const choice = await Select.prompt({
      message: "操作を選択",
      options: [
        { name: "エントリを追加・更新", value: "add" },
        { name: "接続テスト", value: "test" },
        { name: "エントリを削除", value: "remove" },
        SEPARATOR,
        { name: "戻る", value: "back" },
      ],
    });
    if (choice === "back") return;
    console.log("");

    try {
      switch (choice) {
        case "add":
          await addOrUpdate(store);
          break;
        case "test": {
          if (store.remotes.length === 0) {
            console.log(dim("  登録済みのエントリはありません"));
            break;
          }
          const name = await Select.prompt({
            message: "テストするエントリ",
            options: store.remotes.map((r) => ({
              name: `${r.name} (${r.hostName}:${r.port})`,
              value: r.name,
            })),
          });
          await testConnection(name);
          break;
        }
        case "remove":
          await removeEntry(store);
          break;
      }
    } catch (e) {
      console.error(red(`[cloopy] エラー: ${errMsg(e)}`));
      // 途中失敗で in-memory とディスクがずれた可能性 → store を読み直す
      try {
        store = loadRemoteStore();
      } catch {
        // 読み直せない場合は手元の状態のまま続行
      }
    }
  }
}
