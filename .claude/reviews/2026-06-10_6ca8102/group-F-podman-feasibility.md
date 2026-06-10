---
group: F
topic: rootless-podman-feasibility
files_reviewed: 11
date: 2026-06-10
model: opus
---

# Group F: Rootless Podman 対応フィージビリティ調査

これは**コードレビューではなく実現可能性の設計調査**。ユーザーの問いは「cloopy
に Rootless Podman 対応を追加できるか」。対象コミット `6ca8102`、対象環境は
macOS (Docker Desktop) と uCore（uBlue の Fedora CoreOS 派生、SELinux enforcing、
moby-engine の docker 同梱、`podman` がファーストクラス、user: core）。

> **この環境では docker / podman を実行できない**ため、静的コード調査 + Web
> リサーチでの判断。互換性の主張には出典 URL を付し、裏取りできなかったものは
> 「未確認」と明記する。実機検証チェックリストは §6 に集約。

---

## ファイル別分類テーブル

**該当なし（フィージビリティ調査）。**
本レポートは個別ファイルの欠陥指摘ではなく設計判断が主目的。ただし調査の過程で
発見した既存コードの軽微な問題は §5 に `W-F-<n>` 形式で記載する。提案・判断事項は
§4・§7 に `🙋` タグで列挙する。

調査対象ファイル（11）:

| ファイル | 役割 | docker 依存箇所 |
|---|---|---|
| `cli/lib/compose.ts` | compose 呼び出しの中枢 | `Deno.Command("docker", …)` × 5 |
| `cli/commands/doctor.ts` | docker 存在チェック・image チェック | `Deno.Command("docker", …)` × 3 |
| `cli/commands/manage.ts` | 管理メニュー（shell/backup/restore） | `Deno.Command("docker", …)` × 4 |
| `cli/lib/constants.ts` | `COMPOSE_UP_ARGS` | `--build --wait --wait-timeout --remove-orphans` |
| `cli/main.ts` | エントリポイント | （間接） |
| `docker-compose.yml` | サービス定義 | `cap_add: NET_ADMIN` / `dns:` / `extra_hosts: host-gateway` / `z` フラグ |
| `docker/Dockerfile` | イメージ（Ubuntu 24.04 + s6） | `ENTRYPOINT ["/init"]`（PID1=root 前提） |
| `docker/s6-overlay/scripts/init-firewall.sh` | egress firewall | iptables/ip6tables in-container |
| `docker/s6-overlay/scripts/init-permissions.sh` | UID/GID 調整 | usermod/groupmod/chown -R, sed /etc/passwd |
| `docker/s6-overlay/scripts/init-ssh-keys.sh` | authorized_keys 配置 | `install -o PUID` |
| `cli/lib/workspace.ts` | ワークスペース検証 | `$HOME`/`~/.ssh` 拒否（SELinux 由来） |

---

## 1. 現状分析: cloopy が docker 固有機能に依存している箇所

### 1-1. CLI（`docker` バイナリ名のハードコード）

CLI は `docker` という**バイナリ名を 12 箇所でハードコード**している。抽象化レイヤ
（`runtime` 切替）は一切ない。

| 箇所 | サブコマンド | 用途 |
|---|---|---|
| `cli/lib/compose.ts:53` | `docker compose … up` 等 | `compose()` 汎用ラッパ |
| `cli/lib/compose.ts:75` | `docker compose … logs -f` 等 | `composeSpawn()` |
| `cli/lib/compose.ts:94` | `docker compose … ps -q` | `getContainerId()` |
| `cli/lib/compose.ts:114` | `docker compose … logs --tail` | `checkBootstrapStatus()` |
| `cli/lib/compose.ts:147` | `docker compose … ps --format` | `getStatus()` |
| `cli/commands/doctor.ts:22` | `docker info` | デーモン存在チェック |
| `cli/commands/doctor.ts:103` | `docker compose … config --images` | image ref 解決 |
| `cli/commands/doctor.ts:127` | `docker image inspect <ref>` | image 存在チェック |
| `cli/commands/manage.ts:192` | `docker exec -it -u root … /bin/bash` | 管理シェル |
| `cli/commands/manage.ts:305` | `docker run --rm -v … alpine tar` | backup |
| `cli/commands/manage.ts:415/422/435` | `docker volume rm/create` + `docker run … tar` | restore |

`compose` の呼び出し形は一貫して **`docker compose`（v2 サブコマンド形式）**で、
`docker-compose`（v1 ハイフン形式）は使っていない。

### 1-2. compose 設定の docker 固有要素

- **`cap_add: NET_ADMIN`**（`docker-compose.yml:57`）— firewall の生命線。
- **`dns:`**（28-30）— Docker のネットワークでは埋め込み DNS (127.0.0.11) の上流を
  設定する。podman ではセマンティクスが異なる（§3）。
- **`extra_hosts: host.docker.internal:host-gateway`**（34-35）— firewall の host
  許可ロジックが `getent hosts host.docker.internal` に依存（§4）。
- **`z` フラグ**（43/45/46/50）— SELinux relabel（§6 で互換性確認）。
- **`COMPOSE_UP_ARGS`**（`constants.ts:21`）= `up -d --build --wait --wait-timeout
  300 --remove-orphans` — これらが provider 側で機能するかが §1 の核。

### 1-3. イメージ・ランタイムモデル

- `Dockerfile:99` `ENTRYPOINT ["/init"]` で **s6-overlay が PID1 = (in-container)
  root** として起動。oneshot で usermod/groupmod/chown -R/install -o を実行（§5/§7）。
- LSIO 流の **PUID/PGID + usermod/chown** モデル。rootless では UID マッピングが
  大きく変わる（§5）。

---

## 2. 互換性マトリクス

凡例: ✅ 動く / ⚠️ 条件付き / ❌ 動かない（or 防御が無意味化）/ ❔ 未確認

| # | 調査項目 | rootful podman | rootless podman |
|---|---|---|---|
| 1a | `docker compose`（本家）via podman.socket + `DOCKER_HOST` | ✅ | ✅（`podman.socket` を systemd user で起動） |
| 1b | `--wait` / `--wait-timeout`（本家 compose 経由） | ✅ | ✅（compose クライアントが healthcheck をポーリング） |
| 1c | `--wait`（`podman compose` provider 委譲） | ⚠️ provider 次第 | ⚠️ provider 次第 |
| 1d | `--wait`（`podman-compose` Python） | ❌（v1.5 で未サポート） | ❌ |
| 1e | `--build` / `--remove-orphans` / `depends_on` / healthcheck | ✅ | ✅（本家 compose 経由なら） |
| 2 | `cap_add: NET_ADMIN` + 自 netns で iptables | ✅ | ⚠️ **機能する見込み（要実機）**。カーネルは netns の所有 userns における CAP_NET_ADMIN を見るため、netns を podman の userns 内で作れば効く |
| 2b | iptables バックエンド（Fedora は nftables 系） | ⚠️ イメージ内 `iptables` は legacy/nft どちらか要確認 | ⚠️ 同左 |
| 3a | レイヤ1 private/メタデータ DROP の防御意味 | ✅ 保たれる | ⚠️ **意味は保たれるが脅威面が変化**（pasta は host の実 IP を netns に複製、LAN が直達） |
| 3b | レイヤ2 DNS ピン留めの防御意味 | ✅ | ⚠️ 保たれる（ただし `dns:` の効き方が変化、要実機） |
| 3c | メタデータ 169.254.169.254 への到達経路 | iptables DROP で遮断 | ⚠️ iptables が効けば遮断。ただし pasta の host マッピング 169.254.1.2 と混同しない設計が必要 |
| 4 | `extra_hosts: host-gateway`（host.docker.internal） | ⚠️ バージョン依存 | ⚠️ **rootless + pasta で「IP empty」エラー報告あり**。`host.containers.internal` 併用が無難 |
| 5a | PUID/PGID + usermod/chown モデル | ⚠️ ほぼそのまま（root=host root） | ❌ **そのままでは破綻**。container UID 1000 → host subuid にマップ |
| 5b | `--userns=keep-id` の要否 | 不要 | ⚠️ 事実上必須（host user を container 内 UID に固定） |
| 5c | named volume の所有権 | ✅ | ⚠️ userns で UID ずれ・`:U` か init での chown 要 |
| 5d | macOS の `podman machine` | ⚠️（VM 内は rootful 相当のことが多い） | ⚠️ VM 越しの bind mount は別問題 |
| 6 | SELinux `:z` / `:Z` | ✅（podman 発祥機能） | ✅（rootless でも relabel 可、ただし `/usr` 等は不可） |
| 7 | s6-overlay PID1 = in-container root | ✅ | ✅（userns 内の root として動く。PID1 自体は成立） |
| 8 | `10022:22` publish / `127.0.0.1` bind | ✅ | ✅（非特権ポート。rootless でも publish 可） |

---

## 3. 各調査項目の根拠（出典付き）

### 項目1 — CLI 互換（compose の呼び方）

cloopy は **本家 `docker compose`（v2）形式**を一貫して使う。Podman で本家 compose を
動かす標準手は **podman socket + `DOCKER_HOST`**：

```
systemctl --user enable --now podman.socket
export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock
```

これで本家 `docker compose` バイナリが podman の Docker 互換 API (v1.40) 越しに動く。
この経路なら **`--wait` / `--wait-timeout` / `--build` / `depends_on` / healthcheck`
は compose クライアント側の機能なので機能する**（compose がコンテナ状態を API で
ポーリングするため）。

- 一方 **`podman-compose`（Python 実装）は v1.5 時点で `--wait` 未サポート**
  （issue #710 / #1329）。`COMPOSE_UP_ARGS` の `--wait` が無視 or エラーになるため
  **cloopy をそのまま `podman-compose` に向けるのは不可**。
- `podman compose`（podman 内蔵のラッパ）は外部 provider（docker-compose /
  podman-compose）へ委譲する薄いラッパで、挙動は委譲先次第。

出典:
- https://github.com/containers/podman-compose/issues/710
- https://github.com/containers/podman-compose/issues/1329
- https://oneuptime.com/blog/post/2026-03-17-use-docker-compose-podman-socket/view
- https://oneuptime.com/blog/post/2026-03-17-use-docker-compose-v2-podman/view
- https://docs.podman.io/en/v5.6.2/markdown/podman-compose.1.html

> **要実機**: healthcheck without systemd の既知不具合（issue #28192）は
> **Podman-in-Podman 限定**で、uCore のように host に systemd がある通常構成では
> 該当しない見込み。ただし `--wait` がコンテナの healthy 遷移を正しく待つかは実機確認。
> 出典: https://github.com/containers/podman/issues/28192

### 項目2 — NET_ADMIN + in-container iptables（firewall の生命線）

**ここが対応可否を最も左右する。** Web 上の概説は「rootless podman は iptables を
変更できない」と書きがちだが、これは **host の netns を触ろうとした場合**の話で、
**コンテナ自身の netns 内**は別。決定的な技術的事実：

> 「カーネルが本当にチェックするのは root であることではなく、その netns を所有する
> user namespace において CAP_NET_ADMIN を持つかどうか」（podman discussion #17235）

つまり **podman が自分の userns 内で作った netns に対しては、`cap_add: NET_ADMIN` を
付与したコンテナ内プロセスが iptables を実行できる**見込み。cloopy の firewall は
OUTPUT チェインを自 netns 内で操作するだけなので、原理的には rootless でも機能しうる。

ただし重大な注意点（同じ #27099 で maintainer Luap99 が言及）：
> セキュアな egress フィルタの「推奨形」は **コンテナに CAP_NET_ADMIN を渡さず**、
> OCI hook（createContainer 段階）で host 側からルールを入れる方式。コンテナに
> NET_ADMIN を渡すと、コンテナ内プロセスが**自分でルールを消せる**（cloopy の
> auto モード前提なら Claude 自身が消せてしまう）。

→ cloopy の現行設計（コンテナ内 firewall + NET_ADMIN）は docker でも「自衛的」防御で
あって完全な封じ込めではない（CLAUDE.md の「70点の防御」方針と整合）。rootless でも
**機能はするが防御強度は docker と同等以上にはならない**。

バックエンド: Fedora 系は netavark が nftables をデフォルト化（v1.10〜）。ただし
これは **podman 自身のネットワーク設定**の話で、**コンテナ内の `iptables` コマンドが
legacy か nft かは cloopy のイメージ（Ubuntu 24.04, `iptables` パッケージ）依存**。
Ubuntu 24.04 は `iptables-nft`（nft バックエンドの iptables 互換 CLI）がデフォルト。
コンテナ内 nft が rootless netns で動くかは **要実機**（カーネルモジュール `nf_tables`
の利用可否に依存）。

出典:
- https://github.com/containers/podman/discussions/17235
- https://github.com/containers/podman/discussions/27099
- https://fedoraproject.org/wiki/Changes/NetavarkNftablesDefault
- https://github.com/containers/netavark/blob/main/docs/netavark-firewalld.7.md

### 項目3 — ネットワーク意味論の変化（pasta / slirp4netns）

rootless のデフォルトは **pasta**（Podman 5.x〜）。pasta は **NAT を使わず、host の
実 IP・ルート・MTU をコンテナの netns に「複製」**する（L2↔L4 変換）。Oracle の
チュートリアルが実機ログで確認：host `10.0.0.53/28` がコンテナ内にも同一 IP・同一
インターフェース名で現れる。

firewall への含意：
- **レイヤ1（private/メタデータ DROP）の防御意味は保たれる**。iptables は
  コンテナ netns の OUTPUT で評価されるので、pasta が外へ転送する**前**に DROP できる。
  ただし pasta は host LAN が「より直接的に」見える構成なので、**iptables が効かない/
  消された場合のリスクは docker bridge 構成より大きい**（host LAN が素通り）。
- pasta は host 接続用に **`169.254.1.2` を host.containers.internal にマップ**する。
  cloopy のレイヤ1 は `169.254.0.0/16` を丸ごと DROP しているので、**素の pasta では
  host への到達が壊れる**（`host.docker.internal` 許可ロジックが効く前提が崩れる）。
  → §4 と連動する設計修正が必要。
- `169.254.169.254`（クラウドメタデータ）は pasta の host マッピング `169.254.1.2`
  とは別 IP。iptables の `169.254.0.0/16` DROP が効けば両方遮断されるが、host 許可を
  入れるなら `169.254.1.2` だけ穴を空けつつ `169.254.169.254` は塞ぐ、という
  きめ細かさが要る。
- `dns:` ディレクティブ — docker では埋め込み DNS の上流設定。pasta では
  `--dns-forward` 経由で host のリゾルバに転送されるなど挙動が異なり、レイヤ2 の
  「`:53` を特定 IP にピン留め」が**そのままでは噛み合わない可能性**。要実機。

出典:
- https://docs.oracle.com/en/learn/ol-podman-pasta-networking/
- https://github.com/containers/podman/issues/28433（169.254.1.2 マッピング）
- https://github.com/containers/podman/discussions/27057
- https://www.wiz.io/academy/application-security/server-side-request-forgery（IMDS/RFC1918 脅威）

### 項目4 — host.docker.internal / extra_hosts host-gateway

- podman は `extra_hosts: host.docker.internal:host-gateway` を**サポートするが、
  rootless + pasta で "host containers internal IP address is empty" エラーの
  報告が複数**（issue #22881 / #24970, discussion #24133）。
- podman ネイティブは **`host.containers.internal`**。pasta はこれを `169.254.1.2`
  にマップする（前述）。
- cloopy の `_host_ips()` は `getent hosts host.docker.internal` に依存（init-firewall.sh
  :131）。**host.docker.internal が解決できないと host 許可ルールが空振り**し、
  レイヤ1 の `169.254.0.0/16` / RFC1918 DROP によって host 到達が壊れる
  （fail する方向なので「壊れる」だけで「漏れる」わけではない＝安全側だが UX 劣化）。

出典:
- https://github.com/containers/podman/issues/10878
- https://github.com/containers/podman/issues/22881
- https://github.com/containers/podman/discussions/24133

### 項目5 — UID/GID モデル

rootless では **container 内の UID は host の subuid 範囲にマップ**される。デフォルトでは
container root = host の実ユーザー、container の他 UID（cloopy の 1000）は
`/etc/subuid` のレンジへ。

cloopy の `init-permissions.sh` の前提（PUID=1000 にユーザーを合わせ、
home/nix を `chown -R 1000:1000`）は **rootless だと意味が変わる**：
- `--userns=keep-id` を付けると host user が container 内の指定 UID にマップされ、
  bind mount の所有権が素直になる。cloopy は PUID で host user に合わせる設計なので
  **keep-id（または `keep-id:uid=1000,gid=1000`）相当が事実上必須**。
- named volume（home-data / nix-store / ssh-config）の初期所有権は userns 適用時に
  ずれやすい（UID=GID=999 になる既知事象 / issue #23347）。`:U` フラグか
  init での chown 補正が要る。`install -m 600 -o 1000`（init-ssh-keys.sh:36）も
  マッピング次第で「存在しない UID」になりうる。
- **macOS の `podman machine`**: Linux VM 越し。VM 内は rootful 相当で動くことが
  多く、bind mount は gvproxy/virtiofs 経由。挙動が Linux ネイティブ rootless とは
  別物なので、macOS は「Docker Desktop のまま」が無難（対応の主目的は uCore）。

出典:
- https://www.redhat.com/en/blog/rootless-podman-user-namespace-modes
- https://cvigano.de/blog/2025/11/17/podman-and-userns-mode/
- https://github.com/containers/podman/issues/23347
- https://docs.podman.io/en/latest/markdown/podman-run.1.html

### 項目6 — SELinux `:z` / `:Z`

`:z`/`:Z` は **podman 発祥の機能**で互換は良好。rootless でも relabel は可能だが、
`/usr` 配下など書込み禁止領域では失敗する（issue #16423）。cloopy の bind mount は
`$HOME` 配下のワークスペースと `/etc/cloopy/authorized_keys` ステージなので問題は
出にくい。**SELinux 対応は podman 側がむしろ本家**であり、ここは阻害要因ではない。

出典:
- https://docs.podman.io/en/v4.3/markdown/options/volume.html
- https://developers.redhat.com/articles/2025/04/11/my-advice-selinux-container-labeling
- https://github.com/containers/podman/issues/16423

### 項目7 — s6-overlay PID1

s6-overlay は userns 内の (mapped) root として PID1 で動く。**PID1 が成立すること
自体は rootless で問題ない**。問題は PID1 配下の oneshot が行う特権操作
（usermod / chown -R / iptables）が userns 内で許される範囲か、で、これは §2・§5 に
帰着する。s6 そのものが阻害要因になる根拠は見つからなかった（**未確認だが阻害の
可能性は低い**）。

### 項目8 — ports bind

`10022:22` は非特権ポートの publish。rootless でも publish 可能（特権ポートでないため
`net.ipv4.ip_unprivileged_port_start` 調整も不要）。**阻害要因なし**。

---

## 4. 段階的対応案

### Tier 0: 非対応を明記（現状維持 + ドキュメント）

- **内容**: README / doctor に「cloopy は Docker（Docker Desktop / moby-engine）
  前提。Podman は未サポート」と明記。uCore ユーザーには「同梱の moby-engine docker を
  使う」案内（uCore は docker も入っている）。
- **変更ファイル**: `README.md`, 任意で `cli/commands/doctor.ts`（docker 不在時の
  メッセージに podman 検出ヒントを足す程度）。
- **工数**: 0.5 日。**リスク**: なし。firewall 防御モデルは docker のまま無傷。

### Tier 1: podman.socket + 本家 docker compose で「動作確認のみ」（コード変更最小）

- **内容**: コードは変えず、**ドキュメントで手順を提示**：
  ```
  systemctl --user enable --now podman.socket
  export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock
  ```
  本家 `docker compose` バイナリ（uCore にあるか、別途導入）を podman socket に
  向ける。cloopy の CLI は `docker compose` を呼ぶので**バイナリ名はそのまま**動く。
- **必要な実機検証**（§6）が全部 green になって初めて「動作確認済み」と言える。
- **変更ファイル**: `README.md` のみ（+ 検証で問題が出れば compose の env や
  workspace 制約に追記）。CLI コードは無改変。
- **工数**: 検証込みで 1〜2 日（実機は user 側）。
- **リスク（重要）**:
  - 項目2（NET_ADMIN iptables）が実機で効かなければ **firewall が fail-open**
    （init-firewall.sh:147 の WARN パス）になり、**pasta 構成では host LAN が
    素通り**＝ docker 構成より危険。→ この場合は Tier 1 を「動作確認 NG」として
    打ち切るべき。
  - 項目4（host.docker.internal 空 IP）で host 連携が壊れる UX 劣化。
  - 項目5（UID マッピング）で home/workspace の所有権が壊れる可能性。`docker compose`
    経由だと `--userns=keep-id` を compose 側で指定する必要があり、これは
    `userns_mode: keep-id` を compose に書くか env で対応（docker では無害な追記か
    要確認）。

### Tier 2: CLI が podman を自動検出しネイティブ対応

- **内容**: `cli/lib/runtime.ts`（新規）を作り、`docker` が無ければ `podman` を
  検出 → 全 `Deno.Command("docker", …)` を `runtime` 変数化。`docker compose` →
  `podman compose`（または socket 経由本家）へ切替。compose 設定も
  `docker-compose.podman.yml`（`userns_mode`, `host.containers.internal`, pasta 用の
  host 許可調整）でオーバーレイ。firewall スクリプトを pasta 対応に修正
  （`169.254.1.2` を許可しつつ `169.254.169.254` を塞ぐ、`host.containers.internal`
  も `_host_ips` で解決）。
- **変更ファイル**: `cli/lib/compose.ts`（全 docker 呼び出し）, `cli/commands/doctor.ts`
  （3 箇所 + Docker チェックを runtime 検出に）, `cli/commands/manage.ts`
  （exec/run/volume 4 箇所）, `cli/lib/constants.ts`（provider 別 UP_ARGS）,
  新規 `docker-compose.podman.yml`, `init-firewall.sh`（pasta 分岐）, README,
  test/（podman 用テスト追加）。
- **工数**: 5〜8 日。**リスク**: 大。
  - cloopy の「manage.sh 一発」「70点を簡単に」方針に対し、**メンテ対象ランタイムが
    2 系統 + ネットワークモデル 2 種 + UID モデル 2 種**に増える。
  - firewall の防御が pasta で「意味は保つが脆くなる」（§3）ため、防御強度の前提が
    ランタイムで変わる ＝ CLAUDE.md の確定済み threat model を分岐させることになる。
  - macOS の podman machine まで広げると VM 越し bind mount の沼。

---

## 5. 発見した既存コードの問題（通常レビュー形式）

これらは Podman 非依存で、docker のままでも改善余地のある点。

- **W-F-1（情報）**: `cli/commands/doctor.ts:20-39` `checkDocker()` は `docker info`
  固定。Podman 対応の有無に関わらず、将来 runtime 抽象化するなら最初に手を入れる
  単一点。現状は機能上の問題なし。
- **W-F-2（情報）**: `cli/commands/manage.ts:305/415/422/435` の backup/restore は
  `docker run … alpine` と `docker volume` を直叩き（compose ラッパを通さない）。
  runtime 抽象化時にここも漏れなく拾う必要がある（compose.ts だけ直すと backup が
  docker のまま残る）。テスト `test/*.sh` も全て `docker` 直書き。
- **W-F-3（情報・docker でも該当）**: `init-firewall.sh` は host 許可を
  `host.docker.internal` のみで解決。podman ネイティブの `host.containers.internal`
  には未対応。docker では不要だが、将来対応時の追加点として記録。

> いずれも現行 docker 運用での**バグではない**（設計通り）。Podman 対応を採らない
> 限り修正不要。

---

## 6. 未確認事項（実機検証チェックリスト — uCore 実機で検証可能）

優先度順。★ は対応可否を左右する決定的項目。

1. ★ **NET_ADMIN + in-container iptables が rootless で効くか**
   `podman run --rm --cap-add NET_ADMIN ys319/cloopy:latest /etc/s6-overlay/scripts/init-firewall.sh`
   → `iptables -S CLOOPY-OUT` がエラーなく出るか。`test/firewall-phase1.sh` を
   podman で流す（NET_ADMIN なし時に fail-open する分岐も確認）。
2. ★ **Ubuntu 24.04 の `iptables`（nft バックエンド）が rootless netns で動くか**
   カーネル `nf_tables` モジュールの利用可否。legacy へ切替が要るか。
3. ★ **pasta 構成でレイヤ1 DROP が実際に egress を止めるか**
   コンテナから `169.254.169.254` / RFC1918 への到達を試し DROP されるか確認。
4. **`docker compose --wait` が podman.socket 経由で healthy を正しく待つか**
   （issue #28192 は PinP 限定の見込みだが要確認）。
5. **`extra_hosts: host-gateway` / `host.docker.internal` 解決**
   `getent hosts host.docker.internal` がコンテナ内で IP を返すか。返さない場合
   host 連携が壊れる（`host.containers.internal` で代替可能か）。
6. **`dns:` ディレクティブが pasta で効くか**（レイヤ2 のピン留めが噛み合うか）。
7. **named volume（home-data/nix-store/ssh-config）の所有権**
   `--userns=keep-id` 有無で home の `chown -R` / `install -o 1000` が成功するか。
   SSH ログイン（`ssh cloopy`）まで通るか（Approach B）。
8. **`z` relabel** がワークスペース bind mount で成功するか（SELinux enforcing 下）。
9. **`podman-compose`（Python）に向けた場合の `--wait` 非対応**の実害確認
   （本家 compose 経由なら不要だが、uCore に本家 compose が無いと podman-compose に
   倒れる）。

---

## 7. 推奨

🙋 **推奨: Tier 0（非対応を明記）+ uCore では同梱 docker を使う案内。Podman ネイティブ
対応（Tier 2）は現時点で見送り。** 条件付きで Tier 1（ドキュメントのみの動作確認手順）を
「実験的・無保証」として README の折りたたみに添えるのは可。

根拠:

1. 🙋 **firewall の防御モデルが pasta で「意味は保つが脆くなる」**。レイヤ1 は
   iptables が効く限り機能するが、pasta は host の実 IP を netns に複製するため
   **iptables が効かない/消された瞬間に host LAN が素通り**になり、docker bridge
   構成より失敗時の被害が大きい（§3）。CLAUDE.md は firewall を「private 遮断 +
   マルウェア DNS フィルタの比例した防御」として確定済みで、ランタイムごとに
   threat model が変わるのは方針（「70点を簡単に」）に逆行する。

2. 🙋 **対応コストが体験を壊す**。Tier 2 は runtime 2 系統 × network モデル 2 種 ×
   UID モデル 2 種をメンテ対象に増やす（§4）。「manage.sh 一発」の単純さが失われ、
   テスト（`test/*.sh` の docker 直書き）も二重化が必要。

3. 🙋 **uCore は docker（moby-engine）が同梱**されており、cloopy はそのまま動く
   （Group はこの前提で SELinux 対応を 6ca8102 までに完了済み）。「podman で
   docker デーモンなしに」という動機は理解できるが、**実利（デーモン 1 個減る）に対し
   防御モデルの不確実性とメンテ負債が見合わない**。

🙋 **条件付き再評価のトリガ**: 上記 §6 の ★ 3 項目（特に項目1・3）が実機で全て
green になり、かつ pasta 下で「iptables が消えても host LAN に漏れない」追加の
封じ込め（例: OCI hook による host 側ルール、Luap99 推奨形）が低コストで足せると
判明した場合に限り、Tier 1（ドキュメント）→ Tier 2（ネイティブ）へ昇格を再検討する
価値がある。それまでは **Tier 0 が方針と整合**。

---

## 出典一覧

- https://github.com/containers/podman-compose/issues/710
- https://github.com/containers/podman-compose/issues/1329
- https://docs.podman.io/en/v5.6.2/markdown/podman-compose.1.html
- https://oneuptime.com/blog/post/2026-03-17-use-docker-compose-podman-socket/view
- https://oneuptime.com/blog/post/2026-03-17-use-docker-compose-v2-podman/view
- https://github.com/containers/podman/discussions/17235
- https://github.com/containers/podman/discussions/27099
- https://fedoraproject.org/wiki/Changes/NetavarkNftablesDefault
- https://github.com/containers/netavark/blob/main/docs/netavark-firewalld.7.md
- https://docs.oracle.com/en/learn/ol-podman-pasta-networking/
- https://github.com/containers/podman/issues/28433
- https://github.com/containers/podman/discussions/27057
- https://www.wiz.io/academy/application-security/server-side-request-forgery
- https://github.com/containers/podman/issues/10878
- https://github.com/containers/podman/issues/22881
- https://github.com/containers/podman/discussions/24133
- https://www.redhat.com/en/blog/rootless-podman-user-namespace-modes
- https://cvigano.de/blog/2025/11/17/podman-and-userns-mode/
- https://github.com/containers/podman/issues/23347
- https://docs.podman.io/en/latest/markdown/podman-run.1.html
- https://docs.podman.io/en/v4.3/markdown/options/volume.html
- https://developers.redhat.com/articles/2025/04/11/my-advice-selinux-container-labeling
- https://github.com/containers/podman/issues/16423
- https://github.com/containers/podman/issues/28192
