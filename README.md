<p align="center">
  <img src="assets/logo.png" alt="cloopy" width="400">
</p>

<p align="center">Claude Code向けのバッテリー付属コンテナ環境。<br>セットアップ一発で、VS Code Remote SSHからClaudeと開発を始められます。</p>

## なぜ cloopy？

Claude Codeをホストで直接動かすと、エージェントが意図せずシステムファイルを操作したり、侵害されたパッケージがホスト全体に影響するリスクがあります。かといって複雑なサンドボックスを毎回手作りするのも現実的ではありません。

cloopyはその中間を目指しています。

- **被害範囲を限定する** — Claude Codeが暴走しても、サプライチェーン攻撃を受けても、影響はコンテナの中に収まる
- **攻撃面が小さい** — アクセス手段はSSHのみ。DockerソケットやホストのファイルシステムをClaudeに渡さない
- **ネットワークを隔離する** — クラウドのメタデータサービスやプライベートIP帯への外向き通信を遮断。認証情報の窃取や社内ネットワークへの横移動を防ぐ（[脅威モデル](#脅威モデル)）
- **70点の防御を簡単に** — 使うのが難しい90点の対策より、`./manage.sh`一発で誰でも使える防御を優先する
- **軽量でツールに馴染む** — 単一の軽量コンテナ。ビルド時間も短く、VS Code Remote SSHにそのまま統合できる
- **データは消えない** — ホームディレクトリとワークスペースはDockerボリュームで永続化。コンテナを作り直してもデータは残る
- **開発環境はClaude自身が整える** — Nix + Devboxで必要なツールをコンテナ内に閉じ込めながら柔軟に導入できる

## Quick Start

```bash
# Windows
manage.bat

# Linux / macOS / Git Bash
./manage.sh
```

これだけで：

1. SSH鍵を自動生成
2. Dockerイメージをビルド&起動
3. SSH Configに`cloopy`エントリを注入

あとはVS CodeでRemote SSH → `cloopy`に接続するだけ。

## ツール別ガイド

SSH経由でアクセスできるツールであれば、基本的にそのまま使えます。

### VS Code

1. 左下の `><` ボタンをクリック
2. **Connect to Host...** を選択
3. `cloopy` を選択

### Claude Desktop

1. **コード** タブを開く
2. 接続先（未設定なら `Local` と表示）をクリック
3. **SSH接続を追加** を選択
4. 任意の名前を入力し、ホスト名に `cloopy` と入力

## What's Inside

| Tool         | Purpose                                        |
| ------------ | ---------------------------------------------- |
| Nix + Devbox | Claudeが必要なツールを自分で入れるための道具箱 |
| Zsh (grml)   | デフォルトシェル                               |

## Customization

### docker-compose.local.yml

初回セットアップ時に自動生成されます（.gitignore対象）。\
ローカル固有のオーバーライドを自由に追記できます。

```yaml
# Claude Teamの認証情報をホストから共有する例
# SELinuxなホスト（Fedora CoreOS / uCore等）では末尾に :Z を付けること
# （複数インスタンスで同じディレクトリを共有する場合のみ :z）
services:
  sandbox:
    volumes:
      - ~/.claude:/home/developer/.claude:Z
```

### .env

初回セットアップ時に`.env.example`をもとに自動生成されます。\
生成後は手動で編集可能です。すべてオプションです。\
DNS・Firewall・SSHポート等は`./manage.sh`の「設定変更」メニューからも変更できます。

ネットワーク隔離は`CLOOPY_FIREWALL`で制御します（デフォルト`on`）。

```bash
# メタデータ/プライベートIP帯の遮断 + マルウェアDNSフィルタ（推奨）
CLOOPY_FIREWALL=on

# キルスイッチ: 全 egress フィルタを無効化
# 接続できなくなった時の緊急避難用。クラウドVMでは使わないこと
CLOOPY_FIREWALL=off

# ホスト連携（host.docker.internal）の許可（デフォルトon）
CLOOPY_ALLOW_HOST=on

# フィルタリングDNSリゾルバ（デフォルト Cloudflare 1.1.1.2 = マルウェア遮断）
# Quad9: 9.9.9.9 / Cisco OpenDNS: 208.67.222.222 などに変更可
CLOOPY_DNS_PRIMARY=1.1.1.2
CLOOPY_DNS_SECONDARY=1.0.0.2
```

### SSH鍵の追加（複数鍵）

`./manage.sh` の「設定 → SSH 鍵管理」メニューから、自動生成鍵に加えて任意の公開鍵を登録できます（別マシンや同僚の鍵でアクセスしたい場合など）。

- **追加方法は3つ**: 貼り付け / ファイル指定 / GitHubから取得（`https://github.com/<ユーザー名>.keys`）
- 追加前にSHA256指紋を表示して確認。同じ鍵の二重登録は自動でスキップ
- 一覧・削除もメニューから（自動生成鍵は接続の生命線のため削除不可）
- 鍵のメタ情報は`~/.ssh/cloopy/keys.json`で管理され、コンテナへは自動生成鍵と束ねた`~/.ssh/cloopy/authorized_keys`が渡されます
- 反映はコンテナ再作成時（変更後にメニューが案内します）

### リモートのcloopyに接続する（LAN内の別マシン）

別マシン（自宅サーバ等）で動いているcloopyへ、手元のマシンから`ssh <名前>`一発で接続できます。

**サーバ側**（cloopyが動いているマシン）:

1. 「設定 → SSH 鍵管理」で接続元マシンの公開鍵を追加（GitHubからの取得が手軽）
2. 「設定 → 設定変更 → SSH 公開範囲」を**LAN 公開**にする

**クライアント側**（接続したいマシン）:

1. cloopyリポジトリで `./manage.sh` → メニューの「**リモート接続**」
2. サーバのIPとポートを入力 → ホスト鍵の指紋を確認 → 登録
3. 以後 `ssh <エントリ名>` やVS Code / Claude DesktopのRemote SSHで接続可能

クライアント側にDockerは不要です（Dockerが見つからない場合は起動時にリモート接続専用モードを案内します）。エントリは`~/.ssh/cloopy/remotes.json`で管理され、ホスト鍵は標準の`~/.ssh/known_hosts`に`cloopy:<エントリ名>`マーカー付きで固定されます（Claude DesktopのSSH接続は標準known_hostsしか参照しないため。VS CodeやClaude Desktopからもそのまま繋がります）。

> セキュリティ上の注意: セットアップでのSSH公開範囲のデフォルトは「ローカルのみ（127.0.0.1）」です。LAN公開はSSH（公開鍵認証のみ・rootログイン不可）で保護されますが、信頼できないネットワークでは有効にしないでください。インターネットへの直接公開は想定外です（必要ならVPN越しに）。

## Commands

2回目以降も `./manage.sh`（Windows: `manage.bat`）を実行すると対話メニューが開きます。\
起動・停止・SSH接続・ログ確認・リビルド・リセット等すべてメニューから操作可能です。

<details>
<summary>docker composeを直接使う場合</summary>

```bash
docker compose up -d --build   # 起動（git pull 後も旧イメージで起動しないよう --build 推奨）
docker compose down            # 停止
docker compose logs -f         # ログ確認
ssh cloopy                     # SSH 接続

# リセット（ホーム・Nix・SSHホスト鍵を初期化、ワークスペースは保持）
docker compose down
docker volume rm cloopy_home-data cloopy_nix-store cloopy_ssh-config
```

</details>

## Architecture

```
SSH → svc-sshd (longrun)
       ↑ depends on
     init-ssh-keys → init-permissions ← base
                          ↓ also depends
                     svc-bootstrap (oneshot: Nix/Devbox)
                     init-firewall (oneshot: egress フィルタ)
                     init-workspace-check
```

sshdとbootstrapは並列実行。\
SSHはbootstrap完了前に接続可能です。

## 脅威モデル

cloopyは「70点の防御を簡単に」を方針にしています。完璧なサンドボックスではなく、現実的な手間で被害を大きく減らすことを狙います。

### ネットワーク隔離（egress firewall）

コンテナ内のiptables/ip6tablesで外向き通信を制限します。2層構成で、どちらもデフォルト有効です。

- **ローカル遮断（常時有効）**
  - クラウドのメタデータサービス（`169.254.169.254`、Alibaba `100.100.100.200`）への通信を遮断
  - プライベートIP帯（`10/8`・`172.16/12`・`192.168/16`・CGNAT `100.64/10`・IPv6 ULA）への通信を遮断
  - 公開インターネットへの通信はそのまま。SSH・DNS・確立済み接続は壊さない
- **マルウェアDNSフィルタ（常時有効）**
  - 名前解決をフィルタリングDNS（デフォルト Cloudflare for Families `1.1.1.2`）に強制し、既知のマルウェア/フィッシングドメインを解決段階で遮断
  - `:53`をフィルタ宛のみに固定し、無フィルタなリゾルバへの切替による回避を防止
  - リゾルバは`.env`で変更可能（Quad9・Cisco OpenDNS等）
- **ホスト連携** — `host.docker.internal`（ホスト上のdevサーバ等）への通信は許可。残りのプライベート帯は遮断したまま

> 当初検討した「怪しいポート遮断」「ドメインallowlist」は、前者は443で容易に回避され、後者は汎用開発環境には過剰（必要ドメインを予測できず誤遮断が多発）と判断し採用を見送りました。Claude Code自体の安全策と合わせ、現実的な多層防御に集約しています。

#### 防げること

- 流出した認証情報やソースコードの**メタデータサービス経由の窃取**（IMDS credential theft）
- コンテナから**ホストの社内ネットワーク／プライベートサービスへの横移動**（lateral movement）
- **既知の悪性ドメイン**（マルウェア配布・フィッシング・一部のC2）への名前解決ベースの到達

#### 防げないこと（限界）

- **悪意あるパッケージの「実行」そのもの** — ファイアウォールは実行後の流出を抑える手段で、実行自体は防げません
- **公開インターネット経由のデータ流出** — 公開宛先は制限しません（allowlistは過剰として不採用）
- **未知の悪性ドメイン** — DNSフィルタは脅威インテリに載った既知のドメインのみ遮断。新規のC2/配布ドメインは反映前なら通ります（＝「多少の防御」）
- **DoH/DoTを自前で喋るプロセス** — `:53`の素のDNSはフィルタに固定しますが、`443`(DoH)/`853`(DoT)で独自に名前解決するプロセスはフィルタを素通りします
- **NET_ADMIN権限を悪用したファイアウォール無効化** — コンテナ内に`NET_ADMIN`が残るため、悪意あるコードが`iptables -F`でルールを消せる可能性があります。これは`./manage.sh`一発の体験を優先した結果のトレードオフです
- **起動直後のわずかな窓** — SSHはファイアウォール適用前に接続可能になるため、起動から数秒間はルール未適用の時間があります

> `CLOOPY_FIREWALL=off` または `cap_add: NET_ADMIN` の削除でファイアウォールを完全に無効化できます。接続できなくなった場合の緊急避難用ですが、クラウドVM上ではメタデータサービスが再露出するため使わないでください。

## License

MIT
