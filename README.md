<p align="center">
  <img src="assets/logo.png" alt="cloopy" width="400">
</p>

<p align="center">Claude Code向けのバッテリー付属コンテナ環境。<br>セットアップ一発で、VS Code Remote SSHからClaudeと開発を始められます。</p>

## なぜ cloopy？

Claude Codeをホストで直接動かすと、エージェントが意図せずシステムファイルを操作したり、侵害されたパッケージがホスト全体に影響するリスクがあります。かといって複雑なサンドボックスを毎回手作りするのも現実的ではありません。

cloopyはその中間を目指しています。

- **被害範囲を限定する** — Claude Codeが暴走しても、サプライチェーン攻撃を受けても、影響はコンテナの中に収まる
- **攻撃面が小さい** — アクセス手段はSSHのみ。DockerソケットやホストのファイルシステムをClaudeに渡さない
- **送信先も絞る** — egressはデフォルトdeny-all。許可ドメインだけを通し、クラウドメタデータやプライベートIPは常時遮断
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

## ネットワーク隔離（egressファイアウォール）

cloopyは既定でコンテナ内egressを **deny-all + allowlist** で制限します。許可されているのはGitHub・npm・PyPI・Anthropic API・Nix/Devboxなど開発に必要な定番ドメインのみ（[`docker/firewall/allowed-domains.txt`](docker/firewall/allowed-domains.txt)）。

加えて、ファイアウォールon/offに関わらず常時ブロックするものがあります：

| 対象 | 理由 |
| ---- | ---- |
| クラウドメタデータ (`169.254.169.254`, Alibaba `100.100.100.200`) | IAMクレデンシャル窃取の最大級リスクを1〜2行で潰せる |
| RFC1918 / CGNAT (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`) | ホストや社内ネットワークへのlateral movement防止 |
| IPv6 OUTPUT 全部 | IPv4側allowlistを迂回されないよう塞ぐ |

### 追加ドメインを許可する

`.env`で指定します（カンマ区切り）：

```
CLOOPY_EXTRA_DOMAINS=mycompany.example.com,internal.api.com
```

### ファイアウォールを無効化する

`.env`で`CLOOPY_FIREWALL=off`にすると、上記の常時DROPは残したままallowlist制限だけ外れます。

### この防御で守れること・守れないこと

**守れる:**
- 漏洩済みクレデンシャルや侵害されたnpmパッケージによるexfiltration（任意ドメインにPOSTできない）
- クラウドVM上で動かしている場合のメタデータ経由のIAM credential窃取
- Tailscale/社内VPN経由のlateral movement
- クリプトマイナーのstratum接続（非標準ポートを塞ぐ）

**守れない（設計上の限界）:**
- **悪意あるパッケージの「実行」自体** — `registry.npmjs.org`を許可した時点で、そこから取得したコードはコンテナ内で動きます。ファイアウォールはあくまで「実行後のexfiltration」を塞ぐ手段です
- **DoH（DNS over HTTPS）経由の流出** — `1.1.1.1:443`のようなIPを許可ドメインが指していれば抜け道になりえます
- **NET_ADMIN権限を悪用したFW無効化** — コンテナ内に`NET_ADMIN`があるため、攻撃者は`iptables -F`できます。70点防御の意識的な妥協です（90点を目指すなら`docker-compose.local.yml`でcap_dropし、ホスト側でiptablesを書く別運用が必要）

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
                     init-workspace-check
                     init-firewall (iptables/ipset egress)
                          ↓ also depends
                     svc-bootstrap         (oneshot: Nix/Devbox)
                     svc-firewall-refresh  (longrun: ipset 再解決)
```

sshdとbootstrapは並列実行。SSHはbootstrap完了前に接続可能です。\
bootstrap（Nix/Devboxインストール）はinit-firewall完了後に走るため、初回ダウンロードもallowlist経由になります。

## License

MIT
