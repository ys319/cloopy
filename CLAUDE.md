# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project Overview

cloopy は Claude Code 専用のバッテリー付属 Docker
コンテナ開発環境。セットアップ一発で VS Code Remote SSH から Claude
と開発を始められる。

> **注意**: `assets/CLAUDE.md` はコンテナ内で Claude
> に渡される別ファイル（日本語応答・Devbox
> 使用の指示）。このファイルとは役割が異なる。

## Commands

```bash
./manage.sh    # macOS/Linux
manage.bat     # Windows
```

対話メニューからセットアップ・起動・停止・SSH接続・リビルド・リセット等すべて操作可能。

## Architecture

### CLI（Deno + Cliffy）

`manage.sh` / `manage.bat` → Deno
をプロジェクトローカル（`.deno/`）に自動インストール → `cli/main.ts` を実行。

引数なしの場合 `doctor()` → `setup()` → `manage()` の順に実行される。`doctor`
が問題なしと判定すれば `setup` はスキップ。

`cli/lib/compose.ts` は `docker-compose.local.yml` が存在すれば自動で `-f`
オプションに追加する。

### Docker コンテナ（Ubuntu 24.04 + s6-overlay）

s6-overlay が PID 1 として動作し、以下のサービスツリーで初期化する：

```
s6-overlay (PID 1)
├── init-permissions    (oneshot) UID/GID 調整、ボリューム chown（ホスト bind は除外）
├── init-ssh-keys       (oneshot, depends: init-permissions) authorized_keys 配置・検証、sshd 設定
├── init-workspace-check(oneshot, depends: init-permissions) ワークスペース UID 不一致警告
├── init-firewall       (oneshot, depends: init-permissions) egress ローカル遮断
├── svc-bootstrap       (oneshot, depends: init-permissions) Nix/Devbox
└── svc-sshd            (longrun, depends: init-ssh-keys) SSH デーモン
```

sshd と bootstrap は並列実行。SSH は bootstrap 完了前に接続可能。

#### SELinux ホスト対応（Fedora CoreOS / uCore 等）

SELinux enforcing なホスト（Fedora 系の dockerd は `--selinux-enabled` がデフォルト）
ではホストからの bind mount に `z` フラグが必須。なしだと `container_t` がホスト
ラベル（`user_home_t` / `ssh_home_t`）を stat すらできず、authorized_keys が
「empty or missing」扱いで起動失敗する。SELinux のないホスト（macOS/Windows/
Ubuntu）では `z` は公式に no-op なので compose は 1 枚で全プラットフォーム対応。

公開鍵は `~/.ssh/authorized_keys` へ直接マウントせず `/etc/cloopy/authorized_keys`
に `:ro,z` でステージし、`init-ssh-keys` が `install -m 600 -o PUID` でコンテナ内
（home ボリューム）へコピーする。bind mount を直接 chown/chmod するとホストの
実ファイルを書き換えてしまう（rootless では subuid に chown されて以後ホストから
読めなくなる）ため。同じ理由で `init-permissions` の再帰 chown も
`/proc/self/mountinfo` を読んでホスト bind mount（workspace・.zshenv・
docker-compose.local.yml の追加 bind 等）を除外する。named volume
（mountinfo の root が `…/volumes/<名前>/_data`）は従来どおり chown 対象 —
workspace-data ボリューム構成で PUID≠1000 でも書き込めるようにするため。
コンテナ内で authorized_keys を直接編集しても次回起動で上書きされる点に注意。

#### SSH 鍵管理（複数鍵）

`CLOOPY_PUBKEY_PATH` は CLI 管理の束ファイル `~/.ssh/cloopy/authorized_keys`
（自動生成鍵 + 追加鍵）を指す。鍵の真実は `~/.ssh/cloopy/keys.json`（メタ情報
store、`cli/lib/keys.ts`）で、束ファイルは setup と「SSH 鍵管理」メニュー
（`cli/commands/keys.ts`）が毎回そこから再生成する。追加方法は貼り付け／
ファイル／GitHub `.keys` 取得（HTTPS 強制・ユーザー名検証・指紋確認後に追加）。
自動生成鍵は常に束の先頭で削除不可（CLI 自身の接続性の生命線）。

鍵変更の反映は **`up --force-recreate`**（鍵管理メニューが案内する）。束ファイル
はアトミック書き込み（tmp→rename）なので、単一ファイル bind mount の inode が
旧ファイルに固定されたままになり、稼働中コンテナへの `compose up`（構成変更
なし＝no-op）では反映されないため。旧 `.env`（`id_ed25519.pub` 直指し）は
再 setup または鍵管理メニューの変更時に束ファイルパスへ自動移行される。

運用上の注意:

- **CLI の `up` は常に `--build` 付き**（`COMPOSE_UP_ARGS`）。compose 設定と
  イメージ内の s6 スクリプトはセットで変わるため、`git pull` 後に旧イメージで
  再作成されると起動不能になる。`--build` はキャッシュが効くので通常数秒。
- **ワークスペースに `$HOME` 等を指定させない**。`z` はマウント元ツリー全体を
  container_file_t に再帰リラベルするため、`$HOME` を指すと `~/.ssh` が
  ssh_home_t を失い**ホストへの SSH ログインが壊れる**（headless サーバでは
  ロックアウト）。CLI のワークスペース入力は `cli/lib/workspace.ts` の
  `validateWorkspacePath` で `$HOME`・`~/.ssh`・システムディレクトリを拒否する。
- SELinux ホストでは巨大ワークスペースの初回起動時にリラベル走査で数分かかる
  ことがある（2 回目以降は高速）。ハングではない。
- `docker-compose.local.yml` で bind mount を追加する場合も SELinux フラグを
  忘れないこと（単一インスタンス専用なら `:Z`、共有なら `:z`）。
- 短縮構文の `z` フラグは compose v2.16 頃からのサポート。それ以前の古い
  compose では volume 定義のパースに失敗する。

#### リモート接続プロファイル（G Phase 3）

別マシンの cloopy へ繋ぐクライアント側機能。真実は `~/.ssh/cloopy/remotes.json`
（`cli/lib/remote.ts`、keys.json と同じ「メタ store + 再生成」パターン）で、
メインメニュー「リモート接続」（`cli/commands/remote.ts`）が SSH config の
Host ブロックを `injectSshConfig`（HostName/IdentityFile 可変化済み）で
注入する。docker 非依存 — docker が見つからないマシンでは main.ts が
リモート接続専用モードを案内する。

- **ホスト鍵は標準 `~/.ssh/known_hosts` に固定**（下記「ホスト鍵管理」参照）。
- 登録時に `ssh-keyscan` でホスト鍵を取得し **SHA256 指紋をユーザー確認**して
  から固定（MITM 対策）。取得失敗時は TOFU（accept-new）での登録も選べるが、
  その場合は旧固定鍵を削除する（接続先変更後の mismatch 防止）。
- エントリ名はローカルインスタンスと SSH Host 名前空間を共有する。store に
  無いのに config にブロックがある名前は**ローカルインスタンス用として拒否**
  （上書きすると `ssh <インスタンス名>` がリモートを向く）。

#### ホスト鍵管理（標準 known_hosts・Claude アプリ互換）

ホスト鍵はローカル・リモートとも**標準 `~/.ssh/known_hosts`** に固定する。
Claude Desktop の SSH 機能は ssh2 ベースの独自実装で、`~/.ssh/config` の
`UserKnownHostsFile` / `StrictHostKeyChecking` を解釈せず標準 known_hosts
しか参照しない（未知ホストの対話受け入れ UI も無い）ため、専用ファイルへ
分離すると ssh CLI では繋がるのにアプリからは繋がらない。旧方式
（`known_hosts.d/<名前>` + `~/.ssh/cloopy/known_hosts` 丸ごと上書き）は
この理由で廃止（2026-06-11。残骸ファイルは無害なので移行処理なし）。

- cloopy が書く行は**行末コメント `cloopy:<名前>`** で自己識別する
  （known_hosts のコメントフィールドは標準フォーマットの一部で ssh は無視
  する。独立した `#` マーカー行で挟む方式と違い、手編集やソートで壊れない）。
- 反映は `upsertKnownHosts`（`cli/lib/ssh.ts`）のアップサート: マーカー一致
  （そのエントリ自身の旧 pin — ホスト変更後も追える）と `[host]:port` token
  一致（ユーザー手動・accept-new の自動追記・Ubuntu 既定 HashKnownHosts の
  ハッシュ行も HMAC-SHA1 照合で検出）の行を除去してから追記する。リセットで
  ホスト鍵が変わっても key-changed にならない。`#` コメント・空行・
  `@cert-authority`/`@revoked`・ワイルドカード行には触れない。カンマ区切りで
  複数別名が並ぶ行は一致した別名だけ落とす（他別名の pin を巻き込まない）。
  エントリ削除はマーカー行のみ消す（同ホストへのユーザー自身の行は残す）。
- keyscan は **`-H`（ハッシュ化）を使わない**。アプリの独自パーサがハッシュ
  行を読める保証が無く、ホスト名は remotes.json と SSH config に平文で載る
  ので隠す意味も無い。なお `ssh-keygen -H` / ssh の照合はホスト名を小文字化
  するため、ハッシュ照合も token を小文字化してから行う。
- ローカルは `refreshKnownHosts(port, instanceName)` が起動・リビルドの
  たびに `[localhost]:<port>` をアップサートする。

#### SSH 公開範囲（CLOOPY_SSH_BIND）

compose の ports は `"${CLOOPY_SSH_BIND:-}${CLOOPY_SSH_PORT:-10022}:22"`。
値は**末尾コロン込み**（`127.0.0.1:`）。空/未設定 = Docker 既定の全 IF
（IPv4+IPv6）= 従来挙動。`0.0.0.0:` を明示すると **IPv4 のみ**に変わって
しまうため、「LAN 公開」は空文字で表現する。

- **setup の既定は常に「いいえ（ローカルのみ = 127.0.0.1:）」**。LAN 公開を
  明示的に選んで保存済み（`CLOOPY_SSH_BIND=` が空値で存在）の場合のみ
  「はい」が既定。既存 .env（変数未設定）の再 setup でも既定は「いいえ」
  — 2026-06-11 ユーザー判断で既存環境の挙動保護より安全側デフォルトを
  優先（質問は対話で見えるので無断破壊にはならない）。素の `docker compose`
  利用者は compose デフォルトが空なので従来挙動（全 IF）のまま。
- コロン漏れ等の不正値は compose の port 文字列を壊すため、doctor の .env
  チェックで形式検証して setup へ誘導する。
- egress firewall は外向き専用で inbound SSH とは無関係。LAN 公開の入口制御
  はこの bind と sshd 設定（公開鍵のみ・root 不可）が担う。

### ネットワーク隔離（egress firewall）

`init-firewall`（`docker/s6-overlay/scripts/init-firewall.sh`）がコンテナ内で
iptables/ip6tables を投入し、外向き通信を制限する。`cap_add: NET_ADMIN` が必要。

2 層構成（どちらも常時有効、`CLOOPY_FIREWALL=on`）:

- **レイヤ1 — ローカル遮断**: メタデータサービス (`169.254.169.254`, Alibaba
  `100.100.100.200` 等) と RFC1918 / CGNAT / IPv6 ULA などプライベート帯への
  egress を DROP。OUTPUT policy は ACCEPT のまま（公開インターネットは制限しない）。
- **レイヤ2 — DNS ピン留め**: 名前解決をフィルタリング DNS リゾルバ（デフォルト
  Cloudflare for Families `1.1.1.2`、マルウェア/フィッシング遮断）に強制し、
  それ以外の宛先への `:53` を DROP。既知の悪性ドメインを解決段階で潰し、かつ
  無フィルタ resolver（`8.8.8.8` 等）への切替による回避を防ぐ。
- **host.docker.internal は例外的に許可**（レイヤ1 の private DROP より前に
  ACCEPT）。ホスト上の dev サーバ等へ到達できる。`CLOOPY_ALLOW_HOST` で切替。

> **方針転換の記録**: 当初は Phase 2（怪しいポート遮断）/ Phase 3（deny-all +
> ドメイン allowlist）を予定していたが、ポート遮断は 443 で容易に回避され、
> allowlist は汎用開発環境には too much（必要ドメインを事前に予測できず誤遮断が
> 多発）と判断し**いずれも廃止**。Claude Code 自体の auto モード安全策と組み合わせ、
> 「private 遮断 + マルウェア DNS フィルタ」の比例した防御に集約した。

設定（すべて `docker-compose.yml` の env、デフォルトで有効）:

- `CLOOPY_FIREWALL` (`on`/`off`, 既定 `on`): `off` はレイヤ1・2 ともに無効化し
  既存 `CLOOPY-OUT` チェインを撤去する完全キルスイッチ（接続性最優先）。
- `CLOOPY_ALLOW_HOST` (`on`/`off`, 既定 `on`): host.docker.internal の許可。
- `CLOOPY_DNS_PRIMARY` / `_SECONDARY` / `_V6_PRIMARY` / `_V6_SECONDARY`:
  フィルタリゾルバ。`docker-compose.yml` の `dns:` と firewall のピン留めが同じ
  env を読むので常に同期する。プリセット（Quad9 / OpenDNS 等）は `.env.example` 参照。

実装上の注意:

- SSH 戻り通信を守るため、`ESTABLISHED,RELATED` ACCEPT に加えて `--sport 22`
  ACCEPT も入れてある（conntrack が使えない環境でも SSH を落とさない保険）。
- DNS ピン留めは `CLOOPY_DNS_*` が設定されている時のみ `:53` DROP を入れる。未設定
  時は旧挙動（resolv.conf リゾルバ宛 `:53` を ACCEPT、他 `:53` は DROP しない）へ退避
  して名前解決を壊さない。awk 非依存（最小イメージに awk が無い場合のフォールバック
  暴発を防ぐため grep/read/getent で実装）。
- `host.docker.internal` は `extra_hosts: host-gateway` で /etc/hosts に載るため
  `getent hosts` で DNS 不要・起動直後でも解決できる。
- Docker 埋め込み DNS (127.0.0.11) はアプリ→127.0.0.11 が lo 経由で ACCEPT、埋め込み
  DNS→フィルタ IP への上流 `:53` がピンの ACCEPT に当たる。`dns:` で上流をフィルタに
  向けるのが前提（compose と firewall が同 env で同期）。
- `init-firewall` は s6 の依存上 sshd をブロックしない。よって起動直後には「SSH は
  繋がるが firewall ルール適用前」という短い窓が存在する（許容）。
- `docker-compose.local.yml` で `cap_add` を上書きしないこと。NET_ADMIN が失われると
  firewall は fail-open（警告のみ）になり無効化される。
- 動作確認: `test/firewall-phase1.sh`（ローカル遮断）+ `test/firewall-dns.sh`
  （DNS ピン留め・host 許可）+ 実機の s6 起動と `ssh cloopy` 疎通（Approach B）。
