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
services:
  sandbox:
    volumes:
      - ~/.claude:/home/developer/.claude
```

### .env

初回セットアップ時に`.env.example`をもとに自動生成されます。\
生成後は手動で編集可能です。すべてオプションです。

ネットワーク隔離は`CLOOPY_FIREWALL`で制御します（デフォルト`on`）。

```bash
# メタデータ/プライベートIP帯への外向き通信を遮断（推奨）
CLOOPY_FIREWALL=on

# キルスイッチ: 全 egress フィルタを無効化
# 接続できなくなった時の緊急避難用。クラウドVMでは使わないこと
CLOOPY_FIREWALL=off
```

## Commands

2回目以降も `./manage.sh`（Windows: `manage.bat`）を実行すると対話メニューが開きます。\
起動・停止・SSH接続・ログ確認・リビルド・リセット等すべてメニューから操作可能です。

<details>
<summary>docker composeを直接使う場合</summary>

```bash
docker compose up -d          # 起動
docker compose down            # 停止
docker compose logs -f         # ログ確認
ssh cloopy                     # SSH 接続

# リセット（ホーム&Nixを初期化、ワークスペースは保持）
docker compose down
docker volume rm cloopy_home-data cloopy_nix-store
```

</details>

## Architecture

```
SSH → svc-sshd (longrun)
       ↑ depends on
     init-ssh-keys → init-permissions ← base
                          ↓ also depends
                     svc-bootstrap (oneshot: Nix/Devbox)
                     init-workspace-check
```

sshdとbootstrapは並列実行。\
SSHはbootstrap完了前に接続可能です。

## 脅威モデル

cloopyは「70点の防御を簡単に」を方針にしています。完璧なサンドボックスではなく、現実的な手間で被害を大きく減らすことを狙います。

### ネットワーク隔離（egress firewall）

コンテナ内のiptables/ip6tablesで外向き通信を制限します。段階的に強化していく設計です。

- **Phase 1 ローカル遮断（実装済み・常時有効）**
  - クラウドのメタデータサービス（`169.254.169.254`、Alibaba `100.100.100.200`）への通信を遮断
  - プライベートIP帯（`10/8`・`172.16/12`・`192.168/16`・CGNAT `100.64/10`・IPv6 ULA）への通信を遮断
  - 公開インターネットへの通信はそのまま。SSH・DNS・確立済み接続は壊さない
- **Phase 2 怪しい通信（予定）** — クリプトマイナーや独自C2が使う怪しいポートを遮断
- **Phase 3 許可リスト（予定）** — deny-all＋ドメインallowlistで「許可した宛先だけ」に絞る

#### 防げること

- 流出した認証情報やソースコードの**メタデータサービス経由の窃取**（IMDS credential theft）
- コンテナから**ホストの社内ネットワーク／プライベートサービスへの横移動**（lateral movement）

#### 防げないこと（限界）

- **悪意あるパッケージの「実行」そのもの** — ファイアウォールは実行後の流出を抑える手段で、実行自体は防げません
- **公開インターネット経由のデータ流出** — Phase 1は公開宛先を制限しません（Phase 3のallowlistで対応予定）
- **NET_ADMIN権限を悪用したファイアウォール無効化** — コンテナ内に`NET_ADMIN`が残るため、悪意あるコードが`iptables -F`でルールを消せる可能性があります。これは`./manage.sh`一発の体験を優先した結果のトレードオフです
- **DNS over TLS/HTTPS でプライベートリゾルバを使う構成** — `:53`の素のDNSはリゾルバ宛てに許可しますが、`853`(DoT)/`443`(DoH)でプライベートIP上のリゾルバを使う場合は遮断されます
- **起動直後のわずかな窓** — SSHはファイアウォール適用前に接続可能になるため、起動から数秒間はルール未適用の時間があります

> `CLOOPY_FIREWALL=off` または `cap_add: NET_ADMIN` の削除でファイアウォールを完全に無効化できます。接続できなくなった場合の緊急避難用ですが、クラウドVM上ではメタデータサービスが再露出するため使わないでください。

## License

MIT
