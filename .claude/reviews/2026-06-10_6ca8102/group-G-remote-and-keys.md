---
group: G
topic: remote-access-and-key-management
files_reviewed: 11
date: 2026-06-10
model: opus
---

# Group G: リモート cloopy 接続 + SSH 鍵管理のフィージビリティ調査

> これはコードレビューではなく **機能設計の調査** です。「ファイル別分類テーブル」は
> 通常レビューと性格が異なるため **該当なし（フィージビリティ調査）** とします。
> 調査の過程で見つけた既存コードの不具合は末尾に `W-G-<n>` / `E-G-<n>` で記載します。

## 結論（先に）

ユーザー要望（「LAN 内の別 PC で動く cloopy への接続」+「公開鍵を直接 / ファイル /
`github.com/<user>.keys` から追加」）は **既存設計と非常に相性がよく、実現可能**。

決め手は CLAUDE.md にある **staged-copy 設計**：公開鍵は `CLOOPY_PUBKEY_PATH` →
`/etc/cloopy/authorized_keys`（`:ro,z`）にステージされ、`init-ssh-keys.sh:36` が
**毎起動 `install` で `authorized_keys` にコピー**する。コメント（`init-ssh-keys.sh:33-35`）
が明言する通り **ステージファイルの全行がコピーされるので複数鍵はそのまま動く**。
つまり「複数鍵を連結した 1 ファイルを生成し `CLOOPY_PUBKEY_PATH` に向ける」だけで
複数鍵対応は完成し、**Docker 側もスクリプト側も一切変更不要**。

リモート接続の方は「サーバ側で `manage.sh`、クライアント側は SSH config 注入のみ」
の役割分担が自然。ただし現状は **2 つのギャップ**があり、最小の手当てが必要：

1. `injectSshConfig` の `HostName` が **`localhost` ハードコード**（`ssh.ts:92`）→
   リモートを指せない。
2. `ports` の bind が **`"<port>:22"`**（`docker-compose.yml:9`）→ Docker のデフォルト
   で `0.0.0.0` に出るので **LAN 到達自体は可能**だが、bind アドレスを設定できないため
   「ローカルのみに絞る/特定 IF に絞る」という安全側の制御ができない。

推奨は **3 Phase 分割**（後述）。Phase 1（複数鍵ファイル + ペースト追加）は半日〜1日、
Phase 2（`.keys` 取得 + 鍵管理メニュー）は 1〜2 日、Phase 3（リモート接続プロファイル）
は 1〜2 日規模。Phase 1/2 はサーバ側で完結し SSH 接続性を壊すリスクが低い。

---

## 調査対象（11 ファイル）

- `cli/lib/ssh.ts` / `cli/commands/setup.ts` / `cli/commands/settings.ts`
- `cli/commands/manage.ts` / `cli/commands/doctor.ts` / `cli/lib/compose.ts`
- `cli/lib/env.ts` / `cli/lib/constants.ts` / `cli/lib/workspace.ts`
- `docker-compose.yml` / `docker/Dockerfile` / `docker/s6-overlay/scripts/init-ssh-keys.sh`
- 外部仕様: GitHub `.keys` / REST `GET /users/{user}/keys`（出典末尾）

---

## 1. 現状のギャップ分析（ファイル:行番号付き）

### (a) サーバ側 cloopy は LAN から到達可能か（bind アドレス）

`docker-compose.yml:8-9`

```yaml
ports:
  - "${CLOOPY_SSH_PORT:-10022}:22"
```

- bind アドレス未指定の short syntax は Docker のデフォルトで **`0.0.0.0`（全 IF）に
  publish** される。したがって **LAN の別 PC からは到達可能**（uCore サーバの LAN IP
  に `ssh -p 10022 developer@<server-lan-ip>` で届く）。要件 (a) は **追加実装なしで満たせる**。
- 一方で **bind を絞る手段が無い**。`127.0.0.1:10022:22` のように publish を localhost
  に限定したり、特定 NIC に絞ったりできない。**LAN 公開が前提ならこれでよいが、**
  「うっかり全 IF に出ている」ことを設定で制御できないのは安全性レビュー観点で弱い
  （→ §5・🙋-G-3）。
- rootless Docker / Podman ではデフォルト bind 挙動が異なる版があるので、bind を
  明示できるようにしておくと環境差の事故も防げる。

### (b) クライアントから見た SSH config の HostName はリモートを指せるか

`cli/lib/ssh.ts:81-98`（`injectSshConfig`）

```ts
const hostBlock = [
  `# --- ${instanceName} ---`,
  `Host ${instanceName}`,
  `    HostName localhost`,        // ← line 92: ハードコード
  `    Port ${port}`,
  `    User developer`,
  `    IdentityFile ${toSshPath(keyPath())}`,
  `    StrictHostKeyChecking accept-new`,
  `    UserKnownHostsFile ${toSshPath(knownHostsPath())}`,
].join("\n");
```

- **`HostName localhost` がハードコード**。これは「同一マシン上で docker を動かし、
  publish された localhost ポートに ssh する」ローカル前提。**リモートサーバを指せない**。
- `User developer` 固定。これは cloopy コンテナ内ユーザーなので問題ない（uCore の
  `core` ユーザーはホスト側であって、ssh の宛先はあくまでコンテナ内 `developer`）。
- `IdentityFile` は `~/.ssh/cloopy/id_ed25519`（`ssh.ts:17-19`）固定。クライアントが
  自前の鍵を使う場合の口がない（リモート接続プロファイルでは要考慮）。
- `refreshKnownHosts`（`ssh.ts:160-207`）も **`ssh-keyscan ... localhost` 固定**
  （`ssh.ts:168`）。リモートのホスト鍵は取れない。

→ リモート接続を成立させるには **HostName を可変化**するのが必須の最小変更点。

### (c) authorized_keys は単一の自動生成鍵のみ — 複数鍵の置き場所がない

`cli/commands/setup.ts:100`, `:110`

```ts
await ensureKeyPair();                                  // ~/.ssh/cloopy/id_ed25519(.pub) を生成
...
setEnvVar(envPath, "CLOOPY_PUBKEY_PATH", pubKeyPath(), true);  // .pub を直接 PUBKEY_PATH に
```

- `CLOOPY_PUBKEY_PATH` は **自動生成した単一の `.pub` を直接指す**。これが
  `docker-compose.yml:43` で `/etc/cloopy/authorized_keys:ro,z` にマウントされる。
- よって **追加鍵を入れる場所が構造的に無い**。手元 macOS の別鍵や、同僚の鍵、
  `github.com/<user>.keys` の鍵を足す導線がゼロ。要件のコア。
- ただし `init-ssh-keys.sh:33-37` が「ステージファイルの**全行**を install でコピー」
  なので、**`PUBKEY_PATH` を『複数行の連結ファイル』に向け替えるだけで複数鍵対応は完成**。
  Docker/スクリプト変更は不要（これが本調査の最大の発見）。

---

## 2. 複数鍵対応の設計（軸案）

### 案: CLI 管理の連結 authorized_keys を生成し `CLOOPY_PUBKEY_PATH` に向ける

**新規ファイル**: `~/.ssh/cloopy/authorized_keys`（仮称、以下「束ファイル」）

- 内容 = **自動生成鍵 `id_ed25519.pub`（必須・常に先頭）+ ユーザー追加鍵（0..n 行）**
  を連結したもの。CLI が唯一の生成主体（single source of truth）。
- `setup.ts:110` の `setEnvVar(..., "CLOOPY_PUBKEY_PATH", pubKeyPath(), ...)` を
  **束ファイルパスに変更**。`ssh.ts` に `authorizedKeysPath()`（`~/.ssh/cloopy/authorized_keys`）
  と「束ファイルを再生成する関数」`rebuildAuthorizedKeys(extraKeys: string[])` を追加する想定。
- 追加鍵の保管: 束ファイルを直接編集してもよいが、**「管理メタ（コメント/出所）を保持
  するため別 store（例: `~/.ssh/cloopy/keys.d/*.pub` or `keys.json`）を真実として持ち、
  束ファイルは毎回そこから再生成」**が一覧/削除 UI と相性がよい（§3）。

**既存 staged-copy 設計との噛み合わせ**: 完全に噛み合う。

- 束ファイルは `:ro,z` でステージ → `init-ssh-keys.sh:36` の `install` が全行コピー。
- **鍵の追加/削除はコンテナ再起動で反映**（CLAUDE.md の「コピーは毎起動」前提どおり）。
  CLI 側で「束ファイル更新 → `compose up`（`COMPOSE_UP_ARGS`）」を促せばよい。`settings`
  メニューの既存「変更を反映するためコンテナを再作成しますか？」フロー（`manage.ts:233-260`）
  をそのまま流用できる。
- SELinux: 束ファイルは依然 `~/.ssh/cloopy/` 配下の **単一ファイル**で、ディレクトリ
  全体をマウントするわけではないので `z` リラベル範囲は今と同じ（安全）。

**`.env` の auto-managed ブロックとの整合**: `CLOOPY_PUBKEY_PATH` は
`setup.ts:110` で `auto=true`（`env.ts:36`、BEGIN/END マーカー内）に書かれている。
束ファイルパスへ変更しても **同じ auto ブロックに入る**ので整合は取れる。

**後方互換（既存ユーザーの `.env` は古いパスを指す）**: ⚠️ 要注意。

- 既存ユーザーの `.env` は `CLOOPY_PUBKEY_PATH=~/.ssh/cloopy/id_ed25519.pub` のまま。
  束ファイル方式に切り替えると **このパスを再設定する必要**がある。
- `setEnvVar` は **既存キーがあればその場で上書き**（`env.ts:31-35`）。auto ブロック
  外に古い値があっても**値だけ書き換わる**（位置は維持）。つまり `setup` 再実行か、
  起動時に「PUBKEY_PATH が旧 `.pub` を指していたら束ファイルへ移行（旧 `.pub` は
  束に取り込む）」する **1 回限りのマイグレーションを doctor/setup に仕込めば透過的**。
- マイグレーション時は **冪等性**に注意（束ファイルに同じ自動鍵を二重追記しない）。

🙋-G-1: 束ファイルの「真実」をどこに置くか（束ファイル直接編集 vs `keys.d/` or
`keys.json` メタ store + 再生成）。後者は一覧/削除/出所表示に強いが実装量が増える。
推奨は **`keys.json`（指紋・コメント・出所・追加日時を保持）→ 束ファイルを毎回再生成**。

---

## 3. 鍵の追加 UI（settings メニュー想定）

`settings.ts` の `Select` メニュー（`settings.ts:72-85`）に「SSH 鍵管理」を 1 項目
追加し、サブメニューで以下を提供する想定。各方式の検証と考慮：

### (a) 公開鍵文字列を直接ペースト
- 入力検証: **OpenSSH 公開鍵フォーマット**を正規表現＋デコードで検証する。
  - 形式 `^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh.com|sk-ecdsa-sha2-nistp256@openssh.com)\s+[A-Za-z0-9+/]+={0,2}(\s+.*)?$`
  - 厳密にやるなら **base64 デコードして先頭の length-prefixed algorithm 名が
    プレフィックスと一致するか**を確認（型詐称・破損を弾く）。Deno なら `atob` +
    手書きパースで十分。外部コマンドに頼らず純 TS で実装できる。
  - **ed25519 / rsa を許容**（要件）。`ssh-dss`(DSA) は GitHub 同様 **拒否推奨**
    （2022-03-15 に GitHub も廃止。出典末尾）。短い RSA（<2048bit）は警告だけでも可。
- コメント欄が空ならユーザーにラベルを促す（一覧表示・削除時の識別子に使う、§後述）。

### (b) ファイルパス指定
- `~` 展開（`workspace.ts:44-48` と同じ手法）。読めなければ明示エラー。
- 中身を (a) と同じバリデータに通す。`.pub` に複数行が入っていても 1 行ずつ検証して
  全部取り込む（`authorized_keys` 連結なので自然）。

### (c) `https://github.com/<username>.keys` から取得
- **エンドポイント仕様（実測・出典末尾）**:
  - **認証不要・公開**。`Content-Type: text/plain`、**1 行 1 鍵**の OpenSSH 形式
    （base64、**コメント無し**＝末尾コメントが付かないので**ラベルは CLI 側で付与**：
    例 `github:<username>`）。
  - 鍵を持つ実在ユーザー → **HTTP 200 + 本文**（複数鍵なら複数行）。
  - **実在ユーザーで鍵 0 件 → HTTP 200 + 空本文**。
  - **存在しないユーザー → HTTP 404**（実測で確認。typo 緩和に効く）。
- **セキュリティ考慮**:
  - **HTTPS 強制**: `https://github.com/<user>.keys` のみ許可。`http://` や任意 URL は
    受け付けない（ユーザー名のみ入力させ、URL は CLI 側で組み立てる）。`<user>` は
    GitHub username 文法（`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`、連続ハイフン不可）で検証。
  - **404 → 即エラー表示**（「そのユーザーは存在しません」）。typo の主な事故をここで止める。
  - **200 空本文 → 「鍵が登録されていません」**として何も追加しない。
  - **取得鍵を必ず一覧表示 → ユーザーに確認させてから追加**（fingerprint も併記。
    `ssh-keygen -lf` 相当を純 TS か `ssh-keygen` 呼び出しで算出）。**自動追加しない**。
  - **typo で別の実在ユーザーの鍵を入れるリスク**（404 を回避してしまうケース）の緩和:
    取得した各鍵の **指紋とコメント（GitHub は付けないので algorithm/bits）を提示し、
    「この鍵を <username> として追加しますか？」と明示確認**。完全自動化は避ける。
  - 取得は cloopy のクライアント側（手元マシン）から行う前提。**コンテナ内 firewall は
    無関係**（CLAUDE.md の egress 制限はコンテナの話）。クライアント側ネットワークで
    GitHub に到達できることだけが前提。
  - **TOFU 的固定はしない**（GitHub の鍵は随時変わるので取得時点のスナップショット）。
    後で同じ username から再取得 → 差分提示する運用が親切（Phase 2.5 的）。

### 鍵の一覧表示・削除（コメントフィールドで識別）
- 一覧: 束ファイル/`keys.json` を読み、**`#`連番 + type + 指紋(SHA256) + ラベル/出所**を表示。
  自動生成鍵には **`[自動生成・削除不可]` マーク**を付け、削除対象から外す（消すと
  CLI 自身が接続不能になる＝接続性破壊。`E`/`🙋`相当の重要ガード）。
- 削除: `Select` で対象選択 → 確認 → store から除去 → 束ファイル再生成 → 反映確認。
- **指紋ベースの重複排除**（同じ鍵を二重登録させない）。

🙋-G-2: `.keys` 取得鍵に CLI 側でラベル（`github:<user>` + 取得日時）を付けるか、
それともコメント無しのまま入れるか。一覧/削除 UX のため **ラベル付与を推奨**
（ただしラベルは `authorized_keys` のコメント欄に書くと sshd は無視するので無害）。

---

## 4. リモート接続のクライアント体験

### サーバ側でしか CLI が動かない前提でよいか
- **基本は Yes**: docker/compose/鍵束生成はサーバ側で完結。クライアントに docker は不要。
- **ただしクライアント側にも価値あり**: クライアントの手元 macOS に「自分の鍵を
  サーバの cloopy に追加してもらう」導線（= 自分の `.pub` をサーバ管理者に渡す/
  自分で `.keys` 経由で入れてもらう）と、「リモート cloopy への SSH config 注入のみ
  （docker 不要）」モードがあると体験が完結する。

### クライアント側 `manage.sh` に「リモート接続設定」を足す価値
- **あり（Phase 3）**。`injectSshConfig` を **HostName 可変化**した上で、docker 抜きの
  軽量サブコマンド「リモート cloopy に接続設定だけ作る」を用意する案：
  - 入力: リモートホスト（IP/DNS）、ポート、（任意）使用する IdentityFile。
  - 出力: `~/.ssh/cloopy/config` に Host ブロック注入（`ssh.ts:81-152` を流用、
    HostName を入力値に）。
  - **docker チェックをスキップ**する必要がある。現状 `doctor.ts:20-39` の Docker
    チェックや `main.ts` の `doctor → setup → manage` フロー（CLAUDE.md 記載）が
    **ローカル docker 前提**なので、リモート専用パスは別エントリにするのが安全
    （`manage.ts` のメニューは getStatus=docker 前提：`manage.ts:48`）。

### known_hosts（リモートのホスト鍵）の扱い
- `refreshKnownHosts`（`ssh.ts:160-207`）は **`localhost` 固定**（`:168`）。リモート用は
  **`ssh-keyscan -p <port> <remote-host>`** に一般化が必要。
- ホスト鍵検証の信頼確立: リモートでは MITM リスクがあるので、**初回は指紋を表示して
  ユーザーに確認させる**のが理想。最低でも現状の `StrictHostKeyChecking accept-new`
  （`ssh.ts:96`）の TOFU を維持（LAN 内なら許容範囲）。
- **コンテナ再作成でホスト鍵が変わる問題**: cloopy は host key を `ssh-config` volume に
  永続化（`docker-compose.yml:48`, `init-ssh-keys.sh:54` の `ssh-keygen -A` は欠けた
  鍵のみ生成）するので、**reset（`down -v`）しない限りホスト鍵は安定**。reset 後は
  クライアントの known_hosts 更新が要る（リモートでは手動 or 再 keyscan）。

🙋-G-3 も参照（リモートは bind/firewall とセットで安全性を考える）。

---

## 5. セキュリティレビュー（SSH 側、LAN 公開時の追加リスク）

### sshd 設定の現状（`init-ssh-keys.sh:45-49`）
```
PasswordAuthentication no
PermitRootLogin no
PermitEmptyPasswords no
```
- **良好**: 公開鍵のみ・root 禁止・空パス禁止。LAN 公開の基本線は既に満たす。
- `PubkeyAuthentication` は明示されていないが **sshd デフォルトで yes** なので問題なし
  （明示しておくと意図が固まる、軽微）。
- 強化候補（比例的に推奨）: `KbdInteractiveAuthentication no` / `AuthenticationMethods publickey`
  を明示。**過剰ではない**（1〜2 行）。

### bind アドレスを設定可能にする案（推奨・低コスト）
- `docker-compose.yml:9` を `"${CLOOPY_SSH_BIND:-}${CLOOPY_SSH_PORT:-10022}:22"` 的に
  し、`CLOOPY_SSH_BIND`（例 `127.0.0.1:` / `0.0.0.0:` / `<lan-ip>:`）を `.env` で選べる
  ようにする。**デフォルトは現状維持（全 IF）**にすればローカル利用は無変更、LAN 公開を
  意識するユーザーは「localhost 限定」や「特定 IF 限定」を選べる。
- これにより「LAN に出すつもりがないのに出ている」事故を設定で防げる（§1(a) の弱点解消）。
- ⚠️ **接続性に直結**: デフォルトを `127.0.0.1:` に変えると **既存の LAN/別マシン利用が
  即座に壊れる**。デフォルトは**変えない**こと（後方互換）。

### fail2ban 級は過剰か
- **過剰**。公開鍵のみ（パスワード総当たり不可）なので brute-force のうまみが薄い。
  LAN 内前提なら不要。**比例性を欠く**ので非推奨。代わりに「LAN/信頼ネットワーク以外には
  publish しない（bind 制御）」+「非標準ポート（既定 10022）」+「公開鍵のみ」の組み合わせで十分。
- インターネット直結（uCore を WAN に晒す）は本プロジェクトの想定外。もし晒すなら
  WireGuard/Tailscale 等の VPN 越し、または SSH の前段に置く運用をドキュメントで推奨する
  程度（cloopy 本体に組み込むのは too much）。

### その他
- **firewall（egress）は SSH inbound と無関係**。`docker-compose.yml:54-58` の NET_ADMIN
  と `init-firewall` は外向き制御で、LAN からの inbound SSH を絞るものではない。LAN 公開の
  入口制御は **publish の bind と sshd 設定**が担う点を明確にすべき（ドキュメント）。

🙋-G-3: bind アドレスを `.env` で可変にするか（デフォルト全 IF 維持）。LAN 公開を
正式機能にするなら入れるべきだが、**デフォルト変更は接続性破壊なので不可**。

---

## 6. 段階導入案

| Phase | 内容 | 主な変更点 | 工数感 | 接続性リスク |
|---|---|---|---|---|
| **Phase 1** | 複数鍵ファイル対応 + ペースト/ファイル追加 | `ssh.ts` に束ファイル生成・`authorizedKeysPath()`、`setup.ts:110` の PUBKEY_PATH を束へ、旧パス→束の冪等マイグレーション、`settings.ts` に「鍵追加（ペースト/ファイル）」、OpenSSH 鍵バリデータ。Docker/スクリプト**変更なし** | 半日〜1日 | 低（自動鍵は常に束先頭・削除不可ガード） |
| **Phase 2** | `github.com/<user>.keys` 取得 + 鍵管理メニュー（一覧/削除/出所表示） | `keys.json` メタ store、`fetch` で `.keys` 取得（HTTPS 強制・404/空処理・確認 UI）、指紋表示、重複排除 | 1〜2日 | 低（サーバ側完結） |
| **Phase 3** | リモート接続プロファイル（クライアント体験） | `injectSshConfig` の HostName 可変化（`ssh.ts:92`）、`refreshKnownHosts` のホスト可変化（`ssh.ts:168`）、docker 非依存のリモート専用エントリ、（任意）bind 可変化 `CLOOPY_SSH_BIND` | 1〜2日 | 中（SSH config 既存ブロック更新・known_hosts。デフォルト挙動は不変に） |

> Phase 1/2 はサーバ側で閉じ、`HostName localhost` 前提を崩さないので**安全に先行導入可**。
> Phase 3 は HostName とエントリフローに触れるため、ローカル利用の回帰テスト
> （`ssh cloopy` 疎通・`doctor` の SSH Connect）を必ず通すこと。

---

## 既存コードの指摘（調査中に発見）

### 🟡 W-G-1 `cli/lib/ssh.ts:92` — `HostName localhost` ハードコード
リモート cloopy を指せない根本要因。Phase 3 の前提変更点。現状ローカル利用には害なし
だが、リモート要件の阻害要因として明記。

### 🟡 W-G-2 `cli/lib/ssh.ts:168` — `refreshKnownHosts` の host が `localhost` 固定
リモートのホスト鍵を取得できない。Phase 3 でホスト引数化が必要。

### 🟡 W-G-3 `docker-compose.yml:9` — SSH publish の bind アドレスが固定（実質 `0.0.0.0`）
LAN 公開は可能だが、bind を絞る手段がない。意図せぬ全 IF 公開を設定で防げない。
`CLOOPY_SSH_BIND` 導入を検討（**デフォルトは現状維持必須**＝後方互換／接続性）。

### 🔵 W-G-4 `docker/s6-overlay/scripts/init-ssh-keys.sh:45-49` — sshd hardening が最小
`PasswordAuthentication no` 等は入っているが、`AuthenticationMethods publickey` /
`KbdInteractiveAuthentication no` の明示があると LAN 公開時の意図が固まる（軽微・任意）。

### 🔵 W-G-5 `cli/commands/doctor.ts` 全体 / `cli/commands/manage.ts:48` — ローカル docker 前提
`doctor` の Docker チェック・`manage` の `getStatus`（compose ps）が docker 必須前提。
クライアント側「接続設定のみ」モードを足すなら、これらをスキップする別パスが要る
（Phase 3 の設計上の制約。現状は不具合ではない）。

> ※ いずれも **現時点のローカル利用では機能上の問題なし**。リモート/複数鍵を実装する
> 際の「前提変更が必要な箇所」を ID 化したもの。`E-G-<n>`（明確なバグ）に相当する
> ものは本調査範囲では検出されませんでした。

---

## 設計判断ポイント（🙋 / ROADMAP 材料）

- **🙋-G-1**: 複数鍵の真実をどこに持つか — 束ファイル直接編集 vs `keys.json` メタ store
  + 束再生成。後者推奨（一覧/削除/出所表示・指紋管理に強い）。
- **🙋-G-2**: `.keys` 取得鍵に CLI 側ラベル（`github:<user>`+日時）を付けるか。付与推奨
  （sshd はコメント無視で無害、UX 向上）。
- **🙋-G-3**: SSH publish の bind を `.env` 可変化するか。LAN 公開を正式機能化するなら
  入れる価値あり。ただし**デフォルトは全 IF 維持**（変えると既存利用が即破壊）。

---

## 出典（外部仕様の裏取り）

- GitHub `.keys` プレーンテキスト（`https://github.com/<user>.keys`）: 実測で 1 行 1 鍵の
  OpenSSH 形式・認証不要・存在しないユーザーは **HTTP 404**、鍵 0 件の実在ユーザーは
  200 空本文。
- REST「List public keys for a user」`GET /users/{username}/keys`（認証不要・"accessible
  by anyone"・verified public SSH keys を返す）:
  https://docs.github.com/en/rest/users/keys
- DSA(ssh-dss) は 2022-03-15 に GitHub で廃止（新規追加不可）:
  https://docs.github.com/en/rest/users/keys （およびキー種別の項）
