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

| Tool | Purpose |
|------|---------|
| Nix + Devbox | Claudeが必要なツールを自分で入れるための道具箱 |
| Volta | Node.jsバージョン管理 |
| Node.js LTS | 起動ごとに最新LTSに自動更新 |
| PNPM | パッケージマネージャ |
| Zsh (grml) | デフォルトシェル |

## Customization

### docker-compose.local.yml

ローカル固有の設定はこのファイルに書きます（.gitignore対象）。
テンプレートが同梱されているのでコメントを外して使ってください。

```bash
# Claude Teamの認証情報をホストから共有する例
services:
  sandbox:
    volumes:
      - ~/.claude:/home/developer/.claude
```

### .env

`.env.example`を`.env`にコピーして編集。すべてオプションです。

### custom/init.d/

`custom/init.d/*.sh`にスクリプトを置くと、起動時にrootで実行されます。

## Commands

2回目以降も `./manage.sh`（Windows: `manage.bat`）を実行すると対話メニューが開きます。
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
SSH → sshd (longrun)
       ↑ depends on
     init-custom → init-ssh-keys → init-permissions ← base
                                        ↓ also depends
                                   svc-bootstrap (Nix/Devbox/Volta/Node/PNPM)
                                   init-workspace-check
```

sshdとbootstrapは並列実行。SSHはbootstrap完了前に接続可能です。

## License

MIT
