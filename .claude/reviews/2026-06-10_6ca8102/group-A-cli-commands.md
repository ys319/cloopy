---
group: A
topic: CLI コマンド層 + エントリポイント
files_reviewed: 7
date: 2026-06-10
model: sonnet
---

# Group A: CLI コマンド層 + エントリポイント

## サマリ

CLI 全体の構造は明快で、Deno + Cliffy の組み合わせとして一般的に健全。ただし
「セットアップ途中で失敗したときの .env の残留状態」「Ctrl-C で対話を抜けたあとの
端末状態」「再設定時の oldインスタンス名ボリュームの孤立」など、エラーパス・中断
パスで状態が壊れやすい箇所が複数ある。manage.sh の unzip 失敗後処理にも注意が必要。
インスタンス名リネーム時の設計上のリスクは特に影響が大きい。

- 重大度件数: 🟢 2 / 🔵 1 / 🟡 5 / 🔴 3 / 💣 1
- ドキュメント軸: 🟣 3
- タグ別: 🤖 4 / 🙋 4

## ファイル別分類

| 分類 | ファイル | 一言コメント |
|---|---|---|
| 🔴 Error + 🟣 Doc | `cli/commands/setup.ts:128-142` | インスタンス名のデフォルト値を `Deno.env.get` から読むが `.env` は既読済みの `envMap` を使うべき（TOCTOU 相当）。コメントも旧フローを示している |
| 🟡 Warning | `cli/commands/setup.ts:214-218` | compose 失敗時に `Deno.exit(1)` で終了するが .env は既に書き換え済みのまま残り、次回再実行が中途半端な状態から始まる |
| 🟡 Warning + 🟣 Doc | `cli/commands/manage.ts:118-148` | logs の raw モード中に例外が発生した場合の端末状態リカバリ不足。コメント「ESC / q で戻る」はあるが Ctrl-C は raw モードのまま抜ける |
| 🔴 Error | `cli/commands/manage.ts:221-228` | setup 再実行でインスタンス名が変わるとき、旧ボリューム群が孤立するが警告・説明なし |
| 🟡 Warning | `cli/commands/manage.ts:233-260` | settings 変更後の再作成失敗でも `changed=true` を返し「変更は次回反映」表示になるが、コンテナが中途半端な状態になりえる |
| 🟡 Warning | `cli/commands/manage.ts:392-410` | restore: ボリューム削除成功後にボリューム作成失敗した場合、ボリュームが存在しない壊れた状態になる。allOk=false で継続するが後続の `compose up` は失敗する |
| 💣 Critical + 🙋 | `cli/commands/manage.ts:480-494` | reset が `down -v` でボリュームを削除するが、ワークスペースがホスト bind mount か volume かを判断せずに `workspace-data` も消す可能性がある |
| 🟡 Warning | `cli/commands/settings.ts:111-148` | カスタム DNS 入力時に IPv4 アドレス形式バリデーションがなく、任意文字列を .env に書き込める |
| 🟢 Safe | `cli/commands/settings.ts:189-229` | SSH ポート・タイムゾーン・ワークスペースのバリデーションは十分 |
| 🔴 Error | `cli/commands/doctor.ts:251-252` | instanceName を `envMap.get()` で取得するが、checkEnvFile が `ok:false` を返した場合（.env 未存在）でも `DEFAULT_INSTANCE_NAME` にフォールバックするため問題ないが、doctor が `needsEnv=true` を返した後に `setup()` が完走しないと次回 doctor で別の名前が表示される（TOCTOU 副作用）|
| 🟢 Safe | `cli/commands/doctor.ts:94-134` | `resolveImageRefs` のフォールバック処理は堅牢 |
| 🔵 Low | `cli/main.ts:1-30` | `case "setup"` 実行後に `manage()` を呼ばない点は意図的か。setup コマンドで起動後にユーザーが手動で再実行する必要がある |
| 🟣 Doc | `manage.sh:40` | `--allow-all` を使っているが CLAUDE.md にも README にも言及なし。セキュリティ上の意図のコメントが欲しい |
| 🟡 Warning | `manage.sh:29-37` | `unzip` 失敗時に `trap` で ZIP は削除されるが `.deno/bin/` ディレクトリと不完全バイナリが残り、次回起動時に「壊れた deno」が実行されうる |
| 🟣 Doc | `manage.bat:22` | `Invoke-WebRequest` はデフォルトで進捗バーを表示し CI で出力が乱れる。`-UseBasicParsing` も未指定（古い PowerShell で失敗しうる）。コメントなし |

## 詳細指摘

---

### 🔴 E-A-1 🙋: インスタンス名のデフォルト値が `Deno.env.get` から来る（既存 .env と不整合）

- **対象**: `cli/commands/setup.ts:128`
- **症状**:
  ```ts
  const currentInstance = Deno.env.get("CLOOPY_INSTANCE_NAME") ?? DEFAULT_INSTANCE_NAME;
  ```
  `Deno.env` はプロセス起動時の環境変数であり、直前に書き込まれた `.env` ファイルの
  内容とは別物。`manage.sh` はシェルスクリプト側で `.env` を `source` しないため、
  初回セットアップ以降の再セットアップでは `Deno.env.get` は常に `undefined` となり
  `DEFAULT_INSTANCE_NAME` が返る。ユーザーが以前 `mybox` と設定していても、再セット
  アップ時のデフォルトが `cloopy` になってしまう。
- **根本原因**: 同じファイル内で直前に `readEnvFile` 済みの情報と `Deno.env.get` を
  混在させている。`portInput` (l.144)・`tzInput` (l.160)・`wsInput` (l.175) も同様。
- **修正案 A（推奨）**: `setup` 関数冒頭で `const envMap = readEnvFile(projectRoot)` を
  呼び、すべての `currentXxx` を `envMap.get(KEY) ?? DEFAULT` に統一する。
- **修正案 B**: `manage.sh` 側で `.env` を `source` するが、値の展開や副作用が怖いため非推奨。
- **テスト**: 一度 setup 完了後に `./manage.sh setup` で再実行し、インスタンス名・
  ポート・TZが既存値でデフォルト表示されることを確認。

---

### 🔴 E-A-2 🙋: setup 中断時に .env が部分書き込み済みの状態で残る

- **対象**: `cli/commands/setup.ts:107-218`
- **症状**: ステップ2（対話設定書き込み）完了後、ステップ4（compose up）が
  `code !== 0` で `Deno.exit(1)` すると、`.env` には PUBKEY/UID/GID/インスタンス名
  等が書き込まれているが SSH 設定・known_hosts は完了、イメージ起動は未完了のまま。
  次回 `./manage.sh` 実行時、doctor は `.env` が存在し `CLOOPY_PUBKEY_PATH` もあるため
  `needsEnv=false` → `setup` をスキップし `manage()` に進む。しかし compose up は
  失敗しているためコンテナは停止中のまま。「起動」を手動で選ばなければならず、
  かつエラーメッセージには次のアクションが書かれていない。
- **根本原因**: setup の各ステップが独立した副作用を持ち、失敗時のロールバック機構がない。
- **修正案 A（最小）**: `Deno.exit(1)` 直前に「セットアップが中断されました。再度 `./manage.sh` を実行してください」の案内メッセージを追加し、次のアクションを明示する（🤖 相当だが挙動変更なし）。
- **修正案 B（根本）**: compose up 失敗時にも `Deno.exit` せず manage() に戻り、
  ユーザーが「起動」「ヘルスチェック」を選べる状態にする。ただしフロー変更を伴うため 🙋。
- **テスト**: Docker を停止した状態で `./manage.sh setup` を完走させ、compose up
  が失敗した後のメッセージと次回 `./manage.sh` の挙動を確認。

---

### 🔴 E-A-3 🙋: setup 再実行でインスタンス名が変わった場合に旧ボリュームが孤立する

- **対象**: `cli/commands/manage.ts:221-228`
- **症状**:
  ```ts
  case "setup": {
    if (isRunning) {
      await compose(projectRoot, ["down"]);
    }
    await setup();
    break;
  }
  ```
  `setup()` 内でインスタンス名を変更すると Compose プロジェクト名が変わり、
  旧インスタンス名のボリューム（`cloopy_home-data` 等）が Docker に残ったまま
  孤立する。ユーザーへの警告も、削除の提案もない。
- **根本原因**: 設計上、インスタンス名変更は「ボリュームのリネーム」ではなく
  「旧ボリュームを孤立させて新規作成」という意味になるが、その影響が UI に現れていない。
- **修正案 A（最小）**: setup 内でインスタンス名の変更を検出したとき、「旧ボリューム
  `${oldName}_*` が残ります。不要なら `docker volume rm` で削除してください」と案内。
- **修正案 B（根本）**: インスタンス名は再設定不可にし、変更したい場合はリセット後に
  再セットアップする手順を案内する（settings.ts の設計意図と整合）。
- **テスト**: 初回 `cloopy` でセットアップ後、manage → 再設定 → 名前を `mybox` に変更し
  `docker volume ls` で旧ボリュームが残ることを確認。

---

### 💣 C-A-1 🙋: reset が `down -v` で workspace-data ボリュームも無条件削除する

- **対象**: `cli/commands/manage.ts:490-493`
- **症状**:
  ```ts
  await compose(projectRoot, ["down", "-v"]);
  ```
  `docker compose down -v` はすべての named volumes を削除する。ユーザーが
  `CLOOPY_WORKSPACE_VOLUME=true` を設定している場合、ワークスペースデータも消える。
  reset のメッセージには「home-data / nix-store / ssh-config」の3つしか列挙されていないが、
  実際には workspace-data も削除される（l.481-485）。
- **根本原因**: `down -v` はすべての compose-defined volumes を対象とする。
  ユーザーに workspace-data の削除リスクが伝わっていない。
- **修正案 A（最小 🤖）**: reset の警告メッセージに
  `CLOOPY_WORKSPACE_VOLUME=true` の場合に workspace-data も列挙する条件分岐を追加。
- **修正案 B（推奨 🙋）**: workspace-data を reset 対象から外すか、個別確認するかを
  ユーザーに選択させる（`down -v` の代わりに個別 `volume rm`）。
- **SSH への影響**: なし（ボリューム削除のみ）
- **テスト**: `CLOOPY_WORKSPACE_VOLUME=true` でセットアップ後、reset を実行し
  workspace-data が消えることを確認。

---

### 🟡 W-A-1 🤖: manage.sh: unzip 失敗後に不完全な deno バイナリが残る

- **対象**: `manage.sh:29-37`
- **症状**:
  ```bash
  curl -fsSL --retry 3 --retry-delay 2 "$URL" -o "$TMP_ZIP"
  mkdir -p "$SCRIPT_DIR/.deno/bin"
  unzip -o -q "$TMP_ZIP" -d "$SCRIPT_DIR/.deno/bin"
  chmod +x "$DENO"
  ```
  `curl` が `set -e` のため失敗時は即 `exit`（`trap` で ZIP 削除）だが、
  `unzip` が部分的に成功してゼロバイトの `deno` バイナリを `.deno/bin/` に残した場合、
  `trap` は ZIP のみ削除し、次回実行時は「`$DENO` が存在する」判定（l.11 の `[ ! -f "$DENO" ]`）
  をパスしてしまい、壊れた deno が実行される。
- **修正案**: `unzip` 前に `rm -rf "$SCRIPT_DIR/.deno/bin"` でディレクトリを削除するか、
  `trap` を `rm -rf "$SCRIPT_DIR/.deno"` に拡張して部分インストールを掃除する。
- **テスト**: ZIP ダウンロード後に unzip を強制失敗させ、次回 manage.sh 実行で
  再インストールが走ることを確認。

---

### 🟡 W-A-2 🙋: logs の raw モード中に Ctrl-C が押されると端末が raw のままになる

- **対象**: `cli/commands/manage.ts:121-142`
- **症状**:
  ```ts
  Deno.stdin.setRaw(true);
  try {
    ...
    await Promise.race([child.status, waitForKey()]);
  } finally {
    Deno.stdin.setRaw(false);
  }
  ```
  `waitForKey` 内で `buf[0] === 0x03`（Ctrl-C）を検出して return するが、
  その場合は `finally` ブロックで `setRaw(false)` が実行される。一見問題ないように見えるが、
  Deno のシグナル処理（SIGINT）が raw モード中に非同期で割り込んだ場合、`finally` が
  完走する前にプロセスが終了し、端末が raw のまま残りえる。
- **根本原因**: Cliffy の Select.prompt がその後 raw モードを前提としないため、
  次のメニュー選択で文字が正常に表示されなくなる可能性がある。実際に問題が出るかは
  Deno バージョンとターミナル次第。
- **修正案**: `Deno.addSignalListener("SIGINT", () => { Deno.stdin.setRaw(false); })` で
  シグナルを捕捉して raw を戻すか、`pressAnyKey` と同様に SIGINT を `waitForKey` で
  処理することで Deno 自体の SIGINT 割り込みを抑制する。
- **テスト**: ログ表示中に Ctrl-C して、その後のメニュー選択が正常に動作するか確認。

---

### 🟡 W-A-3 🤖: restore: ボリューム削除後に作成失敗すると修復不能な状態になる

- **対象**: `cli/commands/manage.ts:415-430`
- **症状**:
  ```ts
  await new Deno.Command("docker", {
    args: ["volume", "rm", volume], ...
  }).output();  // エラー無視

  const create = await new Deno.Command("docker", { args: ["volume", "create", volume], ... }).output();
  if (create.code !== 0) {
    rsTimer.stop();
    console.error(...);
    allOk = false;
    continue;  // ← ボリュームが存在しない状態で次へ
  }
  ```
  `volume rm` 成功後、`volume create` が失敗した場合（例: ディスク容量不足）、
  ボリュームは存在しない状態で `continue` する。後続の `compose up` も失敗し、
  ユーザーはデータを失ったうえに何もできない状態になる。
- **修正案**: `volume create` 失敗時に `allOk=false` のまま `break` して以降のボリュームを
  処理しないようにするか、「バックアップ前に現状維持できない」旨をより明確に案内する。
  少なくとも「この時点でボリュームが消えました。再起動は不可能です」を表示する（🤖）。
- **テスト**: volume create が失敗するシナリオ（存在しない docker デーモンなど）で
  エラーメッセージを確認。

---

### 🟡 W-A-4 🤖: settings: カスタム DNS に IPv4 バリデーションがない

- **対象**: `cli/commands/settings.ts:111-130`
- **症状**:
  ```ts
  const primary = (await Input.prompt({
    message: "プライマリ DNS (IPv4)",
    default: dns,
  })).trim();
  ```
  `validate` が未指定のため、`abc`, `999.999.999.999`, 空白のみ、など無効な値を
  `.env` の `CLOOPY_DNS_PRIMARY` に書き込めてしまう。DNS ピン留め（`init-firewall.sh`）が
  無効な IP でルールを積もうとしてサイレントに失敗しうる。
- **修正案**: `port` 入力と同様に `validate` を追加:
  ```ts
  validate: (s: string) => {
    const ip = s.trim();
    if (!ip) return "IP アドレスを入力してください";
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return "有効な IPv4 アドレスを入力してください";
    return true;
  }
  ```
- **テスト**: `abc` を入力してバリデーションエラーが表示されることを確認。

---

### 🟡 W-A-5 🤖: manage.sh: unzip が利用できない環境の考慮がない

- **対象**: `manage.sh:31`
- **症状**: `unzip` がない環境（Alpine ベースの Linux コンテナ、最小 Ubuntu など）では
  `unzip: command not found` でエラーになり、エラーメッセージが `set -e` で即終了する。
  ただし Deno の公式インストール手順も unzip 前提のため、ドキュメント的に許容範囲内。
- **修正案（最小）**: `command -v unzip > /dev/null 2>&1 || { echo "[cloopy] ERROR: unzip not found. Please install unzip."; exit 1; }` を `unzip` 呼び出し前に追加し、分かりやすいメッセージを出す（🤖）。
- **テスト**: unzip を PATH から外して manage.sh を実行しエラーメッセージを確認。

---

### 🟣 D-A-1 🤖: manage.ts の settings フロー: settings 変更でインスタンス名変更できないことが UI に示されていない

- **対象**: `cli/commands/settings.ts:43-51` + `cli/commands/manage.ts:231`
- **症状**: settings.ts の JSDoc には「Instance name is intentionally NOT editable here」と
  書かれているが、UI 上のメニュー名は「設定変更」のみで、どの設定が変更可能かの説明がない。
  manage → 再設定（setup）経由では変更できてしまう（E-A-3 の根本）。
- **修正案**: settings メニューに最初に「※ インスタンス名の変更は再設定（setup）ではなく
  リセット後のセットアップで行ってください」のような案内を `console.log` で表示する（🤖）。

---

### 🟣 D-A-2 🤖: manage.sh の `--allow-all` にセキュリティ上の注釈がない

- **対象**: `manage.sh:40`
- **症状**:
  ```bash
  "$DENO" run --allow-all "$SCRIPT_DIR/cli/main.ts" "$@"
  ```
  `--allow-all` は Deno の全パーミッションを付与する。`docker exec -u root` を呼ぶため
  実質的に必要だが、コードレビューや監査時に意図が分からない。
- **修正案**: `# --allow-all: docker / ssh / fs への広範なアクセスが必要なため` 等のコメントを追加（🤖）。

---

### 🟣 D-A-3 🤖: manage.bat の PowerShell ダウンロードに `-UseBasicParsing` とサイレントオプションがない

- **対象**: `manage.bat:22`
- **症状**:
  ```bat
  powershell -Command "Invoke-WebRequest -Uri '%DENO_URL%' -OutFile '%DENO_ZIP%'"
  ```
  `-UseBasicParsing` がないと IE エンジン不在の環境（Server Core / Windows Server 2019 初期）
  で失敗することがある。また `-Verbose:$false` / `-ProgressAction SilentlyContinue` がないため
  CI で出力が乱れる。
- **修正案**:
  ```bat
  powershell -Command "Invoke-WebRequest -UseBasicParsing -Uri '%DENO_URL%' -OutFile '%DENO_ZIP%'"
  ```
  （🤖）

---

### 🔵 L-A-1: main.ts の `case "setup"` 完了後に manage() を呼ばない

- **対象**: `cli/main.ts:20-22`
- **症状**:
  ```ts
  case "setup":
    await setup();
    break;
  ```
  `./manage.sh setup` を直接実行すると setup 完了後にプロセスが終了し、
  `./manage.sh` を再実行しなければ管理メニューに入れない。`doctor` の場合も同様。
  UX として問題になりうるが、意図的な設計（サブコマンドは単機能）である可能性もある。
- **判断不要**（設計意図の確認が必要な 🙋 案件ではなく、現状の動作がドキュメントと一致しているかの確認）。
  現時点では Low として継続注視。

---

## 重要な設計の可視化

### setup() フロー: .env 書き込み vs 失敗タイミング

```
setup.ts の実行フロー（行番号は setup.ts 内）
────────────────────────────────────────────────
[Step 1] ensureKeyPair()                  l.100
    │  失敗 → throw (未捕捉 → プロセス終了、.env は未作成)
    ▼ OK
[Step 2-a] ensureEnvFile()               l.107
    │  .env が存在しなければ .env.example からコピー
    ▼ OK (.env は空の状態で存在する)
[Step 2-b] setEnvVar(PUBKEY_PATH,...)     l.110
[Step 2-c] setEnvVar(UID,GID,...)         l.121-123
    │  ← .env に auto block を書き込み済み
    ▼
[Step 2-d] 対話入力 (instanceName/port/tz/ws)  l.130-183
    │  Ctrl-C → Cliffy が throw → .env は auto block のみで残る
    │  (次回 doctor: .env 存在 + PUBKEY_PATH あり → needsEnv=false)
    ▼ OK
[Step 2-e] setEnvVar(INSTANCE/PORT/TZ/WS...)  (各 if 節)
[Step 2-f] setEnvVar(WORKSPACE_VOLUME,...)    l.190-195
    ▼
[Step 2-g] generateLocalCompose()            l.198
    ▼
[Step 3] injectSshConfig()                  l.205
    ▼
[Step 4] compose up                         l.214
    │  失敗 → Deno.exit(1) ← .env/SSH 設定は完了済み
    │  !! ユーザーへの次アクション案内なし (E-A-2)
    │  !! 次回 doctor は needsEnv=false → manage() へ (E-A-2)
    ▼ OK
[Step 5] refreshKnownHosts()               l.220
[Step 6] checkBootstrapStatus()            l.221
[完了]
```

### manage() の settings フロー: 再作成ルート

```
manage.ts:231 case "settings"
    │
    ▼
editSettings(projectRoot) → changed: boolean    settings.ts
    │
    │ changed = false → break (何もしない)
    │
    ▼ changed = true
    │
    ├─ isRunning = false → "変更は次回の起動時に反映されます"  l.261
    │
    └─ isRunning = true
         │
         ▼
        Confirm.prompt("再作成しますか?")
         │
         ├─ No → "変更は次回の起動/再作成時に反映されます"    l.256-259
         │
         └─ Yes
              │
              ▼
             compose(up --build --wait ...)                 l.240
              │
              ├─ code != 0 → error メッセージのみ           l.253
              │  !! コンテナが "recreating" 中断状態になりえる
              │  !! SSH 接続が切断されたまま案内なし
              │
              └─ code = 0
                   │
                   ▼
                  injectSshConfig(port2, instanceName)      l.248
                  refreshKnownHosts(port2)                  l.249
                  checkBootstrapStatus(projectRoot)         l.250
                  "設定を反映しました"                        l.251
```

## 横断観点での所見

### 設計境界
- `setup.ts` と `settings.ts` はどちらも `.env` に書き込む責務を持つが、
  `setup` は `Deno.env.get` ベース、`settings` は `readEnvFile` ベースという
  **不整合**がある（E-A-1）。`readEnvFile` に統一するのが適切。
- インスタンス名のライフサイクルが複数コマンドにまたがって管理されており、
  「変更できる場所」と「変更すると壊れる場所」の境界が UI に見えていない（E-A-3・D-A-1）。

### リソース所有権
- Docker ボリュームの所有権管理が CLI 側にない。`compose down -v` は
  Compose が管理する全 named volumes を削除するため、CLI 側で「どのボリュームを
  reset の対象にするか」を制御できていない（C-A-1）。
- `manage.sh` / `manage.bat` の `.deno/` ローカルインストールは冪等だが、
  部分インストール後の検出ロジックが弱い（W-A-1）。

### テスト網羅
- `cli/lib/` にはテスト（`*_test.ts`）があるが、`cli/commands/` 配下に
  テストファイルが存在しない。特にセットアップ冪等性・エラーパス・インスタンス
  リネームの挙動が未テスト。

### ドキュメント整合（🟣 Doc）
- `setup.ts` のデフォルト値取得ロジックに `// from .env` 等の注釈がなく、
  `Deno.env` を参照している意図が読み取れない（E-A-1 の副作用）。
- `manage.sh` の `--allow-all` と `manage.bat` の `Invoke-WebRequest` 省略オプションは
  いずれもコメントなし（D-A-2・D-A-3）。
