---
group: F
topic: テスト品質横断 + CI + ドキュメント整合
files_reviewed: 14
date: 2026-06-11
model: sonnet
---

# Group F: テスト品質横断 + CI + ドキュメント整合

## サマリ

- 前回レビュー（2026-06-10）の主要指摘（E-D-1: CI の CWD 問題、D-E-1〜4: ドキュメント乖離 5 件）は **すべて修正済み**。83 テストが CI（ubuntu-latest）で pass する状態を確認した。`compose_test.ts` の W-D-1（テスト名と検証内容の乖離）も修正済み（console.log のスパイが追加された）。
- 新規に `ssh_test.ts`（27 テスト）が追加されており、前回の最重要指摘「`injectSshConfig` のテストゼロ」が解消されている。`workspace_test.ts` にも「$HOME の親ディレクトリは拒否」テストが追加済み（W-D-2 解消）。
- 残存する問題は軽微。最大の懸念は `keys_test.ts` の条件付き assertion（型絞り込み後の `if (r.ok)` ブロック内アサーション）が TypeScript の型アサーションと重複している点（実用上は問題なし）と、`validatePublicKeyInput` / `RSA_MIN_BITS` / `ensureEnvFile` / `ensureKeyPair` / `scanRemoteHostKeys` のユニットテストが存在しない点。
- 重大度件数: 🟢 9 / 🔵 5 / 🟡 2 / 🔴 0 / 💣 0
- ドキュメント軸: 🟣 2
- タグ別: 🤖 2 / 🙋 3

## ファイル別分類

| 分類 | ファイル | 一言コメント |
|---|---|---|
| 🟢 Safe | `.github/workflows/ci.yml` | E-D-1 修正済み（working-directory: cli / deno test .）。83 passed 確認 |
| 🟢 Safe | `cli/lib/compose_test.ts` | W-D-1 修正済み。console.log スパイで quiet 動作を適切に検証 |
| 🟢 Safe | `cli/lib/env_test.ts` | 13 テスト pass。BEGIN-only / CRLF 保持 / 空ファイル等を網羅 |
| 🟢 Safe | `cli/lib/keys_test.ts` | 20 テスト pass。parsePublicKey / store / rebuildAuthorizedKeys を網羅 |
| 🟢 Safe | `cli/lib/remote_test.ts` | 11 テスト pass。store / validators / parseKeyscanOutput を網羅 |
| 🟢 Safe | `cli/lib/ssh_test.ts` | 27 テスト pass。injectSshConfig / upsertHostBlock / known_hosts 管理を網羅 |
| 🟢 Safe | `cli/lib/workspace_test.ts` | 8 テスト pass（親ディレクトリ拒否・symlink 拒否 追加済み） |
| 🟢 Safe | `README.md` | 前回指摘 D-E-2〜3・W-E-1 修正済み（init-firewall 追記・ssh-config 追加・--build 追記） |
| 🟢 Safe | `CLAUDE.md` | 前回指摘 D-E-1 修正済み（Volta 削除）。SSH 鍵管理・リモート接続・known_hosts 管理・SSH_BIND セクション追加 |
| 🟣 Doc 🔵 Low | `.env.example` + `README.md` | D-E-4 修正済み（OpenDNS IPv6 追記）。CLOOPY_SSH_BIND セクション追加。ただし CLOOPY_USER_UID/GID が example に無いことの説明が不足（後述 L-F-1） |
| 🟡 Warning | `cli/lib/keys_test.ts:52-57,63,69` | 型絞り込み後の `if (r.ok)` ブロック内アサーションが型チェック済みで redundant な guard（後述 W-F-1） |
| 🟡 Warning | `cli/lib/keys_test.ts:全体` + `cli/lib/env_test.ts:全体` | `validatePublicKeyInput` / `RSA_MIN_BITS` / `ensureEnvFile` のテストゼロ（後述 W-F-2） |
| 🔵 Low | `cli/lib/ssh_test.ts:全体` | `ensureKeyPair` / `refreshKnownHosts` のテストゼロ（外部コマンド依存・許容範囲、後述 L-F-2） |
| 🔵 Low | `cli/lib/remote_test.ts:62,76,107` | `remoteStorePath().replace(/\/remotes\.json$/, "")` で dirname を計算。パス区切りが `/` 固定で Windows では壊れる形（後述 L-F-3） |
| 🔵 Low | `cli/lib/keys_test.ts:全体` | `sk-ssh-ed25519@openssh.com` / `sk-ecdsa-sha2-nistp256@openssh.com` 鍵種別のパーステストがゼロ（後述 L-F-4） |
| 🔵 Low | `cli/lib/ssh_test.ts:全体` | `@revoked` 行の保全テストがない（`@cert-authority` のみ。後述 L-F-5） |
| 🔵 Low | `cli/lib/remote_test.ts:全体` | `scanRemoteHostKeys` が未テスト（外部コマンド依存・許容範囲、後述 L-F-2 と同じ分類） |

## カバレッジ対照表（エクスポート関数 × テスト有無）

### ssh.ts

| 関数/定数 | テスト有無 | 備考 |
|---|---|---|
| `sshDir` / `keyPath` / `pubKeyPath` / `sshConfigPath` / `defaultKnownHostsPath` / `mainSshConfigPath` | 間接（injectSshConfig 経由） | パス関数。テスト単独不要 |
| `ensureKeyPair` | **ゼロ** | `ssh-keygen` 外部コマンド依存 |
| `writeFileAtomic` | 間接（injectSshConfig・upsertKnownHosts 経由） | tmp 残骸チェックで実質的に検証済み |
| `upsertHostBlock` | 6 テスト ✅ | |
| `removeHostBlock` | 4 テスト ✅ | |
| `ensureIncludeLine` | 2 テスト ✅ | |
| `buildHostBlock` | 3 テスト ✅ | |
| `injectSshConfig` | 3 統合テスト ✅ | |
| `hasHostBlock` | 2 テスト ✅ | |
| `readCloopyConfig` | 間接（injectSshConfig 経由） | |
| `removeSshConfigEntry` | 1 テスト（CRLF テスト内） ✅ | |
| `knownHostsMarker` | 間接（upsertKnownHosts 経由） | |
| `knownHostsToken` | 1 テスト ✅ | |
| `filterKnownHostsContent` | 4 テスト ✅ | |
| `upsertKnownHosts` | 2 統合テスト ✅ | |
| `removeKnownHostsEntry` | 1 テスト（upsertKnownHosts テスト内） ✅ | |
| `parseKeyscanOutput` | 2 テスト（remote_test.ts） ✅ | |
| `refreshKnownHosts` | **ゼロ** | `ssh-keyscan` 外部コマンド依存 |

### keys.ts

| 関数/定数 | テスト有無 | 備考 |
|---|---|---|
| `authorizedKeysPath` / `keyStorePath` | 間接 | パス関数 |
| `RSA_MIN_BITS` | **ゼロ** | 定数の参照テストなし（警告閾値の回帰防止として意味あり） |
| `parsePublicKey` | 8 テスト ✅ | |
| `validatePublicKeyInput` | **ゼロ** | `parsePublicKey` のラッパー。薄いが未テスト |
| `isSameKey` | 1 テスト ✅ | |
| `fingerprintSha256` | 1 テスト ✅（実鍵フィクスチャとの照合） |
| `loadKeyStore` / `saveKeyStore` | 2 テスト ✅ | |
| `buildAuthorizedKeysContent` | 2 テスト ✅ | |
| `rebuildAuthorizedKeys` | 2 テスト ✅ | |
| `validateGithubUsername` | 1 テスト ✅ | |
| `parseKeysText` | 1 テスト ✅ | |
| `fetchGithubKeys` | 1 テスト（4 ケース） ✅ | |
| sk-* 鍵種別 | **ゼロ** | `KEY_TYPES` に定義があるがパーステストなし |

### remote.ts

| 関数/定数 | テスト有無 | 備考 |
|---|---|---|
| `remoteStorePath` | 間接（store テスト経由） | |
| `loadRemoteStore` / `saveRemoteStore` | 3 テスト ✅ | |
| `validateRemoteName` / `validateRemoteHost` / `validateRemotePort` | 各 2 テスト ✅ | |
| `scanRemoteHostKeys` | **ゼロ** | `ssh-keyscan` 外部コマンド依存 |

### env.ts

| 関数/定数 | テスト有無 | 備考 |
|---|---|---|
| `setEnvVar` | 8 テスト ✅ | |
| `ensureEnvFile` | **ゼロ** | `.env.example` 不在のエラーパスも未テスト |
| `readEnvFile` | 5 テスト ✅ | |

### compose.ts

| 関数/定数 | テスト有無 | 備考 |
|---|---|---|
| `getProjectRoot` | **ゼロ** | `import.meta.url` 依存 |
| `getComposeFiles` | 4 テスト ✅ | |
| `compose` / `composeSpawn` / `getContainerId` / `checkBootstrapStatus` / `getStatus` | **ゼロ** | Docker 依存、統合テスト不可（許容） |

### workspace.ts

| 関数/定数 | テスト有無 | 備考 |
|---|---|---|
| `validateWorkspacePath` | 8 テスト ✅ | |

## 詳細指摘

### 🟡 W-F-1: `keys_test.ts` の型絞り込み後 `if (r.ok)` ブロックが guard として冗長

- **対象**: `cli/lib/keys_test.ts:52-57, 63, 69`
- **症状**: `assertEquals(r.ok, true)` の直後に `if (r.ok) { assertEquals(...) }` が続く。`assertEquals` が通れば `r.ok === true` が保証されているため、`if` ガードは TypeScript のナローイング目的だが assertion が失敗すれば `throw` されるので実際にはデッドコードではない。ただしテスト名が示す「検証したいこと」（例: `r.key.comment === "alice@example"`）が `if` に隠れており、`ok === false` のバグを見逃す形になっていない。
- **具体的なパターン**:
  ```typescript
  // cli/lib/keys_test.ts:51-57
  const r = parsePublicKey(ED25519_A);
  assertEquals(r.ok, true);   // ← 失敗すれば throw
  if (r.ok) {                  // ← TypeScript ナローイングのみが目的
    assertEquals(r.key.type, "ssh-ed25519");
    ...
  }
  ```
- **根本原因**: TypeScript の型システムが `assertEquals(r.ok, true)` の実行後に `r` を `{ok: true; key: ParsedKey}` に絞り込まないため、`.key` へのアクセスに `if` が必要。
- **修正案** 🙋:
  - 案 A（TypeScript 4.9+ の型アサーション）: `assert(r.ok, "parse failed")` を `@std/assert` から使う。ナローイングが効き `if` ガード不要になる。
  - 案 B: 現状のまま。実用上の問題はなく、可読性も許容範囲。
- **テスト**: 不要（テスト自体の修正）。

---

### 🟡 W-F-2: `validatePublicKeyInput` / `RSA_MIN_BITS` / `ensureEnvFile` が未テスト

- **対象**: `cli/lib/keys.ts:172-175`, `cli/lib/keys.ts:69`, `cli/lib/env.ts:56-76`
- **症状**:
  - `validatePublicKeyInput`（keys.ts:172）は `parsePublicKey` のラッパーで `true | string` を返す。Cliffy の prompt validator として直接使われる重要なインターフェイスだがテストゼロ。
  - `RSA_MIN_BITS`（keys.ts:69）は警告閾値の定数だが、実際に「1024 bit RSA は警告される」というユニットテストがない（`cli/commands/keys.ts` の UI ロジック内で参照）。
  - `ensureEnvFile`（env.ts:56）は `.env.example` が存在しない場合に `Deno.exit(1)` する唯一のパスを持つが未テスト。
- **修正案** 🙋:
  - `validatePublicKeyInput`: `parsePublicKey` との対称性をテスト。例: `assertEquals(validatePublicKeyInput(ED25519_A), true)` と `assertEquals(typeof validatePublicKeyInput(""), "string")`。
  - `RSA_MIN_BITS`: `RSA1024` のフィクスチャ（keys_test.ts:31）と組み合わせて「1024 < RSA_MIN_BITS」を assertion する 1 行テストを追加。
  - `ensureEnvFile`: `.env.example` が存在しない tmp dir で呼んで `Deno.exit` が呼ばれることを確認するのは難しい。コメントで「`Deno.exit(1)` パスは統合テスト対象外」と明記する方が現実的（🤖）。
- **テスト**: 上記が追加候補テストケース。

---

### 🔵 L-F-1 🙋: `.env.example` の auto-managed 変数（`CLOOPY_PUBKEY_PATH` / `USER_UID` / `USER_GID`）が example に未掲載で説明も不足

- **対象**: `.env.example:1-3`, `docker-compose.yml:16-17, 48`
- **症状**: `docker-compose.yml` が参照する `CLOOPY_USER_UID`・`CLOOPY_USER_GID`・`CLOOPY_PUBKEY_PATH` は `.env.example` のユーザー編集セクションに記載なし。これらは `setup` が自動で `# BEGIN/END cloopy auto-managed` ブロックに書き込む変数だが、その旨が `.env.example` のコメントに明記されていない。
- **根本原因**: 設計上は「auto-managed ブロックに setup が書くもの = ユーザーが手編集しないもの」なので example から除外するのは正しい。しかし「BEGIN/END ブロックには何が入るか」の説明が `.env.example` にない。
- **修正案** 🤖: `.env.example:7`（`# Edit the values below...` の行）の次に以下を追記:
  ```
  # The auto-managed block above is written by `./manage.sh` setup
  # (CLOOPY_PUBKEY_PATH, CLOOPY_USER_UID, CLOOPY_USER_GID). Do not edit it.
  ```
- **テスト**: 不要。

---

### 🔵 L-F-2: `ensureKeyPair` / `refreshKnownHosts` / `scanRemoteHostKeys` が未テスト

- **対象**: `cli/lib/ssh.ts:58-117, 529-578`, `cli/lib/remote.ts:146-173`
- **症状**: 3 関数はすべて `ssh-keygen` または `ssh-keyscan` を `Deno.Command` で呼ぶため、サンドボックス CI では統合テスト不可。
- **影響**: `ensureKeyPair` の「秘密鍵あり公開鍵なし → 再生成」パスは純粋ではないが、外部コマンドへの依存が深い。
- **修正案**: 現状を許容。将来的には `Deno.Command` をコールバックで差し替えられる設計にすることで unit test 化が可能だが、優先度は低い。主担当 Group A/B の可能性あり。

---

### 🔵 L-F-3 🤖: `remote_test.ts` の `remoteStorePath().replace(/\/remotes\.json$/, "")` が Windows 不安全

- **対象**: `cli/lib/remote_test.ts:62, 76, 107`
- **症状**: `remoteStorePath()` が返すパスから `dirname` を取るために `/remotes.json` を文字列置換している。Windows では `remoteStorePath()` が `\remotes.json` を含む可能性がある（`resolve` が `\` を返す）が、正規表現が `/` 固定のためマッチせず `mkdirSync` が誤ったパスを作る。
- **根本原因**: `remoteStorePath().replace(/\/remotes\.json$/, "")` は `sshDir()` と同等だが、`sshDir()` を直接使っていない。
- **修正案** 🤖: `remoteStorePath().replace(...)` → `sshDir()` に差し替える（`sshDir` は `import` 済み）:
  ```typescript
  // before
  Deno.mkdirSync(remoteStorePath().replace(/\/remotes\.json$/, ""), { recursive: true });
  // after
  import { sshDir } from "./ssh.ts"; // すでにある場合は省略
  Deno.mkdirSync(sshDir(), { recursive: true });
  ```
  ただし `isWindows` ignore フラグが付いているため CI 上の実害はない。
- **テスト**: 不要（Windows CI を追加する場合に顕在化）。

---

### 🔵 L-F-4: `sk-*` 鍵種別のパーステストがゼロ

- **対象**: `cli/lib/keys.ts:64-66`, `cli/lib/keys_test.ts:全体`
- **症状**: `KEY_TYPES` には `sk-ssh-ed25519@openssh.com` と `sk-ecdsa-sha2-nistp256@openssh.com` が定義されているが、`keys_test.ts` には `ecdsa-sha2-nistp256` 以外の `ecdsa` / `sk-*` 鍵のパーステストがない。
- **影響**: FIDO2/U2F ハードウェアキー利用者が鍵を登録する際に解析エラーが発生してもテストで検知できない。
- **修正案** 🙋: `sk-ssh-ed25519@openssh.com` フィクスチャ（本物の鍵データ 1 行）を追加して `parsePublicKey(SK_ED25519).ok === true` を確認するテストを 1 件追加。フィクスチャは README の「公開鍵フィクスチャ出所コメント」規約（L21）に従い `ssh-keygen -t ed25519-sk` で生成してコメントに記載する。

---

### 🔵 L-F-5: `filterKnownHostsContent` に `@revoked` 行の保全テストがない

- **対象**: `cli/lib/ssh_test.ts:325-388`, `cli/lib/ssh.ts:398`
- **症状**: `transformKnownHostsLine` は `line.startsWith("@")` で `@cert-authority` と `@revoked` を一律スキップするが、テストフィクスチャには `@cert-authority` のみが含まれ、`@revoked` のケースがない。
- **影響**: `@revoked` 行を誤って削除するリグレッションを検知できない。ただし実装は 1 行の条件で共通処理しており破損リスクは低い。
- **修正案**: 既存テストの `content` 配列に `@revoked [localhost]:10022 ${KH_KEY}` 行を追加し、出力に含まれることを `assertStringIncludes` で確認（🤖 に近いが微修正）。

---

### 🟣 D-F-1 🤖: `.env.example` の auto-managed ブロック説明不足（ドキュメント軸）

- L-F-1 と同一。auto-managed ブロックに setup が書く変数（`CLOOPY_PUBKEY_PATH` / `CLOOPY_USER_UID` / `CLOOPY_USER_GID`）の説明コメントを追加する。

---

### 🟣 D-F-2: `cli/lib/keys_test.ts` のフィクスチャ出所コメントが部分的

- **対象**: `cli/lib/keys_test.ts:22-33`
- **症状**: コメント「実鍵フィクスチャ（ssh-keygen で生成、指紋は ssh-keygen -lf の出力）」は ED25519_A についての説明だが、`RSA2048`・`RSA1024`・`ECDSA256`・`ED25519_B` の出所コメントがない。また、KH_HASHED_LOCALHOST と KH_HASHED_OTHER（ssh_test.ts:315-318）には「`ssh-keygen -H` が実際に生成したハッシュ行（HMAC-SHA1 照合の実フィクスチャ）」とコメントがあり整合が取れていない。
- **修正案** 🤖: `keys_test.ts:22-33` のコメントを以下のように拡充する:
  ```typescript
  // 実鍵フィクスチャ（ssh-keygen で生成。各鍵の指紋は `ssh-keygen -lf` で検証済み）
  // ED25519_A_FP は SHA256 指紋の実値（fingerprintSha256 テストの期待値として使用）
  // RSA2048 / RSA1024 / ECDSA256 は rsaBits 検出と型拒否テスト用フィクスチャ
  ```

---

## 重要な設計の可視化

テストカバレッジ全体のヒートマップ（横断スキャン中心のため簡易図）:

```
lib/         テスト状況         主要な空白
──────────   ─────────────────  ─────────────────────────────────────
ssh.ts       ████████████░░     ensureKeyPair・refreshKnownHosts (外部 cmd 依存)
keys.ts      ████████████░      validatePublicKeyInput・RSA_MIN_BITS・sk-* 鍵種別
remote.ts    ████████░░░░       scanRemoteHostKeys (外部 cmd 依存)
env.ts       ██████████░        ensureEnvFile (Deno.exit パス)
compose.ts   ████░░░░░░░        compose・getStatus 等 Docker 依存関数群
workspace.ts █████████████      全ケース網羅
```

凡例: `█` = テスト済み  `░` = テストなし（外部依存または軽微）

---

## 退行確認（前回 2026-06-10 指摘との対照）

| 前回 ID | 内容 | 本回状態 |
|---|---|---|
| E-D-1 | CI `deno test cli/` ルート実行 TS2307 エラー | ✅ 修正済み（working-directory: cli + deno test .） |
| W-D-1 | `quiet=true suppresses log` テスト名と実体の乖離 | ✅ 修正済み（console.log スパイ追加） |
| W-D-2 | `validateWorkspacePath` の $HOME 親ディレクトリ未テスト | ✅ 修正済み（workspace_test.ts:59-64 追加） |
| W-D-3 | `injectSshConfig` テストゼロ（最重要カバレッジ穴） | ✅ 修正済み（ssh_test.ts 27 テスト追加） |
| W-D-4 | `setEnvVar` BEGIN あり END なし エッジケース未テスト | ✅ 修正済み（env_test.ts:157-172 追加） |
| L-D-1 | dependabot が JSR パッケージを追跡しない | 現状維持（dependabot 非対応のため変更不可） |
| L-D-2 | CI `paths` に存在しない `deno.json` | ✅ 修正済み（paths から `deno.json` 削除） |
| L-D-3 | firewall-dns.sh fallback コンテナの `--add-host` 省略理由未コメント | 未修正（対象ファイルの変更なし） |
| D-E-1 | CLAUDE.md `svc-bootstrap` に Volta 残存 | ✅ 修正済み（Nix/Devbox に変更） |
| W-E-1 | README `docker compose up -d` に `--build` なし | ✅ 修正済み（--build 追記） |
| D-E-2 | README Architecture 図に `init-firewall` 欠落 | ✅ 修正済み（図に追加） |
| D-E-3 | README リセットコマンドで `ssh-config` ボリューム欠落 | ✅ 修正済み（volume rm に追加） |
| D-E-4 | `.env.example` OpenDNS IPv6 未掲載 | ✅ 修正済み（IPv6 追記） |

## 横断観点での所見

### テスト網羅

前回レビューから今回までの間に `ssh_test.ts`（27 テスト）が全面追加され、最重要だったカバレッジ穴が解消された。83 テストが CI ubuntu-latest で pass している。残る空白（`ensureKeyPair` / `refreshKnownHosts` / `scanRemoteHostKeys`）はすべて `Deno.Command` 外部呼び出しを含む関数で、サンドボックス CI では統合テスト不可の範疇。

### CI 構成

- `working-directory: cli` + `deno test .` で CWD 問題が解消。`deno.json` コメント（L30）が修正の背景を説明しており、メンテナー向け情報として適切。
- `paths` フィルタから `deno.json`（ルート不在）が削除され、L-D-2 も解消。
- deno バージョンは `v2.x` で固定（マイナー/パッチは浮動）。JSR パッケージのバージョン固定は `deno.json` 側で管理。

### フィクスチャ管理

- `keys_test.ts` の実鍵フィクスチャはコメント付きで出所が明確（ED25519_A のみ）。RSA / ECDSA は出所コメントが薄い（D-F-2）。
- `ssh_test.ts` の `KH_HASHED_LOCALHOST` / `KH_HASHED_OTHER` は「`ssh-keygen -H` で実際に生成」とコメントがあり適切。
- `withTempHome` パターンが `keys_test.ts` / `remote_test.ts` / `ssh_test.ts` で一貫して使われており、`HOME` の書き換えと後始末が適切に `finally` ブロックで保証されている。テスト間干渉なし。

### ドキュメント整合

- CLAUDE.md・README・.env.example の主要乖離は前回レビューで解消済み。新規追加のセクション（SSH 鍵管理・リモート接続・known_hosts・SSH_BIND）は実装と整合している。
- `.env.example` の auto-managed ブロックの説明が薄い点（L-F-1）が唯一の残課題。
