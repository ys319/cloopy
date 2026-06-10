---
title: cloopy 包括コードレビュー — サマリ
date: 2026-06-10
head: 6ca8102
prev_review: なし（初回レビュー）
mode: A
reviewer: claude (orchestrator + 7 parallel agents + 1 pass-2 agent)
---

# cloopy 包括コードレビュー — サマリ

## 実施概要
- モード: A（全体網羅 + ユーザー指定の追加4観点: エラーハンドリング/回復・セキュリティ向上・Rootless Podman 可否・リモート接続+SSH 鍵管理）
- 対象: 初回レビューのためプロジェクト全域（HEAD = `6ca8102`、作業ツリー clean）。除外: `assets/logo.png` / `cli/deno.lock` / `docker/vendor/grml-zshrc` / `LICENSE`
- モデル配分: A=Sonnet / B=Sonnet / C=Opus / D=Sonnet / E=Sonnet / F=Opus / G=Opus / Pass2=Opus
- Pass 2 実施: **あり** — Group A に 🔴×3 + 💣×1 が集中（§7 トリガ該当）。Opus で敵対的検証 → E-A-1/2/3 は 🟡 へ格下げ、C-A-1 は 💣 確定（[group-A2-pass2-verification.md](group-A2-pass2-verification.md)）
- エージェント違反検知: **無し**（全エージェント完了後に git log/status/diff を確認。コミット・コード変更ゼロ、レポート書き出しのみ）
- ゲート状況（修正前 / 後）: `deno lint` 0 errors / 0、`deno fmt --check` 0 / 0、`deno test`（CWD=cli）19 passed / **25 passed**。※ CI の `deno test cli/`（ルート実行）は TS2307×11 で失敗することをローカル再現 → 本セッションで修正（E-D-1）。GitHub Actions の実行結果はサンドボックスの TLS 制約で未確認

## グループ別レポート
| グループ | 範囲 | モデル | レポート |
|---|---|---|---|
| A | CLI コマンド層 + エントリポイント | sonnet | [group-A-cli-commands.md](group-A-cli-commands.md) |
| A2 | Pass 2: Group A 重大指摘の敵対的検証 | opus | [group-A2-pass2-verification.md](group-A2-pass2-verification.md) |
| B | CLI ライブラリ層 | sonnet | [group-B-cli-lib.md](group-B-cli-lib.md) |
| C | Docker / s6-overlay / compose インフラ | opus | [group-C-docker-infra.md](group-C-docker-infra.md) |
| D | テスト品質横断 + CI | sonnet | [group-D-test-quality.md](group-D-test-quality.md) |
| E | ドキュメント整合 | sonnet | [group-E-docs.md](group-E-docs.md) |
| F | Rootless Podman フィージビリティ | opus | [group-F-podman-feasibility.md](group-F-podman-feasibility.md) |
| G | リモート接続 + SSH 鍵管理フィージビリティ | opus | [group-G-remote-and-keys.md](group-G-remote-and-keys.md) |

## 全体評価
| 観点 | 評価 | 備考 |
|---|---|---|
| 設計境界（CLI → compose → s6） | 良 | 責務分離は明瞭。docker 直書きが 12 箇所ある点は Podman 対応判断（F）に影響 |
| エラーハンドリング/回復 | 中→良 | 回復経路自体は存在（doctor/manage 経由）。欠けていたのは案内と検証で、今回大半を修正 |
| セキュリティ（コンテナ/ネット） | 良 | 2層 firewall は設計通り。残課題は供給鎖（W-C-3）と bind mount への chown 再帰（E-C-1） |
| テスト品質 | 中 | lib 層は良。ssh.ts（config 注入）が完全未テストなのが最大の穴（W-D-3） |
| ドキュメント整合 | 良 | 乖離は軽微 6 件、全て本セッションで修正済み |

## 💣 Critical 一覧（Pass 2 確定後）
| ID | ファイル | 内容 | 状態 | タグ |
|---|---|---|---|---|
| C-A-1 | cli/commands/manage.ts:480 | reset の `down -v` が「ワークスペースは保持」の案内に反して workspace-data（作業データ）を削除 | ✅ **修正済み** `6a6f31b` | 🙋→即決修正 |

## 🔴 Error 一覧（Pass 2 確定後）
| ID | ファイル | 内容 | 状態 | タグ |
|---|---|---|---|---|
| E-C-1 | docker/s6-overlay/scripts/init-permissions.sh:87 | `chown -R /home/developer` が配下の bind mount（workspace / .zshenv / .claude/CLAUDE.md）に再帰し、UID 変更時にホスト実ファイルの所有権を書き換える | 📋 ROADMAP（実機検証必須のため） | 🙋 |
| E-D-1 | .github/workflows/ci.yml:31 | `deno test cli/` ルート実行は cli/deno.json が発見されず TS2307 で失敗 | ✅ **修正済み** `6b25718` | 🙋 |

## 🟡 Warning 主要（全件は各 group レポート参照）
| ID | ファイル | 内容 | 状態 |
|---|---|---|---|
| W-B-2 | cli/lib/workspace.ts | シンボリックリンク経由で $HOME 検証を迂回可（uCore の /home→/var/home で実害） | ✅ 修正済み `2b9800f` |
| W-A-4 | cli/commands/settings.ts | カスタム DNS に IPv4 検証なし → typo で名前解決全断（攻撃面は無し・Pass 2 検証済み） | ✅ 修正済み `dff7a81` |
| E-A-1→🟡 | cli/commands/setup.ts | 対話デフォルトが .env 保存値を無視（Deno.env のみ参照） | ✅ 修正済み `dff7a81` |
| E-A-2→🟡 | cli/commands/setup.ts | 起動失敗時の次アクション案内不足（回復経路自体は存在） | ✅ 案内追加 `dff7a81` |
| W-A-1/W-A-5 | manage.sh | unzip 失敗で壊れた deno が残留・unzip 未導入時の無言失敗 | ✅ 修正済み `87999b0` |
| W-B-3/W-B-4 | cli/lib/env.ts | CRLF 混在・空ファイル先頭空行 | ✅ 修正済み `933ea82` |
| W-C-1 | init-permissions.sh:54 | usermod フォールバックの -g 欠落 | ✅ 修正済み `1592989`（実機未検証） |
| W-D-1 | cli/lib/compose_test.ts | テスト名「suppresses log」が抑制を未検証 | ✅ 修正済み `8ede0c6` |
| E-A-3→🟡 | cli/commands/manage.ts | インスタンス名変更で旧ボリューム孤立・警告なし（ディスク消費のみ） | 📋 ROADMAP |
| W-C-2 | init-firewall.sh:177-269 | DNS ピンが v4/v6 独立判定 — 片系のみ設定だと他系 :53 素通り | 📋 ROADMAP |
| W-C-3 | docker/Dockerfile:53-62 | s6-overlay tarball をチェックサム未検証で PID 1 実行（供給鎖） | 📋 ROADMAP |
| W-C-4 | init-permissions.sh:13-14 | PUID/PGID 境界値（0=root 化・非数値）未検証 | 📋 ROADMAP |
| W-A-2 / W-A-3 | cli/commands/manage.ts | logs の raw モード残留疑い / restore 失敗時の修復経路 | 📋 ROADMAP |
| W-B-1 + W-D-3 | cli/lib/ssh.ts | injectSshConfig 失敗時の巻き戻しなし + テストゼロ（SSH 破損直結の最大カバレッジ穴） | 📋 ROADMAP |
| W-D-2 / W-D-4 | テスト | $HOME 親拒否・BEGIN-only エッジのテスト欠落 | ✅ 追加済み `2b9800f` / `933ea82` |
| W-E-1 | README.md | 手動 up に --build なし | ✅ 修正済み `5491b2c` |

## 🟣 Doc 一覧
D-E-1〜4 / D-C-1〜3 / D-B-1〜2 / D-A-1〜3 / D-D-1〜2 の 13 件 → **全件修正済み**（`5491b2c` ほか各コミット。D-C-3 は記載でなくガード追加で根治、D-A-1 は UI ヒント追加）。

## ✅ 件数集計（Pass 2 反映後）
### 重大度軸
| グループ | 🟢 | 🔵 | 🟡 | 🔴 | 💣 |
|---|---|---|---|---|---|
| A (+A2) | 2 | 1 | 8 | 0 | 1 |
| B | 2 | 3 | 4 | 0 | 0 |
| C | 5 | 4 | 4 | 1 | 0 |
| D | 3 | 3 | 4 | 1 | 0 |
| E | 4 | 3 | 2 | 0 | 0 |
| F/G（調査） | - | - | 5 (W-G-1〜5) | 0 | 0 |
| **計** | **16** | **14** | **27** | **2** | **1** |

### ドキュメント軸 / タグ集計
| グループ | 🟣 | 🤖 | 🙋 |
|---|---|---|---|
| A | 3 | 8 | 4 |
| B | 2 | 5 | 4 |
| C | 3 | 2 | 8 |
| D | 2 | 3 | 4 |
| E | 6 | 5 | 1 |
| F/G | 0 | 0 | 多数（設計判断） |
| **計** | **16** | **23** | **21+** |

## 過去レビューからの進捗
初回レビューのため該当なし。直近の活動傾向: firewall 2 層化（f964998→938acb5）、CLI 信頼性/設定メニュー（f3ee8cc, 8139a02）、SELinux/uCore 対応（6ca8102）。

## 🛠️ 本セッションで実施した修正（9 コミット）
| コミット | 内容 | 対応 ID |
|---|---|---|
| `6a6f31b` | reset の workspace-data 削除（データ喪失）修正 | C-A-1, D-E-3 |
| `6b25718` | CI の deno test ルート実行失敗を修正 | E-D-1, L-D-2, D-D-1 |
| `933ea82` | setEnvVar の CRLF/空ファイル修正 + テスト | W-B-3, W-B-4, W-D-4, D-B-2 |
| `2b9800f` | ワークスペース検証のシンボリックリンク対応 + テスト | W-B-2, W-D-2 |
| `dff7a81` | setup デフォルトの .env 優先・DNS IPv4 検証・失敗時案内 | E-A-1, E-A-2, W-A-4, D-A-1 |
| `87999b0` | Deno インストーラ堅牢化・-UseBasicParsing | W-A-1, W-A-5, D-A-2, D-A-3 |
| `1592989` | usermod -g 欠落・.zshenv devbox ガード | W-C-1, D-C-3 |
| `8ede0c6` | quiet ログ抑制テストの実検証化 | W-D-1 |
| `5491b2c` | ドキュメント乖離の一括修正 | D-E-1〜4, W-E-1, D-C-1〜2, D-B-1, D-D-2 |

- 修正前後のテスト: 19 → **25 passed / 0 failed**（lint/fmt クリーン維持）
- 🙋 ROADMAP 送り: 16 項目（[ROADMAP.md](ROADMAP.md)）
- **実機検証が必要な変更**: `1592989`（init-permissions / .zshenv はコンテナ起動でのみ検証可能。bash -n / zsh -n は通過済み）。次回 uCore/macOS での起動 + `ssh cloopy` 疎通確認を推奨

## アクションアイテム（推奨優先順）
1. **E-C-1**（chown -R の bind mount 再帰）— ホスト破壊系の残り 1 件。/proc/mounts から $USER_HOME 配下のマウントポイントを除外する修正案を ROADMAP に記載。実機検証とセットで
2. **W-B-1 + W-D-3**（injectSshConfig の堅牢化とテスト）— SSH 破損に直結する最大のカバレッジ穴
3. **W-C-3**（s6-overlay チェックサム検証）— Dockerfile に sha256 ピン留め。ビルド検証が必要
4. **G: 鍵管理 Phase 1**（複数鍵束ファイル + ペースト追加）— 既存 staged-copy 設計と相性が良く半日規模。リモート接続の前提
5. **W-C-2**（DNS ピン v4/v6 対称性）— firewall 意味論の判断 + test/firewall-dns.sh 拡張とセットで

## 次回レビューでの対応指針
- 今回 ROADMAP 送りの 🙋 16 件の解消検証から開始
- `1592989` の実機検証結果を確認（未検証なら最優先で）
- ssh.ts はテスト追加後に Sonnet で再レビュー、それまで 🔵 扱い
- F（Podman）は「uCore で docker 同梱が崩れる」「pasta 下で iptables 動作の実機確認が取れる」のいずれかで再評価

## 検査メソッドのメモ
- Sonnet の Group A は重大度を過大評価する傾向（🔴×3 → Pass 2 で全て 🟡 へ）。一方 💣 C-A-1 は Sonnet が正しく検出・Opus が確定。**「E/C 集中時の Pass 2」は有効に機能した**
- Opus の Group C はホスト破壊系（E-C-1）を一発で当てた。boot スクリプト系は次回も Opus 固定が妥当
- フィージビリティ調査（F/G）を通常レビューと同時並列にする構成は機能した。Web 裏取り付きの結論（Podman Tier 0 / 鍵管理 Phase 1-3)が一晩で揃った
- docker が動かないサンドボックスのため、コンテナ側修正は bash -n + 静的検証のみ。**boot スクリプトの修正は最小限に絞り、大物（E-C-1）は ROADMAP に送る判断とした**
