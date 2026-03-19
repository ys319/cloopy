<p align="center">
  <img src="assets/logo.png" alt="cloopy" width="400">
</p>

<p align="center">Claude Code向けのバッテリー付属コンテナ環境。<br>セットアップ一発で、VS Code Remote SSHからClaudeと開発を始められます。</p>

## なぜ cloopy？

Claude Codeをホストで直接動かすと、エージェントが意図せずシステムファイルを操作したり、侵害されたパッケージがホスト全体に影響するリスクがあります。かといって複雑なサンドボックスを毎回手作りするのも現実的ではありません。

cloopyはその中間を目指しています。

- **被害範囲を限定する** — Claude Codeが暴走しても、サプライチェーン攻撃を受けても、影響はコンテナの中に収まる
- **攻撃面が小さい** — アクセス手段はSSHのみ。DockerソケットやホストのファイルシステムをClaudeに渡さない
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

## License

MIT
