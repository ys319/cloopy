---
group: E
topic: ドキュメント整合
files_reviewed: 7
date: 2026-06-10
model: sonnet
---

# Group E: ドキュメント整合

## サマリ

- ドキュメントと実装の乖離は 6 件。最重要は CLAUDE.md の `svc-bootstrap` 説明に残る Volta の誤記（Volta は以前のコミットで削除済み）と、README の Architecture 図からの `init-firewall` サービス欠落、および README の手動リセットコマンドで `ssh-config` ボリュームが抜けていること。`assets/CLAUDE.md` の英語規約・実装整合は問題なし。`.gitignore` も適切。
- 重大度件数: 🟢 0 / 🔵 3 / 🟡 2 / 🔴 0 / 💣 0
- ドキュメント軸: 🟣 6（全件 Doc 軸）
- タグ別: 🤖 5 / 🙋 1

## ファイル別分類

| 分類 | ファイル | 一言コメント |
|---|---|---|
| 🟣 Doc 🔵 Low | `README.md:128-135` | Architecture 図に `init-firewall` サービスが欠落 |
| 🟣 Doc 🟡 Warning | `README.md:114` | 直接 `docker compose up` 例に `--build` がなく git pull 後に古いイメージで起動する恐れ |
| 🟣 Doc 🔵 Low | `README.md:119-122` | リセットコマンドで `cloopy_ssh-config` ボリュームが欠落 |
| 🟣 Doc 🟡 Warning | `CLAUDE.md:48` | `svc-bootstrap` 説明に `Volta` の記述が残存（削除済み） |
| 🟣 Doc 🔵 Low | `.env.example:42` | OpenDNS の IPv6 アドレスが非記載（`settings.ts` では定義済み）|
| 🟢 Safe | `assets/CLAUDE.md` | 完全英語、コンテナ実態（zsh/developer/workspace パス）と一致 |
| 🟢 Safe | `.gitignore` | `.env`/`.deno/`/`workspace/*`/`docker-compose.local.yml`/`backups/` を適切に除外 |
| 🟢 Safe | `workspace/.vscode/extensions.json` | 内容軽微かつ問題なし |

> Doc は重大度と独立軸。

## 詳細指摘

### 🟣 D-E-1 🤖: `svc-bootstrap` 説明に Volta の記述が残存

- **対象**: `CLAUDE.md:48`
- **症状**: `svc-bootstrap (oneshot, depends: init-permissions) Nix/Devbox/Volta` と記述されているが、`docker/s6-overlay/scripts/bootstrap.sh` には Volta のインストール処理が存在しない。コミット `8b27daa`（"refactor: Volta 削除"）で bootstrap から削除されたが CLAUDE.md が更新されなかった。
- **根拠**: `bootstrap.sh` 全文に `volta` / `Volta` の文字列ゼロ件（`grep` 確認済み）。`README.md` の `What's Inside` テーブルにも Volta の記載なし。
- **修正案**: `CLAUDE.md:48` の `Nix/Devbox/Volta` を `Nix/Devbox` に変更（🤖）

---

### 🟡 W-E-1 🙋: README の直接 `docker compose up` 例に `--build` フラグがない

- **対象**: `README.md:114`
- **症状**: `docker composeを直接使う場合` の折りたたみセクション内に `docker compose up -d` とだけ記載されており、`--build` がない。
- **根本原因**: CLI（`cli/lib/constants.ts:21-29`）は `COMPOSE_UP_ARGS` に常に `--build` を含め、`git pull` 後でも旧イメージで起動しないよう設計されている。README の直接コマンド例がこの設計意図を反映していない。README を参照して手動で起動したユーザーが git pull 後に旧イメージ＋新 s6 スクリプトの不整合で起動失敗する可能性がある。
- **修正案 A**（推奨）: コマンドを `docker compose up -d --build` に変更し、「キャッシュが効くので通常数秒」等の注記を添える（🤖）
- **修正案 B**: セクション冒頭に「git pull 後は `--build` を付けること」の警告を追記する
- **備考**: CLAUDE.md:72 にも同趣旨の記述はあるが、README 単独で参照するユーザーには届かない。

---

### 🟣 D-E-2 🤖: README Architecture 図に `init-firewall` が欠落

- **対象**: `README.md:128-135`
- **症状**: Architecture 図に `init-permissions`・`init-ssh-keys`・`svc-bootstrap`・`init-workspace-check`・`svc-sshd` は記載されているが、`init-firewall` が完全に欠落している。
- **根拠**: `docker/s6-overlay/s6-rc.d/init-firewall/` が存在し、`type=oneshot`、`dependencies.d/init-permissions` をもつ実在のサービス。CLAUDE.md のサービスツリーには正しく記載済み（`CLAUDE.md:47`）。
- **修正案**: README の Architecture 図に `init-firewall` を追加。位置は `init-permissions` の子（`svc-bootstrap` や `init-workspace-check` と並列）。例：

```
SSH → svc-sshd (longrun)
       ↑ depends on
     init-ssh-keys → init-permissions ← base
                          ↓ also depends
                     svc-bootstrap (oneshot: Nix/Devbox)
                     init-workspace-check
                     init-firewall (oneshot: egress firewall)
```

（🤖）

---

### 🟣 D-E-3 🤖: README 手動リセットコマンドで `ssh-config` ボリュームが欠落

- **対象**: `README.md:119-122`
- **症状**: 手動リセットの例が `docker volume rm cloopy_home-data cloopy_nix-store` と記載されているが、`ssh-config` ボリュームが含まれていない。
- **根拠**: `docker-compose.yml:71-74` のボリューム定義は `ssh-config` / `home-data` / `nix-store` の 3 つ。CLI の実際のリセット処理（`manage.ts:492`）は `docker compose down -v` で全ボリュームを一括削除し、出力メッセージにも `ssh-config (SSH ホスト鍵)` を含む（`manage.ts:484`）。
- **影響**: 手動コマンドで `ssh-config` が残ると、完全リセットのつもりが SSH ホスト鍵だけ生き残り、次回起動後に `ssh cloopy` で「ホスト鍵不一致」警告が出る場合がある。
- **修正案**: コマンドを以下のいずれかに変更（🤖）
  - `docker compose down -v`（全ボリュームを一括削除、CLI と同等）
  - `docker volume rm cloopy_home-data cloopy_nix-store cloopy_ssh-config`（明示列挙）
  - コメントも `ホーム・Nix・SSH ホスト鍵を初期化` に更新する

---

### 🟣 D-E-4 🤖: `.env.example` の OpenDNS プリセット行に IPv6 アドレスが記載されていない

- **対象**: `.env.example:42`
- **症状**: `.env.example` のプリセット一覧コメントには `Cloudflare`（v6 記載あり）と `Quad9`（v6 記載あり）があるが、`Cisco OpenDNS` 行に IPv6 アドレスが記載されていない。
- **根拠**: `cli/commands/settings.ts:29-33` には OpenDNS の IPv6 アドレス `2620:119:35::35` / `2620:119:53::53` が定義されており、プリセット選択で設定される。`.env.example` を参照して手動設定するユーザーには IPv6 アドレスが分からない。
- **修正案**: `.env.example:42` の OpenDNS 行に `(v6 2620:119:35::35 / 2620:119:53::53)` を追記（🤖）

---

## 重要な設計の可視化

該当なし（突き合わせ中心のレビューのため省略）。

## 横断観点での所見

- **設計境界**: `assets/CLAUDE.md` は完全に英語で書かれており、コンテナ内の実態（`/home/developer/workspace`・zsh・Devbox 中心）とも整合している。英語規約は守られている。
- **リソース所有権**: `.gitignore` は `.env`・`.deno/`・`workspace/*`・`docker-compose.local.yml`・`backups/` を適切に除外しており、機密ファイルや生成物の漏洩リスクはない。
- **テスト網羅**: ドキュメントレビュー対象のため省略。
- **ドキュメント整合**: 最大の問題は Volta の誤記（D-E-0 相当）と README Architecture 図の `init-firewall` 欠落。いずれも機械的修正で解消できる。`CLOOPY_DNS_V6_*` 変数は CLAUDE.md・docker-compose.yml・.env.example・settings.ts で一貫しており、名前の揺れはない。SSH ポート 10022・インスタンス名 cloopy の用語は全ファイルで統一されている。
- **方針転換の記録**: CLAUDE.md・README ともに allowlist/ポート遮断廃止の経緯が正しく記録されており、実装（`init-firewall.sh`）の 2 層構成（ローカル遮断＋ DNS ピン留め）と整合している。
