---
group: B
topic: CLI ライブラリ層
files_reviewed: 7
date: 2026-06-10
model: sonnet
---

# Group B: CLI ライブラリ層

## サマリ

全体として品質は高く、意図的なセキュリティ対策（`$`-sequences を function replacer で無力化、
`blockRe` の文字クラス外で `-` は無害）も正しく実装されている。
ただし ssh.ts の **`injectSshConfig` が書き込み失敗時に巻き戻しなし**、
env.ts の **CRLF ファイルを更新すると該当行が LF 単独に劣化**、
workspace.ts の **シンボリックリンクによる `$HOME` チェック迂回**（SELinux ホストでロックアウトリスク）、
の 3 点が Warning 以上として目立つ。
compose.ts の `getComposeFiles(quiet=false)` が `compose()` / `composeSpawn()` 経由で
毎回ログを吐く UX 劣化（Low）も運用時に煩わしい。

- 重大度件数: 🟢 1 / 🔵 3 / 🟡 4 / 🔴 0 / 💣 0
- ドキュメント軸: 🟣 2
- タグ別: 🤖 5 / 🙋 4

## ファイル別分類

| 分類 | ファイル | 一言コメント |
|---|---|---|
| 🟢 Safe | `cli/lib/constants.ts` | 定数のみ、変更なし |
| 🟢 Safe | `cli/lib/prompt.ts` | 純粋 re-export、レビュー対象なし |
| 🔵 Low | `cli/lib/spinner.ts` | タイマーリークリスクが微小（try/finally 欠如） |
| 🔵 Low + 🟣 | `cli/lib/compose.ts` | `compose()` が quiet=false のまま呼び出しで毎回ログ出力 |
| 🟡 Warning + 🟣 | `cli/lib/env.ts` | CRLF ファイル更新で行末 `\r` が消える; 空ファイルへの先頭改行 |
| 🟡 Warning | `cli/lib/ssh.ts:81` | `injectSshConfig` がファイル書き込み失敗時に巻き戻しなし |
| 🟡 Warning | `cli/lib/workspace.ts:37` | シンボリックリンクで `$HOME` チェックを迂回できる |

> Doc は重大度と独立軸。compose.ts は「🔵 Low かつ 🟣 D-B-1」, env.ts は「🟡 Warning かつ 🟣 D-B-2」。

---

## 詳細指摘

### 🟡 W-B-1 🙋: `injectSshConfig` の無防備な書き込み失敗（巻き戻しなし）

- **対象**: `cli/lib/ssh.ts:81-151`
- **症状**: `Deno.writeTextFileSync(configPath, ...)` (行 116, 126) および
  `Deno.writeTextFileSync(mainConfig, ...)` (行 149) は try/catch ゼロ。
  ディスクフル・権限エラー等で失敗した場合、呼び出し元 (`setup.ts:205`) に
  例外が伝播して `setup()` が中断する。
  特に「cloopy config に書いた後、main config 書き込みで失敗」すると
  cloopy config だけが更新された半端な状態になる。
  **SSH 接続性への影響**: main config の Include が追加されなかった場合、
  `ssh cloopy` が通らなくなる。
- **根本原因**: `void` 戻り値の関数でエラーハンドリングを呼び出し元に丸投げしているが、
  呼び出し元も try/catch していない（`setup.ts:205` は素の呼び出し）。
- **修正案**:
  - 候補 A（推奨）: `injectSshConfig` を `throws` ドキュメント付きの明示的な例外伝播に統一し、
    `setup.ts` で try/catch して「SSH 設定の書き込みに失敗しました: ${e}」と表示してから
    `Deno.exit(1)` する。
  - 候補 B: main config への書き込みを atomic にする（tmpfile → rename）が、
    sshConfigPath の書き込みは idempotent（再実行で正しくなる）なので A で十分。
- **テスト**: `Deno.writeTextFileSync` を stub して例外を投げた場合に setup が Deno.exit(1) することを確認。

---

### 🟡 W-B-2 🙋: シンボリックリンクで `$HOME` チェックを迂回できる

- **対象**: `cli/lib/workspace.ts:37-65`
- **症状**: `validateWorkspacePath` は `resolve(expanded)` でパスを正規化するが、
  `resolve()` はシンボリックリンクを追わない（`Deno.realPathSync` 相当ではない）。
  したがって `/tmp/mylink`（実体が `$HOME` を指すシンボリック）を入力すると
  FORBIDDEN_PATHS にも home チェックにも引っかからず `true` を返す。
  SELinux ホストでは bind mount が `$HOME` ツリー全体を `container_file_t` に
  リラベルし、`~/.ssh` が `ssh_home_t` を失ってホストへの SSH ログインが失われる。
  **SSH 接続性への影響**: SELinux enforcing のホストでロックアウトリスクあり。
- **根本原因**: `resolve()` は構文的正規化のみ。SELinux リラベルはカーネルが
  bind mount のターゲット実体を解決して行う。
- **修正案**:
  - 候補 A（推奨）: 入力パスに対して `Deno.realPathSync()` を試みて実体パスを取得し、
    それを `resolve()` の代わりに検証する。存在しないパスは `try/catch` で
    `realPathSync` 失敗 → `resolve()` フォールバック（新規作成パスは許容）。
  - 候補 B: シンボリックリンクを含む入力を検出したら警告を表示して続行させる
    （完全な防御はできないが認知コスト低下）。
  - いずれも Windows では skip 済み（行 41）なので変更不要。
- **テスト**: `/tmp/cloopy-test-link` → `$HOME` のシンボリックを作成し
  `validateWorkspacePath` が文字列（エラー）を返すことを確認。

---

### 🟡 W-B-3 🤖: `setEnvVar` が CRLF ファイルを更新すると行末 `\r` が消える

- **対象**: `cli/lib/env.ts:28-35`
- **症状**: `.env` が CRLF で終端されている場合（Windows で git clone した等）、
  正規表現 `^${key}=.*$` ("m" フラグ) のドット `.` は `\n` にはマッチしないが
  `\r` にはマッチする。
  つまり `FOO=bar\r\n` に対して `FOO=bar\r` がマッチし、
  `replace` 後は `FOO=newval\n` になる（`\r` が消えて以降の行は CRLF→LF 混在）。
  結果として書き戻したファイルは混在改行になる。Windows 上で別ツールが
  `.env` を読む場合に混乱する可能性。
- **根本原因**: 正規表現を CRLF 対応に設計していない。
- **修正案** (🤖):
  ```typescript
  const regex = new RegExp(`^${key}=.*\r?$`, "m");
  ```
  `\r?` を追加するだけで `\r` も含めてマッチし、replacement で LF 統一になる。
  あるいは content 全体を read 後 `content.replaceAll("\r\n", "\n")` で正規化してから
  処理する方法も選択肢。
- **テスト**: `env_test.ts` の CRLF テスト（行 70-80）が `readEnvFile` のみ対象で
  `setEnvVar` の CRLF 更新をカバーしていない。`setEnvVar` 後に CRLF が混在しないことを確認するテストを追加する（🤖）。

---

### 🟡 W-B-4 🤖: `setEnvVar` が空コンテンツに書き込むと先頭に余分な改行

- **対象**: `cli/lib/env.ts:39-41`
- **症状**: `.env` が存在しない（`readTextFileSync` が例外 → `content = ""`）かつ
  新規キーを append するとき、`content.trimEnd()` が `""` を返すため
  書き込み内容が `"\n" + line + "\n"` になる（先頭に空行）。
- **根本原因**: `trimEnd()` が空文字に対して `""` を返し、続く `"\n"` が先頭に残る。
- **修正案** (🤖):
  ```typescript
  content = (content.trimEnd() ? content.trimEnd() + "\n" : "") + line + "\n";
  ```
  または
  ```typescript
  const base = content.trimEnd();
  content = base ? base + "\n" + line + "\n" : line + "\n";
  ```
- **備考**: 実運用では `ensureEnvFile()` が必ず先に呼ばれ `.env.example` からコピーするため
  `content=""` のケースは稀。ただしテスト（`env_test.ts:130`）で直接 `setEnvVar` を
  使う場合にも再現する。テスト自体は `includes("FRESH=value")` で検査するため
  先頭の `\n` を見逃している。
- **テスト**: `setEnvVar` でファイル非存在時に生成されたファイルが `\nFRESH=...` で
  始まっていないことを確認するアサーションを追加（🤖）。

---

### 🔵 L-B-1 🤖: `compose()` / `composeSpawn()` が quiet=false で毎回「Found local yml」を出力

- **対象**: `cli/lib/compose.ts:52,74`
- **症状**: `compose(projectRoot, ...)` および `composeSpawn(projectRoot, ...)` は
  `getComposeFiles(projectRoot)` を `quiet=false` で呼ぶ。
  `docker-compose.local.yml` が存在する環境では操作のたびに
  `"[cloopy] Found docker-compose.local.yml, including in config"` が表示され、
  一度の `manage.ts` セッションでも 5〜10 回繰り返す。
- **修正案** (🤖): `compose()` と `composeSpawn()` の `getComposeFiles` 呼び出しに
  `true` を渡す（`quiet=true`）。または `options` に `quiet` フィールドを追加して
  外部から制御可能にする。
- **テスト**: 不要（動作は変わらない）。

---

### 🔵 L-B-2 🙋: `checkBootstrapStatus` が `docker compose logs` の非ゼロ終了を無視

- **対象**: `cli/lib/compose.ts:110-138`
- **症状**: 行 120 で `{ stdout }` のみ分解代入し `code` を破棄している。
  `docker compose logs` が失敗した場合（コンテナが既に停止済み、docker デーモン停止等）
  `logs` は空文字になり、すべての条件分岐を素通りして**何も表示されず**に戻る。
  ユーザーに状況が伝わらない（サイレント無視）。
- **修正案**:
  ```typescript
  const { code, stdout } = await cmd.output();
  if (code !== 0) return; // logs unavailable, already handled by up failure check
  ```
  あるいは `code !== 0` 時に短い警告を出す。
- **テスト**: 軽微のため任意。

---

### 🔵 L-B-3 🙋: `refreshKnownHosts` 失敗後に古い known_hosts が残り次回 SSH で鍵不一致

- **対象**: `cli/lib/ssh.ts:160-207`
- **症状**: 全 3 回リトライが失敗して `return` した場合、`known_hosts` ファイルは
  前のコンテナ起動時のまま更新されない。
  `ssh-config` ボリュームが削除・再作成されてホスト鍵が変わった後に
  keyscan が失敗すると、次の `ssh cloopy` が
  `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!` で接続不能になる。
  通常は `ssh-config` ボリューム永続で鍵は変わらないが、reset 後のリストアや
  compose ネットワーク障害時に発生しうる。
  **SSH 接続性への影響**: 軽微〜中程度（ユーザーが `ssh-keygen -R [localhost]:PORT` で回復可能）。
- **修正案**: 失敗メッセージに回復コマンドを添える:
  ```
  console.error(`[cloopy] 手動で解消するには: ssh-keygen -R [localhost]:${port}`);
  ```
- **テスト**: 任意。

---

### 🟣 D-B-1 🤖: `compose()` / `composeSpawn()` の JSDoc が quiet 引数の挙動に言及しない

- **対象**: `cli/lib/compose.ts:44-46,65-67`
- **症状**: `compose()` と `composeSpawn()` のドキュメントに quiet 引数が存在しないことへの
  言及がなく、呼び出すと常にローカルオーバーライドのログが出る旨が書かれていない。
  → 🤖: JSDoc に `// Note: logs local override discovery` の一行コメントを追加すれば足りる。

---

### 🟣 D-B-2 🤖: `env.ts` の `setEnvVar` JSDoc が CRLF の挙動に言及していない

- **対象**: `cli/lib/env.ts:15`
- **症状**: JSDoc に `@param value` の説明はあるが、CRLF ファイルで動作が変わる点
  および空ファイル時に先頭改行が生じる点の言及がない。W-B-3 / W-B-4 を修正しない場合は
  少なくとも Known Limitation として記録すべき。

---

## 重要な設計の可視化

### `.env` 書き込みのライフサイクル

```
ensureEnvFile(projectRoot)           env.ts:52-72
  │ .env 存在?
  ├─Yes→ return envPath
  └─No → copyFileSync(.env.example → .env)
         └─ .env.example には BEGIN/END マーカーが既にある

setEnvVar(envPath, key, value, auto?)   env.ts:15-45
  │
  ├─(1) readTextFileSync(envPath) → content (or "" on NotFound)
  │
  ├─(2) regex = /^KEY=.*$/m
  │       regex.test(content)?
  │         Yes → content.replace(regex, () => "KEY=val")  ← function replacer で $ を保護
  │
  ├─(3) !test && auto && content.includes(END_MARKER)?
  │         Yes → content.replace(END_MARKER, () => "KEY=val\n# END...")
  │
  └─(4) else → content.trimEnd() + "\n" + "KEY=val" + "\n"
                  ↑ content="" のとき "\nKEY=val\n" になる [W-B-4]
                  ↑ CRLF ファイルのとき regex が \r を取り込んで LF 化 [W-B-3]
  │
  └─ writeTextFileSync(envPath, content)  ← no try/catch, no atomic write
     console.log(dim(`  [env] KEY=val`))
```

### SSH config 注入のマーカー処理

```
injectSshConfig(port, instanceName)   ssh.ts:81-152
  │
  ├─[A] sshConfigPath (~/.ssh/cloopy/config) を読む (なければ "")
  │
  ├─[B] blockRe を動的構築:                                ssh.ts:110-111
  │       /# --- <name> ---\nHost <name>\n[\s\S]*?(?=\n# ---|$)/
  │       ※ instanceName は ^[a-zA-Z][a-zA-Z0-9_-]*$ で検証済みで
  │         regex-safe (validate は setup.ts:134 で担保)
  │
  ├─[C] blockRe がマッチ?
  │       Yes → existing.replace(blockRe, hostBlock)  → writeTextFileSync  [no rollback: W-B-1]
  │       No  → existing + separator + header + hostBlock + "\n" → writeTextFileSync
  │             ↑ separator/header はファイル末尾の "\n" 有無で分岐 (ssh.ts:119-124)
  │
  └─[D] mainSshConfigPath (~/.ssh/config) を読む
          includeLine = "Include /abs/path/cloopy/config"  ssh.ts:143
          mainContent.includes(includeLine)?
            No  → "# --- cloopy ---\n" + includeLine + "\n\n" + mainContent
                  → writeTextFileSync  [no try/catch: W-B-1]
                  ↑ チルダ形式で手動追記済みの場合は重複 Include になる (Low)
            Yes → skip

CRLF ssh config では blockRe の \n がマッチしない [W-B-1 の関連注意]
```

---

## 横断観点での所見

### 設計境界

`injectSshConfig` は「cloopy 専用 config への書き込み」と「main ~/.ssh/config への Include 注入」
という 2 つの独立した副作用を 1 関数に持ち、かつエラーハンドリングが呼び出し元任せになっている。
これは今後 multi-instance 対応等で拡張する際に巻き戻し処理が複雑化するリスクを持つ。

### リソース所有権

`spinner.ts` の `startTimer` が返す `{ stop }` オブジェクトは
`setInterval` の所有権をコール側に渡す設計。
`manage.ts` の backup/restore ループでは try/finally なしで `stop()` を呼んでおり、
`cmd.output()` が例外投入した場合にタイマーがリークする（L-B-x に昇格せず 🔵 Low）。

### テスト網羅

- `env_test.ts`: CRLF + `setEnvVar` の組み合わせがカバーされていない（W-B-3）。
  空ファイルへの `setEnvVar` テストも先頭改行を見逃している（W-B-4）。
- `workspace_test.ts`: シンボリックリンク経由の $HOME 迂回テストがない（W-B-2）。
  ただし CI でシンボリックが作れない環境を考慮した `ignore` 設定が必要。
- `compose_test.ts`: `compose()` / `composeSpawn()` は docker 呼び出しを伴うため
  実質ユニットテスト不可（`getComposeFiles` のみテスト済み）。これは現状の設計制約として許容。

### ドキュメント整合（🟣 Doc の所見）

- D-B-1: `compose()` の quiet デフォルトが `false` であることが JSDoc に明示されていないため、
  呼び出し側が quiet の意味に気づかず quiet=false のまま量産しやすい。
- D-B-2: `setEnvVar` の CRLF Known Limitation は修正するか明記するかどちらかが必要。
