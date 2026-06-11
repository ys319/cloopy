---
group: D
topic: CLI コマンド層差分（manage 2階層メニュー再編・setup/settings/doctor・文言リファクタ）
files_reviewed: 10
date: 2026-06-11
model: sonnet
---

# Group D: CLI コマンド層差分

## サマリ

manage メニューの 2 階層化（`a578d5f`）と文言リファクタ（`742f83e`）は設計上健全で
退行は検出されない。ROADMAP 送りの未解決項目 4 件は現状を行番号で確認した（下記参照）。
新規に 3 件の軽微な問題を発見: `setup.ts` の `lanInput` 初期値バグ（カスタム bind 維持
パスで「LAN 公開ヒント」が誤表示）、`rebuild` ケースの `up` 失敗時無言処理、
`settings.ts` のタイムゾーン検証欠落。`deno lint` / `deno fmt` / `deno test`（83/83）は
全クリーン。

- 重大度件数: 🟢 3 / 🔵 3 / 🟡 3 / 🔴 0 / 💣 0
- ドキュメント軸: 🟣 1
- タグ別: 🤖 3 / 🙋 1

## ファイル別分類

| 分類 | ファイル | 一言コメント |
|---|---|---|
| 🟢 Safe | `cli/lib/constants.ts` | LOCAL_BIND 定数追加のみ、安定 |
| 🟢 Safe | `cli/lib/env.ts` | CRLF 対応・空ファイル修正は前回確認済み、テスト 13/13 |
| 🟢 Safe | `cli/lib/workspace.ts` | symlink 実体解決の追加。テスト 8/8（sandbox 制限で symlink テストは `--allow-write` 必要だが本体は clean） |
| 🟡 Warning + 🟣 Doc | `cli/commands/setup.ts:220` | `lanInput` 初期値 `true` がカスタム bind 維持パスで漏れる。完了後ヒント（行 320）が誤表示 |
| 🔵 Low | `cli/commands/manage.ts:307-320` | `rebuild` の `upCode != 0` 時に無言 + `refreshKnownHosts` 6 秒リトライが無駄に走る |
| 🔵 Low | `cli/commands/manage.ts:100` | `instanceName` が `while` ループ内で再読込されず `setup()` 後に stale（E-A-3 継続） |
| 🔵 Low | `cli/commands/settings.ts:290-300` | `case "tz"` に `Intl.DateTimeFormat` 検証がない（`setup.ts` との非対称） |
| 🟡 Warning | `cli/commands/manage.ts:152-178` | 2 階層サブメニュー内の `Select.prompt` に try/catch なし。`^C` は cliffy が process.exit するため SIGINT の rawモード残留は UX-2 (ROADMAP) の延長 |
| 🟡 Warning | `cli/commands/setup.ts:265-269` | `useVolume` (`CLOOPY_WORKSPACE_VOLUME`) のデフォルトが常に `false`。他の対話項目は `savedEnv` 優先なので非対称。再 setup でボリューム設定が毎回聞き直される |
| 🟣 Doc | `cli/commands/manage.ts:331-336` | `case "setup"` がコンテナを停止してから `setup()` を呼ぶが、`setup()` 自身は `compose down` を呼ばない（`compose up` のみ）。コメントは「down → up で必ず再作成」と書くが実際は outer の down + setup の up |
| 🟢 Safe | `cli/commands/doctor.ts` | `dockerOk` / `dockerMissing` 追加・CLOOPY_SSH_BIND 形式検証・pubkey 実在確認は全て正確 |

> `cli/lib/compose.ts` は JSDoc コメント追加のみ（ロジック変更なし）。

## 詳細指摘

---

### 🟡 W-D-1 🤖: `lanInput` 初期値バグ — カスタム bind 維持パスで「LAN 公開ヒント」が誤表示

- **対象**: `cli/commands/setup.ts:220` および `setup.ts:320`
- **症状**:
  ```ts
  let lanInput = true;          // l.220
  if (currentBind !== "" && currentBind !== LOCAL_BIND) {
    // カスタム bind → Confirm.prompt をスキップ
    // lanInput は true のまま！
  } else {
    lanInput = await Confirm.prompt(...)  // l.228
  }
  // ...
  if (lanInput) {               // l.320
    console.log(dim("  他マシンから: ...LAN 公開ヒント..."));
  }
  ```
  カスタム bind（`192.168.1.5:` 等）が保存済みの場合、`lanInput` は `true` のまま
  `Confirm.prompt` をスキップする。その結果、セットアップ完了メッセージ（l.320）で
  「他マシンから接続する手順」が誤って表示される。ユーザーはカスタム bind を設定して
  いるのに「LAN 公開しています」という誤案内を受ける。
- **根本原因**: `lanInput` のデフォルトを `true` にした後、カスタム bind パスで
  その値を更新せずに通過している。
- **修正案** (🤖):
  ```ts
  // l.219 の currentBind 定義直後に初期値を実際の状態から設定
  const isLanExposed = currentBind === "";  // 空 = 全インターフェース = LAN 公開中
  let lanInput = isLanExposed;
  ```
  または、カスタム bind ブランチの末尾に `lanInput = true` のコメント付き代入を追加。
- **テスト**: `CLOOPY_SSH_BIND=192.168.1.5:` で setup 再実行し、完了画面にリモート接続
  ヒントが出ないことを確認。

---

### 🔵 L-D-1: `rebuild` の `up` 失敗時に無言 + `refreshKnownHosts` 6 秒ムダリトライ

- **対象**: `cli/commands/manage.ts:307-320`
- **症状**:
  ```ts
  if (buildCode === 0) {
    const upCode = await compose(projectRoot, upArgs());
    if (upCode === 0) keysPendingApply = false;
    // upCode != 0 でもエラーメッセージ出力なし ↓
    const env = readEnvFile(projectRoot);
    const port = env.get("CLOOPY_SSH_PORT") ?? DEFAULT_SSH_PORT;
    await refreshKnownHosts(port, instanceName);   // コンテナ停止中で失敗 → 6秒リトライ
    await checkBootstrapStatus(projectRoot);
  }
  ```
  `compose build` が成功し `compose up` が失敗した場合（ポート競合等）、エラーメッセージが
  表示されないまま `refreshKnownHosts` が 3 回リトライ (2秒×3=6秒) を消費して失敗する。
  旧コードも同じ挙動（upCode を無視）だったが、新コードで `upCode` を取得したことで
  修正の機会が生まれた。
- **修正案**:
  ```ts
  const upCode = await compose(projectRoot, upArgs());
  if (upCode === 0) {
    keysPendingApply = false;
    const env = readEnvFile(projectRoot);
    const port = env.get("CLOOPY_SSH_PORT") ?? DEFAULT_SSH_PORT;
    await refreshKnownHosts(port, instanceName);
    await checkBootstrapStatus(projectRoot);
  } else {
    console.error(red("[cloopy] 起動に失敗しました"));
  }
  ```

---

### 🔵 L-D-2 (E-A-3 継続): `instanceName` が `setup()` 後にステール

- **対象**: `cli/commands/manage.ts:100` + `case "setup"` (l.328-337)
- **症状**: `instanceName` は `manage()` の最初に 1 回だけ読み込まれ、`setup()` が
  インスタンス名を変更しても更新されない。ループ次回以降:
  - l.118: ヘッダーに旧名を表示
  - l.153: `printCurrentSettings` に旧名を渡す（中の `readEnvFile` は新値を返すが
    ヘッダー `現在の設定 [${instanceName}]` は旧名のまま）
  - l.259: `ssh <旧名>` で接続失敗
  - l.358-359: `injectSshConfig` / `refreshKnownHosts` に旧名を渡す
- **影響**: ユーザーが再設定でインスタンス名を変更した場合、`manage()` から抜けて
  再起動するまで SSH/VSCode 操作が旧名を参照し続ける。ROADMAP E-A-3 の範囲。
- **修正案 (🙋)**: `case "setup"` の末尾で `instanceName` を再読み込みするか、
  ループ先頭で毎回 `readEnvFile` から取得する。前者が最小変更:
  ```ts
  await setup();
  keysPendingApply = false;
  // instanceName を refresh してループ先頭へ
  // ただし const なので let に変更が必要 → 設計判断
  ```

---

### 🔵 L-D-3: `settings.ts` の `case "tz"` にタイムゾーン検証がない

- **対象**: `cli/commands/settings.ts:290-300`
- **症状**:
  ```ts
  case "tz": {
    const v = (await Input.prompt({
      message: "タイムゾーン",
      hint: "例: Asia/Tokyo, UTC",
      default: tz,
    })).trim();
    if (v && v !== tz) {
      setEnvVar(envPath, "CLOOPY_TIMEZONE", v);
  ```
  `setup.ts` の同じ項目 (`l.240-252`) は `Intl.DateTimeFormat` で検証するが、
  `settings.ts` では任意の文字列を書き込める。不正な TZ 値はコンテナ内の
  `TZ` 環境変数として渡され、s6 の syslog 等に影響する可能性がある。
- **修正案** (🤖): `setup.ts:244-249` と同じ `validate` クロージャを追加。

---

### 🟡 W-D-2: 2 階層サブメニューの `Select.prompt` に例外ガードなし（UX-2 延長）

- **対象**: `cli/commands/manage.ts:152-178`
- **症状**: `menu-settings` / `menu-maintenance` のサブ Select.prompt（l.154, l.166）は
  try/catch で囲まれていない。cliffy の `Select.prompt` は `^C` でプロセスを exit する
  実装のため raw モード残留は発生しないが、UX として escape 不能。ROADMAP UX-2 で
  「ESC や空入力で一つ前のメニューへ戻れるように」と記録されているが、サブメニューが
  増えた分だけ問題範囲が広がった。
- **現状**: ROADMAP UX-2 は設計検討中。「戻る」選択肢を必ず最後に置く実装は維持されており、
  キーボード操作で一番下を選べば戻れる。ESC 不可の問題は同じ。
- **判断**: ROADMAP UX-2 の解決と同時に対処が適切。🙋

---

### 🟡 W-D-3: `useVolume` プロンプトのデフォルトが常に `false`（再設定時に非対称）

- **対象**: `cli/commands/setup.ts:265-269`
- **症状**:
  ```ts
  const useVolume = await Confirm.prompt({
    message: "ワークスペースに Docker ボリュームを使用しますか？",
    hint: "Windows では推奨",
    default: false,   // ← savedEnv から読まない
  });
  ```
  他の対話項目（インスタンス名・ポート・TZ・ワークスペースパス）は `savedEnv` から
  デフォルトを読み込む（前回レビュー E-A-1 の修正）。しかし `useVolume` のデフォルトは
  常に `false` のまま。`CLOOPY_WORKSPACE_VOLUME=true` で運用しているユーザーが再 setup
  すると、Enter 一発で `false` に戻ってしまう。
- **注記**: 旧コードも同じ動作（デフォルト false）だったため regression ではなく
  E-A-1 修正の適用漏れ。
- **修正案** (🤖):
  ```ts
  const currentVolume = savedEnv.get("CLOOPY_WORKSPACE_VOLUME") === "true";
  const useVolume = await Confirm.prompt({
    ...
    default: currentVolume,
  });
  ```

---

### 🟣 D-D-1 🤖: `case "setup"` のコメントがフロー実態と不一致

- **対象**: `cli/commands/manage.ts:335-336`
- **症状**:
  ```ts
  await setup();
  // setup は down → up で必ず再作成するため、未反映の鍵変更も反映済み
  keysPendingApply = false;
  ```
  コメントは "setup は down → up" と述べているが、`setup.ts` 自身は `compose down` を
  呼ばない（`compose up` のみ）。コンテナ停止は `manage.ts:329-333` が担当。
  実際のフローは「manage が down → setup が up」であり、コメントが主語を間違えている。
- **修正案** (🤖):
  ```ts
  // manage が down → setup が up の順で再作成するため、未反映の鍵変更も反映済み
  ```

## 重要な設計の可視化

### manage() メニュー 2 階層遷移図（`a578d5f` / `742f83e` 時点）

```
manage.ts:113  while (true)
  │
  ├─ getStatus(projectRoot)  l.114
  │
  ▼
[メインメニュー] Select.prompt  l.123-148
  │
  ├─ [isRunning=true]
  │    ├─ "ssh"       → case "ssh"   l.256
  │    ├─ "vscode"    → case "vscode" l.267
  │    ├─ "stop"      → case "stop"  l.197
  │    ├─ "restart"   → case "restart" l.203
  │    └─ "logs"      → case "logs"  l.223
  │
  ├─ [isRunning=false]
  │    └─ "start"     → case "start" l.186
  │
  ├─ "menu-settings" ──────────────────────────────────────────────┐
  │    printCurrentSettings() l.153                                  │
  │    [サブメニュー] Select.prompt l.154-163                        │
  │      ├─ "settings"  → case "settings"  l.339   ◀──────────────┘
  │      ├─ "keys"      → case "keys"      l.375
  │      ├─ "setup"     → case "setup"     l.328
  │      └─ "back"      → continue (l.181)
  │
  ├─ "menu-maintenance" ───────────────────────────────────────────┐
  │    [サブメニュー] Select.prompt l.166-178                        │
  │      ├─ "doctor"   → case "doctor"  l.323   ◀─────────────────┘
  │      ├─ "rebuild"  → case "rebuild" l.307
  │      ├─ "shell"    → case "shell"   l.291
  │      ├─ "backup"   → case "backup"  l.422
  │      ├─ "restore"  → case "restore" l.484
  │      ├─ "reset"    → case "reset"   l.626
  │      └─ "back"     → continue (l.181)
  │
  ├─ "remotes"     → case "remotes"  l.418
  │
  └─ "quit"        → return  l.675

注意: "back" は l.181 の `if (choice === "back") continue` で処理される。
      サブメニュー内で case に到達しないパス（back）の後、switch 文はスキップされる。

keysPendingApply フラグ（l.107）の影響:
  true の場合: start/restart/rebuild/settings の compose up が --force-recreate に昇格
  false にリセット: start 成功 l.192 / restart 成功 l.212 / rebuild up 成功 l.313 /
                    setup 後 l.336 / settings up 成功 l.351 / keys up 成功（確認後）
  true にセット: keys の Confirm=No l.405 / keys の up 失敗 l.401 / 停止中の keys l.413
```

### setup() フロー（`dff7a81` + `G Phase 1-3` 修正後）

```
setup.ts:101  setup()
  │
  ▼
[Step 1] ensureKeyPair()           l.112  ← ~/.ssh/cloopy/id_ed25519{,.pub} 生成
  │       rebuildAuthorizedKeys()  l.127  ← 束ファイル再生成（追加鍵を含む）
  ▼
[Step 2] ensureEnvFile()           l.141  ← .env を .env.example から生成（初回のみ）
  │       setEnvVar(PUBKEY_PATH)   l.146  ← authorizedKeysPath() を指定
  │       setEnvVar(UID/GID)       l.148-158
  │
  │       savedEnv = readEnvFile() l.166  ← .env の保存値を読む
  │
  │   [対話]
  │       instanceInput   l.179    ← savedEnv 優先 + リモート名衝突チェック
  │       portInput       l.199    ← savedEnv 優先
  │       bind (LAN?)     l.218-236 ← カスタム bind は維持（Confirm スキップ）
  │         ↑ W-D-1: lanInput=true のまま残留するバグあり
  │       tzInput         l.238    ← savedEnv 優先
  │       wsInput         l.254    ← savedEnv 優先
  │       useVolume       l.265    ← 常に default=false（W-D-3）
  ▼
[Step 3] injectSshConfig()         l.285
  ▼
[Step 4] compose up --build        l.294  ← COMPOSE_UP_ARGS（--force-recreate なし）
  │       refreshKnownHosts()      l.303
  │       checkBootstrapStatus()   l.304
  ▼
[完了] ヒント表示                   l.311-328
  │   if (lanInput) { LAN ヒント } ← lanInput=true はカスタム bind でも誤発火（W-D-1）
```

## ROADMAP 未解決項目の判定

| ID | 判定 | 根拠 |
|---|---|---|
| **E-A-3** (インスタンス名変更で旧ボリューム孤立) | **未解決のまま** | `manage.ts:100` で `const instanceName` は 1 回のみ設定。`case "setup"` 後のリフレッシュなし。孤立ボリュームへの警告・案内も追加されていない |
| **W-A-2** (logs の raw モード残留疑い) | **未解決のまま** | `manage.ts:224-254` のコードは前回 `6ca8102` 時点と同一。`waitForKey` 内の `0x03` 捕捉 + try/finally はあるが、SIGINT 非同期割込みの実機未確認という状態は変わらず |
| **W-A-3** (restore 失敗時の中途半端な状態) | **未解決のまま** | `manage.ts:553-622`: `allOk=false` 時の再試行案内・削除前検証は追加されていない。エラーメッセージはボリューム単位で改善されたが、根本の「ボリューム削除後に作成失敗すると修復不能」は未対処 |
| **UX-2** (対話プロンプトのキャンセル不可) | **未解決のまま（悪化なし）** | `settings.ts` に `while(true)` + 「戻る」の構造は変わらず。2 階層メニュー追加で `Select.prompt` 呼び出しが増えたが、各々に「戻る」がある。ESC 非対応は変わらず |

## 横断観点での所見

### 設計境界
- `setup()` は `compose down` を呼ばない（外の `manage` が担当）。コメントの記述と
  実態が食い違っている点（🟣 D-D-1）は、次回 `setup()` が他の場所から呼ばれる際に
  誤解を招く可能性がある。
- `keysPendingApply` フラグは `manage()` のクロージャに閉じており設計は適切。
  ただし `rebuild` のフローでフラグクリアのタイミングが `up` 成否と `refresh` の
  呼び出しの間にある（L-D-1）。

### リソース所有権
- `C-A-1`（reset の workspace-data 削除）は `a578d5f` で修正済み。
  `CLOOPY_WORKSPACE_VOLUME=true` 時の `resetVolumes` にワークスペースが含まれず、
  表示も `dim("(workspace-data は保持されます)")` で明示。完全解決を確認（`manage.ts:633-644`）。
- `backup` は `CLOOPY_WORKSPACE_VOLUME=true` 時のみ `workspace-data` を対象に含む
  （`manage.ts:431-435`）。これも正しく実装されている。

### テスト網羅
- 今回のレビュー対象 (`manage/setup/settings/doctor`) にはコマンドレベルの自動テストがない
  （前回レビューから変わらず）。`lib/` 層のテストは 83/83 パス。
- W-D-1 (`lanInput` バグ）はカスタム bind 設定の再 setup というニッチなパスで発生するため
  手動テストで見落とされやすい。`setup()` 純粋関数化後にテストを追加することを推奨。

### ドキュメント整合（🟣 Doc）
- D-D-1: `manage.ts:335` のコメント "setup は down → up" は `setup()` 自身は down を
  しないため不正確。外 `manage` が down を担う構造であることを明記すべき。
