---
group: B
topic: SSH 鍵管理（keys）
files_reviewed: 3
date: 2026-06-11
model: sonnet
---

# Group B: SSH 鍵管理（keys）

## サマリ
- 総評: 全体的に設計意図が明快で不変条件（自動生成鍵が束の先頭・削除不可）は全経路で守られている。セキュリティ上の設計境界（HTTPS 強制・ユーザー名検証・type ホワイトリスト + blob 内アルゴリズム照合）も適切。主な懸念は ssh-rsa の blob 構造が部分的にしか検証されない点（有効だが中身が壊れた鍵が通る）と、saveKeyStore 成功後に rebuildAuthorizedKeys が失敗した際の store/bundle 不整合。これら 2 件は 🟡 Warning だが実害は限定的。
- 重大度件数: 🟢 2 / 🔵 5 / 🟡 2 / 🔴 0 / 💣 0
- ドキュメント軸: 🟣 1
- タグ別: 🤖 2 / 🙋 2

## ファイル別分類
| 分類 | ファイル | 一言コメント |
|---|---|---|
| 🟡 Warning | `cli/lib/keys.ts:118–168` | ssh-rsa blob の e/n フィールド欠落を許容（型照合のみで構造検証なし）|
| 🟡 Warning + 🟣 Doc | `cli/commands/keys.ts:101–102, 314–316` | saveKeyStore と rebuildAuthorizedKeys の間に失敗すると store/bundle が乖離。コメントにその旨の注記なし |
| 🔵 Low | `cli/lib/keys.ts:336–368` | fetchGithubKeys にレスポンスサイズ上限なし |
| 🔵 Low | `cli/lib/keys_test.ts:180–209` | fetchGithubKeys のネットワークエラーパス未テスト |
| 🔵 Low | `cli/lib/keys_test.ts:258–287` | rebuildAuthorizedKeys テストがファイルパーミッション(0o600)を未検証 |
| 🔵 Low | `cli/commands/keys.ts:222–229` | `invalid` 行の再パースで `r.ok ? "?" : r.error` の `ok` 分岐が死コード |
| 🔵 Low | `cli/commands/keys.ts:230–236` | "ファイルから追加" でコメントなし鍵にラベルを問わない（一覧で匿名表示） |
| 🟢 Safe | `cli/lib/keys.ts:71–169` (parsePublicKey) | type ホワイトリスト + base64 デコード + blob algo 照合の三重チェック。秘密鍵・options 付き行・DSA を適切に拒否 |
| 🟢 Safe | `cli/lib/keys.ts:202–244` (store I/O) | 不正 JSON/スキーマ不正を空扱いにせず明示エラー。writeFileAtomic でアトミック書き込み |

> Doc は重大度と独立軸。`cli/commands/keys.ts:101–102` は 🟡 かつ 🟣 D-B-1 を併記。

---

## 詳細指摘

### 🟡 W-B-1 🙋: ssh-rsa blob の構造検証が algo name 照合止まり（破損 RSA 鍵が通る）

- **対象**: `cli/lib/keys.ts:118–168`（parsePublicKey の ssh-rsa 分岐）
- **症状**: `rsaModulusBits()` が e/n フィールドを読めなかった場合（truncated blob）は `undefined` を返し、`key.rsaBits = undefined` のまま `ok: true` が返る。実際に以下の最小 blob が通過する（`AAAAB3NzaC1yc2E=` = `\x00\x00\x00\x07ssh-rsa` のみ）:
  ```
  ssh-rsa AAAAB3NzaC1yc2E=
  → parsePublicKey: { ok: true, key: { type: "ssh-rsa", rsaBits: undefined } }
  ```
  （deno eval で実確認済み）
- **根本原因**: `parsePublicKey` は blob 先頭の algo 名がプレフィックスと一致するかだけを検証する（line 155–159）。ssh-rsa 固有の「e フィールドと n フィールドが存在すること」をチェックしていない。`rsaModulusBits` は計算専用関数であり、欠落時に `undefined` を返すだけで検証はしない（line 91–109）。
- **影響**: sshd は authorized_keys の不正 RSA 鍵を黙って無視する（ログインは拒否されるが攻撃には使えない）。ただしユーザーは「追加成功」と思い込み、そのアカウントから SSH できなくなる可能性がある（可用性の問題）。
- **修正案 A（最小限）**: `parsePublicKey` の ssh-rsa 分岐で `rsaBits === undefined` のとき `ok: false` を返す。
  ```ts
  // cli/lib/keys.ts:167 付近
  if (type === "ssh-rsa") {
    key.rsaBits = rsaModulusBits(blob);
    if (key.rsaBits === undefined) {
      return { ok: false, error: "ssh-rsa 鍵データの構造が不正です (e/n フィールドが読めません)" };
    }
  }
  ```
- **修正案 B（検討）**: `rsaModulusBits` に戻り値を `number | null`（null=欠落）にして明示的に区別する。修正案 A で十分。
- **テスト**: `cli/lib/keys_test.ts` に `parsePublicKey('ssh-rsa AAAAB3NzaC1yc2E=').ok === false` のケースを追加。

---

### 🟡 W-B-2 🙋: saveKeyStore 成功後に rebuildAuthorizedKeys が失敗すると store/bundle が乖離

- **対象**: `cli/commands/keys.ts:101–102`（confirmAndAdd の鍵追加順序）および `cli/commands/keys.ts:314–316`（remove の削除順序）
- **症状**:
  - **追加ケース**: `saveKeyStore(store)` → `rebuildAuthorizedKeys(store.keys)` の順。diskfull 等で bundle 書き込みが失敗した場合、keys.json には新鍵が記録されているが authorized_keys には反映されない。catch block（line 322–328）が `loadKeyStore()` で store を再読み込みするため、以降の list 表示には鍵が見えるが SSH では使えない不整合状態が続く。
  - **削除ケース**: `saveKeyStore(store)` → `rebuildAuthorizedKeys(store.keys)` の順。bundle 書き込み失敗時、鍵は JSON から消えたが authorized_keys にはまだ存在する（アクセス可能のまま）。
- **根本原因**: 2 操作が分割トランザクション的に行われており、原子性がない。
- **発生頻度**: disk full または `~/.ssh/cloopy/` のパーミッション変更がない限りほぼ発生しない。
- **修正案 A（現状許容）**: catch block のエラーメッセージに「鍵管理メニューを再表示して確認してください」を追加し、ユーザーに再確認を促す（🟣 Doc で対処可能）。
- **修正案 B（設計変更）**: bundle を先に temp ファイルへ書き（まだリネームしない）、store を書いてから bundle を rename する順序にすることで「store 保存 OK → bundle 書き込み OK」を保証しやすくする。ただし store 保存後に crash しても整合は取れないため不完全。
- **判断**: 実害頻度が低く修正案 B も完全ではないため、現状は修正案 A（コメント追加）程度で ROADMAP 送りが妥当。🙋

---

### 🔵 L-B-1: fetchGithubKeys にレスポンスボディのサイズ上限なし

- **対象**: `cli/lib/keys.ts:364` (`const text = await res.text()`)
- **症状**: GitHub が巨大なレスポンスを返した場合（理論値）、`res.text()` が全体をメモリに展開する。実際には GitHub `.keys` エンドポイントは数 KB 以内が通常であり、現実的リスクは低い。
- **修正案**: `res.body` を `ReadableStream` で読みバイト数が上限（例: 128 KB）を超えたら中断する。または「行数の上限」として `parseKeysText` に keys.length > N で打ち切るロジックを追加する。
- **テスト**: 大量行のモックレスポンスで keys 件数上限チェック。
- **断定**: 現行コードで問題になる事例は確認できていない。GitHub のサービス仕様変更への保険として 🔵 扱い。

---

### 🔵 L-B-2: fetchGithubKeys のネットワークエラーパス（fetchFn が throw）が未テスト

- **対象**: `cli/lib/keys.ts:347–351`、`cli/lib/keys_test.ts:180–209`
- **症状**: fetchFn が例外を投げる経路（DNS 失敗・タイムアウト等）は `{ status: "error", message: "...ネットワークエラー..." }` を返すが、テストで網羅されていない。
- **修正案**: 🤖 テストに 1 ケース追加:
  ```ts
  const netErr: typeof fetch = () => Promise.reject(new Error("ENOTFOUND"));
  const res = await fetchGithubKeys("octocat", netErr);
  assertEquals(res.status, "error");
  if (res.status === "error") assertStringIncludes(res.message, "ネットワーク");
  ```

---

### 🔵 L-B-3 🤖: "ファイルから追加" の invalid 行処理に死コード分岐

- **対象**: `cli/commands/keys.ts:222–229`
- **症状**:
  ```ts
  for (const line of invalid) {
    const r = parsePublicKey(line);         // 再パース（すでに invalid 確定の行）
    console.log(
      yellow(`  スキップ (${r.ok ? "?" : r.error}): ...`),  // r.ok は常に false
    );
  }
  ```
  `invalid` 配列は `parseKeysText` が拒否した行のリストであるため `parsePublicKey` を再度呼ぶと常に `ok: false` になる。`r.ok ? "?" : r.error` の `"?"` 分岐は到達不能。
- **修正案**: 🤖 再パース不要。`invalid` のエラーを `parseKeysText` から返すか、または単純化して固定メッセージに変える:
  ```ts
  for (const line of invalid) {
    const r = parsePublicKey(line);
    console.log(yellow(`  スキップ (${r.ok ? "" : r.error}): ${line.slice(0, 60)}`));
  }
  ```
  あるいは `parseKeysText` の戻り値に `errors: string[]` を追加して再パースをなくす（設計変更判断が要る）。簡単な修正なら `r.ok ? "?" : r.error` → `r.ok ? "不明" : r.error` と死コードコメントを追加するだけでも 🟣 Doc レベルで済む。

---

### 🔵 L-B-4: "ファイルから追加" でコメントなし鍵のラベルを問わない

- **対象**: `cli/commands/keys.ts:230–236`（file ケース）
- **症状**: `confirmAndAdd(store, autoKey, keys, "")` — label が空文字固定。コメントがない鍵（コメント行のない .pub 等）は store に `label=""` `comment=""` で記録され、一覧表示で指紋のみ表示される。
- **比較**: "入力して追加" は comment なし時のみラベル入力を促す（line 195–202）。file 追加には同様のプロンプトがない非対称。
- **影響**: 機能欠落（UX の問題）。セキュリティ上の問題はなし。
- **修正案**: 🙋 ファイル中のコメントなし鍵が 1 件以上ある場合に追加のラベル入力プロンプトを出す。または ROADMAP に UX-3 として記録する。

---

### 🔵 L-B-5: rebuildAuthorizedKeys テストがファイルパーミッションを検証しない

- **対象**: `cli/lib/keys_test.ts:258–287`（"rebuildAuthorizedKeys: 自動鍵 + store の鍵で束を生成"）
- **症状**: bundle が生成されることは検証しているが、パーミッションが 0o600 であることを確認するアサーションがない。`writeFileAtomic` は 0o600 で書くが、回帰を防ぐテストとして追加すると保険になる。
- **修正案**: 🤖 テスト内に以下を追加:
  ```ts
  const st = Deno.statSync(authorizedKeysPath());
  if (Deno.build.os !== "windows") {
    assertEquals(st.mode! & 0o777, 0o600, "authorized_keys must be 0o600");
  }
  ```

---

### 🟣 D-B-1 🤖: saveKeyStore/rebuildAuthorizedKeys の順序についてコメントなし

- **対象**: `cli/commands/keys.ts:101–102` および `cli/commands/keys.ts:314–316`
- **症状**: `saveKeyStore(store)` → `rebuildAuthorizedKeys(store.keys)` の 2 行に、なぜその順序か・失敗時のリスクについてコメントがない。W-B-2 と同一箇所だが、コード変更ゼロで改善できる Doc 問題として独立して記録する。
- **修正案**: 🤖
  ```ts
  // store を先に保存し、失敗したら catch が再 load する。
  // bundle 書き込み失敗時は store/bundle が乖離するが、次回 list/setup で整合する。
  saveKeyStore(store);
  rebuildAuthorizedKeys(store.keys);
  ```

---

## 重要な設計の可視化

鍵追加（3 方式）→ store 更新 → 束再生成のデータフロー:

```
[ユーザー操作]
     │
     ├─ "paste" (keys.ts:188–205)
     │    Input.prompt + validatePublicKeyInput     keys.ts:189–191
     │    parsePublicKey(input)                     keys.ts:193
     │    comment なし → Input.prompt(label)        keys.ts:195–202
     │    confirmAndAdd(store, autoKey, [key], label)
     │
     ├─ "file" (keys.ts:209–238)
     │    Input.prompt(path) → expandHome → readTextFileSync
     │    parseKeysText(text)  ──→ keys[], invalid[] (keys.ts:222–229: 再パースは冗長)
     │    confirmAndAdd(store, autoKey, keys, "")   ← label 常に "" (L-B-4)
     │
     └─ "github" (keys.ts:241–282)
          Input.prompt(username) + validateGithubUsername
          fetchGithubKeys(username)    keys.ts:250
            └─ https://github.com/<user>.keys (HTTPS 強制)
               keys.ts:340–367  ← サイズ上限なし (L-B-1)
          confirmAndAdd(store, autoKey, result.keys, `github:${username}`)

                         confirmAndAdd (keys.ts:48–105)
                              │
                         isSameKey 重複チェック (autoKey / store)  keys.ts:56–64
                         RSA 弱鍵警告 (rsaBits < 2048)            keys.ts:76–82
                         Confirm.prompt (default: true)            keys.ts:85–89
                              │
                         store.keys.push(...)                      keys.ts:93–99
                         saveKeyStore(store)    ─── keys.json へアトミック書き込み
                              ↓ 失敗すると bundle 未更新のまま (W-B-2)
                         rebuildAuthorizedKeys(store.keys)
                              │
                              pubKeyPath() 読み取り (なければ throw)  keys.ts:276–285
                              buildAuthorizedKeysContent(autoKey, extra)  keys.ts:252–265
                                   ┌────────────────────────────────┐
                                   │ # Managed by cloopy ...        │
                                   │ <autoKeyLine>   ← 常に先頭     │
                                   │ <extra[0]>                     │
                                   │ ...                            │
                                   └────────────────────────────────┘
                              writeFileAtomic(authorizedKeysPath(), content)
                                   tmp(.tmp~) → rename  (0o600)
                                   ← inode 固定で稼働中コンテナへは未反映
                                   ← 反映は --force-recreate のみ
```

```
keys.json (store) ◄──── 真実の単一ソース
authorized_keys   ◄──── 毎回再生成（keys.json + autoKey）
CLOOPY_PUBKEY_PATH ────► authorized_keys への参照
                          旧 .env (id_ed25519.pub 直指し) は
                          setup 再実行 or 鍵変更時に自動移行
                          (setup.ts:146, manage.ts:380–382)
```

---

## 横断観点での所見

### 設計境界
- keys.ts / keys_test.ts: ライブラリ層（純粋関数 + store I/O）。commands/keys.ts: TUI 層。分離は明瞭。
- rebuildAuthorizedKeys は store I/O とファイル I/O を同時に担い、テスト時に `HOME` のモックが必要（withTempHome パターン）。この結合は現実的な選択だが、将来の 鍵分離（instanceName 追加）時には関数シグネチャの変更が必要（ROADMAP の「G: 鍵分離」と整合）。
- 鍵分離の設計上の障害: `authorizedKeysPath()`, `keyStorePath()`, `rebuildAuthorizedKeys()`, `manageKeys()` がすべて instanceName パラメーターを持たない。manage.ts で instanceName は取得可能（line 100）だが `manageKeys()` に渡していない。破壊的変更を伴うが、追加が難しいほどではない。

### リソース所有権
- keys.json と authorized_keys は `~/.ssh/cloopy/` 以下の同一ディレクトリ。store のアトミック性は writeFileAtomic で保証。同時実行ロックはない（CLI の性質上許容範囲）。
- 自動生成鍵（`id_ed25519.pub`）は `keys.json` に格納せず、setup 時に生成・以降は読み取り専用参照。不変条件（先頭・削除不可）は rebuildAuthorizedKeys と manageKeys の両経路で確認できた。store 直接操作のパスは存在しない。

### テスト網羅
- parsePublicKey 系: 9 ケース。type/blob照合・DSA拒否・options拒否・不正base64 をカバー。未カバー: truncated ssh-rsa blob（W-B-1 で指摘）・ecdsa-384/521・sk-* 型（フィクスチャなし）。
- store I/O: 往復・破損JSON・形式不正・rebuild・rebuild失敗の 4 ケース。未カバー: ファイルパーミッション（L-B-5）。
- fetchGithubKeys: 200/404/空200/500/不正ユーザー名の 5 ケース。未カバー: ネットワークエラー（L-B-2）。
- commands/keys.ts: テストなし（対話 TUI につき単体テスト困難。既存の他コマンドと同様の扱い）。

### ドキュメント整合
- CLAUDE.md の「鍵管理（複数鍵）」セクションとコードは整合している。束ファイルのアトミック書き込みと inode 固定の説明（`up --force-recreate` が必要な理由）はコードと一致。
- `cli/commands/keys.ts:101–102` に saveKeyStore → rebuildAuthorizedKeys の順序根拠コメントが欠落（🟣 D-B-1）。

### セキュリティ観点
- GitHub 取得: HTTPS 強制（URL ハードコード）、ユーザー名検証でパストラバーサル・URL インジェクション排除、レスポンスは parsePublicKey が各行を検証して非鍵行を拒否。問題なし。
- 秘密鍵誤入力: PEM フォーマット（`-----BEGIN`）は `KEY_TYPES` に含まれず拒否。`/etc/passwd` 等のファイル読み込みも非公開鍵行はすべて `invalid` 扱いで束に追加されない。
- 鍵コメント内のシェル特殊文字: authorized_keys と console 出力のみ。シェルインジェクションは発生しない。

---

## 件数まとめ
| 重大度 | 件数 | ID |
|---|---|---|
| 🟢 Safe | 2 | parsePublicKey 全般 / store I/O |
| 🔵 Low | 5 | L-B-1 〜 L-B-5 |
| 🟡 Warning | 2 | W-B-1, W-B-2 |
| 🔴 Error | 0 | — |
| 💣 Critical | 0 | — |
| 🟣 Doc | 1 | D-B-1 |
| 🤖 Auto-fixable | 2 | L-B-2, L-B-5（テスト追加）, D-B-1（コメント追加）|
| 🙋 Needs-decision | 2 | W-B-1（修正方針）, L-B-4（UX ラベル追加 or ROADMAP 送り）|
