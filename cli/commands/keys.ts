import { bold, cyan, dim, green, red, yellow } from "@std/fmt/colors";
import { resolve } from "@std/path";
import { Confirm, Input, Select } from "../lib/prompt.ts";
import {
  fetchGithubKeys,
  fingerprintSha256,
  isSameKey,
  type KeyStore,
  loadKeyStore,
  type ParsedKey,
  parseKeysText,
  parsePublicKey,
  rebuildAuthorizedKeys,
  RSA_MIN_BITS,
  saveKeyStore,
  validateGithubUsername,
  validatePublicKeyInput,
} from "../lib/keys.ts";
import { pubKeyPath } from "../lib/ssh.ts";

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

async function describeKey(
  k: { type: string; base64: string; comment?: string; label?: string },
): Promise<string> {
  const fp = await fingerprintSha256(k.base64);
  const name = k.label || k.comment || "";
  return `${k.type} ${fp}${name ? ` ${dim(name)}` : ""}`;
}

/**
 * Deduplicate, show fingerprints, confirm, then append to the store and
 * regenerate the bundle. Returns the number of keys actually added.
 */
async function confirmAndAdd(
  store: KeyStore,
  autoKey: ParsedKey,
  keys: ParsedKey[],
  label: string,
): Promise<number> {
  const fresh: ParsedKey[] = [];
  for (const k of keys) {
    if (isSameKey(k, autoKey) || store.keys.some((s) => isSameKey(s, k))) {
      console.log(
        yellow(
          `  登録済みのためスキップ: ${await fingerprintSha256(k.base64)}`,
        ),
      );
      continue;
    }
    if (fresh.some((f) => isSameKey(f, k))) continue;
    fresh.push(k);
  }
  if (fresh.length === 0) {
    console.log(dim("  追加する鍵はありません"));
    return 0;
  }

  console.log("");
  console.log(bold("  追加する鍵:"));
  for (const k of fresh) {
    console.log(`    ${await describeKey({ ...k, label })}`);
    if (k.rsaBits !== undefined && k.rsaBits < RSA_MIN_BITS) {
      console.log(
        yellow(
          `      警告: RSA ${k.rsaBits} bit は弱い鍵です (推奨 ${RSA_MIN_BITS} bit 以上)`,
        ),
      );
    }
  }
  console.log("");
  const sure = await Confirm.prompt({
    message: `${fresh.length} 件の鍵を追加しますか？`,
    default: true,
  });
  if (!sure) return 0;

  const addedAt = new Date().toISOString();
  for (const k of fresh) {
    store.keys.push({
      type: k.type,
      base64: k.base64,
      comment: k.comment,
      label,
      addedAt,
    });
  }
  saveKeyStore(store);
  rebuildAuthorizedKeys(store.keys);
  console.log(green(`[cloopy] ${fresh.length} 件の鍵を追加しました`));
  return fresh.length;
}

/**
 * Interactive SSH key management. The auto-generated key is cloopy's own
 * connectivity guarantee — it is always listed, always first in the bundle,
 * and can never be deleted here.
 * @returns true if the key set changed (caller should offer to apply it)
 */
export async function manageKeys(): Promise<boolean> {
  let autoKeyLine: string;
  try {
    autoKeyLine = Deno.readTextFileSync(pubKeyPath()).trim();
  } catch {
    console.error(
      red(
        "[cloopy] 自動生成鍵が見つかりません。先にセットアップを実行してください",
      ),
    );
    return false;
  }
  const autoParsed = parsePublicKey(autoKeyLine);
  if (!autoParsed.ok) {
    console.error(
      red(
        `[cloopy] 自動生成鍵 (${pubKeyPath()}) が壊れています: ${autoParsed.error}`,
      ),
    );
    return false;
  }
  const autoKey = autoParsed.key;

  let store: KeyStore;
  try {
    store = loadKeyStore();
  } catch (e) {
    console.error(red(`[cloopy] ${errMsg(e)}`));
    return false;
  }

  let changed = false;

  while (true) {
    console.log("");
    console.log(bold(cyan("  SSH 鍵管理")));
    console.log(
      dim(
        `  自動生成鍵 + 追加鍵 ${store.keys.length} 件 (反映はコンテナ再作成時)`,
      ),
    );
    console.log("");

    const choice = await Select.prompt({
      message: "操作を選択",
      options: [
        { name: "鍵の一覧", value: "list" },
        { name: "鍵を追加 (貼り付け)", value: "paste" },
        { name: "鍵を追加 (ファイルから)", value: "file" },
        { name: "鍵を追加 (GitHub から取得)", value: "github" },
        { name: "鍵を削除", value: "remove" },
        SEPARATOR,
        { name: "戻る", value: "back" },
      ],
    });

    if (choice === "back") break;
    console.log("");

    try {
      switch (choice) {
        case "list": {
          console.log(bold("  登録されている鍵:"));
          console.log(
            `    ${await describeKey(autoKey)} ${
              yellow("[自動生成・削除不可]")
            }`,
          );
          for (const k of store.keys) {
            const date = k.addedAt ? ` (${k.addedAt.slice(0, 10)})` : "";
            console.log(`    ${await describeKey(k)}${dim(date)}`);
          }
          break;
        }

        case "paste": {
          const input = await Input.prompt({
            message: "公開鍵を貼り付け (1行)",
            validate: validatePublicKeyInput,
          });
          const r = parsePublicKey(input);
          if (!r.ok) break; // validate 済みのため通常到達しない
          let label = "";
          if (!r.key.comment) {
            label = (await Input.prompt({
              message: "ラベル (一覧表示用、空でも可)",
              default: "",
            })).trim();
          }
          if (await confirmAndAdd(store, autoKey, [r.key], label) > 0) {
            changed = true;
          }
          break;
        }

        case "file": {
          const pathInput = (await Input.prompt({
            message: "公開鍵ファイルのパス (.pub / authorized_keys 形式)",
          })).trim();
          if (!pathInput) break;
          let text: string;
          try {
            text = Deno.readTextFileSync(expandHome(pathInput));
          } catch (e) {
            console.error(red(`[cloopy] ファイルを読めません: ${errMsg(e)}`));
            break;
          }
          const { keys, invalid } = parseKeysText(text);
          for (const line of invalid) {
            const r = parsePublicKey(line);
            console.log(
              yellow(
                `  スキップ (${r.ok ? "?" : r.error}): ${line.slice(0, 60)}`,
              ),
            );
          }
          if (keys.length === 0) {
            console.error(red("[cloopy] 有効な公開鍵が見つかりませんでした"));
            break;
          }
          if (await confirmAndAdd(store, autoKey, keys, "") > 0) {
            changed = true;
          }
          break;
        }

        case "github": {
          const username = (await Input.prompt({
            message: "GitHub ユーザー名",
            validate: (v: string) =>
              validateGithubUsername(v.trim())
                ? true
                : "GitHub ユーザー名の形式が不正です",
          })).trim();
          console.log(dim(`  https://github.com/${username}.keys を取得中...`));
          const result = await fetchGithubKeys(username);
          if (result.status === "not_found") {
            console.error(
              red(`[cloopy] GitHub ユーザー ${username} は存在しません`),
            );
            break;
          }
          if (result.status === "empty") {
            console.log(
              yellow(`[cloopy] ${username} には公開鍵が登録されていません`),
            );
            break;
          }
          if (result.status === "error") {
            console.error(red(`[cloopy] ${result.message}`));
            break;
          }
          for (const line of result.invalid) {
            console.log(
              yellow(`  スキップ (未対応の鍵): ${line.slice(0, 60)}`),
            );
          }
          if (
            await confirmAndAdd(
              store,
              autoKey,
              result.keys,
              `github:${username}`,
            ) > 0
          ) {
            changed = true;
          }
          break;
        }

        case "remove": {
          if (store.keys.length === 0) {
            console.log(
              dim("  削除できる追加鍵はありません (自動生成鍵は削除不可)"),
            );
            break;
          }
          const options = [];
          for (let i = 0; i < store.keys.length; i++) {
            options.push({
              name: await describeKey(store.keys[i]),
              value: String(i),
            });
          }
          const sel = await Select.prompt({
            message: "削除する鍵を選択",
            options: [...options, SEPARATOR, {
              name: "キャンセル",
              value: "cancel",
            }],
          });
          if (sel === "cancel") break;
          const idx = Number(sel);
          const target = store.keys[idx];
          const sure = await Confirm.prompt({
            message: `削除しますか？ ${await fingerprintSha256(target.base64)}`,
            default: false,
          });
          if (!sure) break;
          store.keys.splice(idx, 1);
          saveKeyStore(store);
          rebuildAuthorizedKeys(store.keys);
          changed = true;
          console.log(green("[cloopy] 鍵を削除しました"));
          break;
        }
      }
    } catch (e) {
      console.error(red(`[cloopy] 鍵の更新に失敗しました: ${errMsg(e)}`));
      // store はメモリ上で変わっている可能性があるため読み直す
      try {
        store = loadKeyStore();
      } catch {
        return changed;
      }
    }
  }

  return changed;
}
