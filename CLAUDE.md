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
├── init-permissions    (oneshot) UID/GID 調整、ボリューム chown
├── init-ssh-keys       (oneshot, depends: init-permissions) authorized_keys 配置・検証、sshd 設定
├── init-workspace-check(oneshot, depends: init-permissions) ワークスペース UID 不一致警告
├── init-firewall       (oneshot, depends: init-permissions) egress ローカル遮断
├── svc-bootstrap       (oneshot, depends: init-permissions) Nix/Devbox/Volta
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
読めなくなる）ため。コピーは毎起動なので、鍵の変更（複数鍵の追記含む）は
コンテナ再起動で反映される。コンテナ内で authorized_keys を直接編集しても
次回起動で上書きされる点に注意。

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
