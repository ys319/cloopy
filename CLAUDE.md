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
├── init-ssh-keys       (oneshot, depends: init-permissions) authorized_keys 検証、sshd 設定
├── init-workspace-check(oneshot, depends: init-permissions) ワークスペース UID 不一致警告
├── init-firewall       (oneshot, depends: init-permissions) egress ローカル遮断
├── svc-bootstrap       (oneshot, depends: init-permissions) Nix/Devbox/Volta
└── svc-sshd            (longrun, depends: init-ssh-keys) SSH デーモン
```

sshd と bootstrap は並列実行。SSH は bootstrap 完了前に接続可能。

### ネットワーク隔離（egress firewall）

`init-firewall`（`docker/s6-overlay/scripts/init-firewall.sh`）がコンテナ内で
iptables/ip6tables を投入し、外向き通信を制限する。`cap_add: NET_ADMIN` が必要。

段階的に実装する方針（粒度: 絶対必要 → あった方がいい → 出来れば）:

- **Phase 1（実装済み）— ローカル遮断**: メタデータサービス
  (`169.254.169.254` 等) と RFC1918 / CGNAT / IPv6 ULA など
  プライベート帯への egress を DROP。OUTPUT policy は ACCEPT のまま
  （公開インターネットは制限しない）。loopback / ESTABLISHED,RELATED / DNS(53)
  を先に ACCEPT して SSH と名前解決を壊さない。NET_ADMIN 不在時は fail-open。
- **Phase 2（未）— 怪しい通信**: クリプトマイナーの stratum / 非標準 C2 ポート等の
  怪しい outbound ポートをブロック。
- **Phase 3（未）— 許可リスト**: deny-all + ipset ドメイン allowlist
  （`CLOOPY_EXTRA_DOMAINS` / `docker/firewall/allowed-domains.txt`）。

`CLOOPY_FIREWALL` (`on`/`off`, デフォルト `on`) で切替。Phase 1 では `off` は
全 egress フィルタを無効化するキルスイッチとして機能する（接続性最優先のため）。
`off` は再実行時に既存ルール（`CLOOPY-OUT` チェイン）も撤去する。
allowlist 追加後は「local 遮断は常時 on、allowlist のみ切替」に変更予定。

実装上の注意:

- SSH 戻り通信を守るため、`ESTABLISHED,RELATED` ACCEPT に加えて `--sport 22`
  ACCEPT も入れてある（conntrack が使えない環境でも SSH を落とさない保険）。
- DNS の `:53` ACCEPT は `/etc/resolv.conf` のリゾルバ宛てに限定（`-d any` にしない）。
  プライベートIP上のリゾルバでも DNS は通り、かつ任意のプライベートホストへ `:53`
  で到達する横移動の穴を塞ぐ。awk 非依存（最小イメージに awk が無い場合のフォールバック
  暴発を防ぐため grep/read で実装）。
- `init-firewall` は s6 の依存上 sshd をブロックしない。よって起動直後には「SSH は
  繋がるが firewall ルール適用前」という短い窓が存在する（Phase 1 では許容）。
- `docker-compose.local.yml` で `cap_add` を上書きしないこと。NET_ADMIN が失われると
  firewall は fail-open（警告のみ）になり無効化される。
- 動作確認: `test/firewall-phase1.sh`（隔離コンテナでの挙動検証）+ 実機の s6 起動と
  `ssh cloopy` 疎通（Approach B）。
