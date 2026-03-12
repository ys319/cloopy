# cloopy

Claude Code 専用のバッテリー付属コンテナ環境。
セットアップ一発で、VS Code Remote SSH から Claude と開発を始められます。

## Quick Start

```bash
# Windows
manage.bat

# Linux / macOS / Git Bash
./manage.sh
```

これだけで：
1. SSH 鍵を自動生成
2. Docker イメージをビルド & 起動
3. SSH Config に `cloopy` エントリを注入

あとは VS Code で Remote SSH → `cloopy` に接続するだけ。

## What's Inside

| Tool | Purpose |
|------|---------|
| Nix + Devbox | Claude が必要なツールを自分で入れるための道具箱 |
| Volta | Node.js バージョン管理 |
| Node.js LTS | 起動ごとに最新 LTS に自動更新 |
| PNPM | パッケージマネージャ |
| Zsh (grml) | デフォルトシェル |

## Customization

### docker-compose.local.yml

ローカル固有の設定はこのファイルに書きます（.gitignore 対象）。
テンプレートが同梱されているのでコメントを外して使ってください。

```bash
# Claude Team の認証情報をホストから共有する例
services:
  sandbox:
    volumes:
      - ~/.claude:/home/developer/.claude
```

### .env

`.env.example` を `.env` にコピーして編集。すべてオプションです。

### custom/init.d/

`custom/init.d/*.sh` にスクリプトを置くと、起動時に root で実行されます。

## Commands

2回目以降も `./manage.sh`（Windows: `manage.bat`）を実行すると対話メニューが開きます。
起動・停止・SSH接続・ログ確認・リビルド・リセット等すべてメニューから操作可能です。

<details>
<summary>docker compose を直接使う場合</summary>

```bash
docker compose up -d          # 起動
docker compose down            # 停止
docker compose logs -f         # ログ確認
ssh cloopy                     # SSH 接続

# リセット（ホーム & Nix を初期化、ワークスペースは保持）
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

sshd と bootstrap は並列実行。SSH は bootstrap 完了前に接続可能です。

## License

MIT
