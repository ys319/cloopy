# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

cloopy は Claude Code 専用のバッテリー付属 Docker コンテナ開発環境。セットアップ一発で VS Code Remote SSH から Claude と開発を始められる。

> **注意**: `assets/CLAUDE.md` はコンテナ内で Claude に渡される別ファイル（日本語応答・Devbox 使用の指示）。このファイルとは役割が異なる。

## Commands

```bash
./manage.sh    # macOS/Linux
manage.bat     # Windows
```

対話メニューからセットアップ・起動・停止・SSH接続・リビルド・リセット等すべて操作可能。

## Architecture

### CLI（Deno + Cliffy）

`manage.sh` / `manage.bat` → Deno をプロジェクトローカル（`.deno/`）に自動インストール → `cli/main.ts` を実行。

引数なしの場合 `doctor()` → `setup()` → `manage()` の順に実行される。`doctor` が問題なしと判定すれば `setup` はスキップ。

`cli/lib/compose.ts` は `docker-compose.local.yml` が存在すれば自動で `-f` オプションに追加する。

### Docker コンテナ（Ubuntu 24.04 + s6-overlay）

s6-overlay が PID 1 として動作し、以下のサービスツリーで初期化する：

```
s6-overlay (PID 1)
├── init-permissions    (oneshot) UID/GID 調整、ボリューム chown
├── init-ssh-keys       (oneshot, depends: init-permissions) authorized_keys 検証、sshd 設定
├── init-workspace-check(oneshot, depends: init-permissions) ワークスペース UID 不一致警告
├── svc-bootstrap       (longrun, depends: init-permissions) Nix/Devbox/Volta/Node LTS/PNPM
└── svc-sshd            (longrun, depends: init-ssh-keys) SSH デーモン
```

sshd と bootstrap は並列実行。SSH は bootstrap 完了前に接続可能。
