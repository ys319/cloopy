<p align="center">
  <img src="assets/logo.png" alt="cloopy" width="400">
</p>

<p align="center">Claude Code向けのバッテリー付属コンテナ環境。<br>セットアップ一発で、VS Code Remote SSHからClaudeと開発を始められます。</p>

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

## What's Inside

| Tool         | Purpose                                          |
| ------------ | ------------------------------------------------ |
| Nix + Devbox | Claudeが必要なツールを自分で入れるための道具箱   |
| Volta        | Node.jsバージョン管理（devbox globalで導入済み） |
| Zsh (grml)   | デフォルトシェル                                 |

## Customization

### docker-compose.local.yml

初回セットアップ時に自動生成されます（.gitignore対象）。
ローカル固有のオーバーライドを自由に追記できます。

```yaml
# Claude Teamの認証情報をホストから共有する例
services:
  sandbox:
    volumes:
      - ~/.claude:/home/developer/.claude
```

### .env

初回セットアップ時に`.env.example`をもとに自動生成されます。
生成後は手動で編集可能です。すべてオプションです。

## Commands

2回目以降も `./manage.sh`（Windows:
`manage.bat`）を実行すると対話メニューが開きます。
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
                     svc-bootstrap (oneshot: Nix/Devbox/Volta)
                     init-workspace-check
```

sshdとbootstrapは並列実行。SSHはbootstrap完了前に接続可能です。

## License

MIT
