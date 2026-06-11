---
title: cloopy 包括コードレビュー — サマリ
date: 2026-06-11
head: 742f83e
prev_review: .claude/reviews/2026-06-10_6ca8102
mode: A
reviewer: claude (orchestrator + 6 parallel agents)
---

# cloopy 包括コードレビュー — サマリ

## 実施概要
- モード: A（前回レビュー以降の差分中心 + テスト品質横断 + 全領域カバー）
- 対象: `6ca8102..742f83e` の 24 コミット。主役は G Phase 1〜3（鍵管理 keys.ts /
  リモート接続 remote.ts / 標準 known_hosts 化 ssh.ts ±495 行）、manage 2 階層
  メニュー再編、Dockerfile sha256 ピン、init-permissions の mountinfo 除外。
  除外: `workspace/`（別プロジェクトのマウント）/ `.deno*` / `cli/deno.lock` /
  `docker/vendor/` / `.claude/reviews/`
- モデル配分: A=Opus / B=Sonnet / C=Opus / D=Sonnet / E=Opus / F=Sonnet
- Pass 2 実施: **なし** — §7 トリガ非該当（🔴/💣 全グループでゼロ、不変条件系
  グループは第 1 パスから Opus、断定不能点はすべて docker 不可サンドボックス起因の
  実機検証系のみ）
- エージェント違反検知: **無し**（全 6 エージェント完了後に git log/status/diff を
  確認。コミット・コード変更ゼロ、レポート書き出しのみ）
- ゲート状況（修正前 / 後）: `deno lint` 0 / 0、`deno fmt --check` 0 / 0、
  `deno test`（CWD=cli、サンドボックスでは `-A` 明示が必要）83 passed / **87 passed**。
  `deno check` はサンドボックスのプロキシ制約で依存 DL 不可のため未完走
  （テストのコンパイル通過で型は健全と判断）

## グループ別レポート
| グループ | 範囲 | モデル | レポート |
|---|---|---|---|
| A | ssh.ts known_hosts / SSH config 注入コア | opus | [group-A-ssh-core.md](group-A-ssh-core.md) |
| B | SSH 鍵管理（keys lib + command） | sonnet | [group-B-keys.md](group-B-keys.md) |
| C | リモート接続 + CLOOPY_SSH_BIND | opus | [group-C-remote-bind.md](group-C-remote-bind.md) |
| D | CLI コマンド層差分（manage 再編・setup/settings/doctor） | sonnet | [group-D-cli-commands.md](group-D-cli-commands.md) |
| E | Docker / s6-overlay / firewall / 起動スクリプト | opus | [group-E-docker-infra.md](group-E-docker-infra.md) |
| F | テスト品質横断 + CI + ドキュメント整合 | sonnet | [group-F-tests-ci-docs.md](group-F-tests-ci-docs.md) |

## 全体評価
| 観点 | 評価 | 備考 |
|---|---|---|
| G Phase 1〜3 の実装品質 | 良 | 開発時の敵対レビュー「修正済み 8 点」は全件実在を追試確認（group-C 付録）。HMAC フィクスチャも本物と独立再計算で確認 |
| 入力検証・セキュリティ境界 | 良〜中 | store 再検証・HTTPS 強制・指紋確認は健全。穴は keyscan の `--` 欠落（W-C-1）と `.env` 直編集経路（W-A-1）の深層防御のみ |
| Docker/s6 インフラ | 良 | E-C-1/W-C-1/W-C-3 解消を確認、sha256 は公式と実機照合。残るは E-C-1 の縁の低確率エッジ（W-E-3/L-E-3） |
| テスト品質 | 良 | 前回最大の穴（ssh.ts テストゼロ）が 27 本で解消。死んだ assertion なし。87/87 pass |
| ドキュメント整合 | 良 | CLAUDE.md の新セクション（鍵管理/known_hosts/SSH_BIND）は実装と一致。乖離はコメントレベル 11 件、本セッションで全消化 |

## 💣 Critical / 🔴 Error 一覧
**ゼロ件**（初回レビューの 💣1 / 🔴2 から改善。今回の最高重大度は 🟡）。

## 🟡 Warning 一覧（14 件）
| ID | ファイル | 内容 | 状態 | タグ |
|---|---|---|---|---|
| W-A-1 | cli/lib/ssh.ts:229 | `.env` 手編集の未検証インスタンス名が buildHostBlock に生補間（config injection 余地。対話パスは検証済み） | 📋 ROADMAP | 🙋 |
| W-A-2 | cli/lib/ssh.ts:406 | マーカー一致は host 非依存で行除去（設計どおり・暗黙前提の記録） | ✅ コメント明記で受容 `c574095` | 🙋 |
| W-B-1 | cli/lib/keys.ts:118 | truncated ssh-rsa blob が ok 扱い（sshd は無視 → 可用性誤認） | 📋 ROADMAP | 🙋 |
| W-B-2 | cli/commands/keys.ts:101 | store 保存後に束生成失敗で乖離（次回操作で再整合） | ✅ 順序根拠をコメント化 `c574095`・設計変更は不採用 | 🙋 |
| W-C-1 | cli/lib/remote.ts:114,146 | ハイフン始まり host を受理 + keyscan に `--` 無し（現状インジェクション不成立・深層防御の綻び） | 📋 ROADMAP | 🙋 |
| W-D-1 | cli/commands/setup.ts:220 | lanInput 残留初期値。**オーケストレータ判断で格下げ**: カスタム bind は非 localhost 公開なのでヒント表示自体は妥当 → 挙動維持のまま実効 bind 判定に書き換え | ✅ 修正済み `f23f7bf` | 🤖 |
| W-D-2 | cli/commands/manage.ts:152 | サブメニュー Select の ESC 不可（UX-2 の延長・悪化なし） | 📋 ROADMAP（UX-2 合流） | 🙋 |
| W-D-3 | cli/commands/setup.ts:265 | useVolume 既定が savedEnv を無視（E-A-1 修正の適用漏れ） | ✅ 修正済み `f23f7bf` | 🤖 |
| W-E-1 | init-firewall.sh:179,256 | DNS ピン v4/v6 独立判定（前回 W-C-2 再掲・未解決） | 📋 ROADMAP 継続 | 🙋 |
| W-E-2 | init-permissions.sh:13 | PUID/PGID 境界値未検証（前回 W-C-4 再掲・未解決） | 📋 ROADMAP 継続 | 🙋 |
| W-E-3 | init-permissions.sh:93 | host bind の source が `*/volumes/*/_data` を含むと named volume 誤判定 → chown がホストへ再帰（E-C-1 の縁・机上再現済み） | 📋 ROADMAP（実機検証必須） | 🙋 |
| W-F-1 | cli/lib/keys_test.ts:52 | `if (r.ok)` ナローイングガード（実害なし・assert() 置換は任意） | 受容（記録のみ） | 🙋 |
| W-F-2 | cli/lib/keys.ts ほか | validatePublicKeyInput / RSA_MIN_BITS / ensureEnvFile 未テスト | ✅ 前 2 者はテスト追加 `27f820c`・ensureEnvFile は対象外と整理 | 🙋 |
| （L-D-1 ほか 🔵 は各レポート参照） | | | | |

## 🟣 Doc 一覧（11 件）
D-A-1（テストで対応）/ D-A-2 / D-A-3 / D-B-1 / D-C-1 / D-D-1 / D-E-1 / D-E-2 /
D-F-1 / D-F-2 → **10 件修正済み**（`27f820c` `c574095` `f23f7bf`）。
D-C-2（doctor が `0.0.0.0:` の IPv6 脱落を案内しない）のみ ROADMAP（低）。

## ✅ 件数集計
### 重大度軸
| グループ | 🟢 | 🔵 | 🟡 | 🔴 | 💣 |
|---|---|---|---|---|---|
| A | 5 | 4 | 2 | 0 | 0 |
| B | 2 | 5 | 2 | 0 | 0 |
| C | 5 | 3 | 2 | 0 | 0 |
| D | 3 | 3 | 3 | 0 | 0 |
| E | 9 | 3 | 3 | 0 | 0 |
| F | 9 | 5 | 2 | 0 | 0 |
| **計** | **33** | **23** | **14** | **0** | **0** |

### ドキュメント軸 / タグ集計
| グループ | 🟣 | 🤖 | 🙋 |
|---|---|---|---|
| A | 3 | 0 | 3 |
| B | 1 | 2 | 2 |
| C | 2 | 0 | 3 |
| D | 1 | 3 | 1 |
| E | 2 | 1 | 7 |
| F | 2 | 2 | 3 |
| **計** | **11** | **8** | **19** |

## 過去レビューからの進捗（解消確認）
| 前回項目 | 状態 |
|---|---|
| W-B-1 + W-D-3（injectSshConfig 非アトミック + テストゼロ） | ✅ 解消を実証確認（writeFileAtomic + ssh_test 27 本、HMAC フィクスチャ本物） |
| E-C-1（chown -R の bind 再帰） | ✅ 解消（机上シミュレーションで除外動作確認。縁に W-E-3/L-E-3 の低確率エッジが残存） |
| W-C-1（usermod -g 欠落）/ W-C-3（s6 sha256） | ✅ 解消（sha256 3 値は公式 .sha256 と WebFetch 実機照合で完全一致） |
| G Phase 3 開発時の敵対レビュー修正 8 点 | ✅ 全件実在を追試確認（group-C 付録の表） |
| 前回 Doc/テスト指摘 13 件 | ✅ 11 件解消・2 件現状維持（dependabot 制約 / firewall-dns コメント → 今回解消） |
| **未解決のまま**: W-C-2 / W-C-4 / S-C-4 / E-A-3 / W-A-2(logs raw) / W-A-3(restore) / L-C-1 / L-C-2 / UX-1 / UX-2 / G:鍵分離 / F:Podman | 📋 新 ROADMAP に引き継ぎ |

## 🛠️ 本セッションで実施した修正（3 コミット）
| コミット | 内容 | 対応 ID |
|---|---|---|
| `f23f7bf` fix(cli) | useVolume 既定・lanInput 実効値判定・tz 検証・rebuild 失敗案内・setup コメント | W-D-3, W-D-1, L-D-3, L-D-1, D-D-1 |
| `27f820c` test(cli) | マーカー経路分離・@revoked 温存・fetch 例外・束 0600・validate/閾値・sshDir 化・フィクスチャ出所 | D-A-1, L-F-5, L-B-2, L-B-5, W-F-2, L-F-3, D-F-2 |
| `c574095` docs | ssh.ts 前提明記・keys/remote 順序根拠・Dockerfile arch 注記・.env.example 補強 | W-A-2, D-A-2, D-A-3, D-B-1, L-B-3, D-C-1, L-C-3, D-E-1, D-E-2, L-F-1 |

- 🤖 8 件: 全件適用。タグ無し軽微 4 件（L-D-1/L-F-5 等）も適用。🙋 19 件: 5 件は
  コメント/テストで決着、**14 件 ROADMAP 送り**
- テスト 83 → **87 passed / 0 failed**（lint/fmt クリーン維持）
- 実機検証が必要な変更は **なし**（コンテナ側は Dockerfile コメントのみ）

## アクションアイテム（推奨優先順）
1. **W-C-1**（keyscan `--` + 先頭ハイフン拒否）— 数行で閉じる深層防御。testConnection と対称化
2. **W-B-1**（truncated ssh-rsa 拒否）— 3 行 + テスト 1 本。挙動変更のためユーザー確認のみ
3. **W-A-1**（buildHostBlock の名前検証）— lib 層で validateRemoteName 相当を呼ぶ防御多重化
4. **W-E-3 + L-E-3**（mountinfo 判定の堅牢化）— NUL 区切り化とセットで。実機検証必須
5. **W-E-1**（DNS ピン v4/v6 対称化）— firewall を次に触るときに同梱（前回から継続）

## 次回レビューでの対応指針
- 新 ROADMAP の 🙋 14 件（+ 前回継続分）の解消検証から開始
- ssh.ts / keys.ts / remote.ts は今回 Opus/Sonnet で精査済み → 変更が入らない限り 🔵 扱いで薄く
- init-permissions.sh は W-E-3 対応後に Opus で再レビュー（boot スクリプトは Opus 固定）
- 鍵分離（instances/<名前>/）着手時は keys.ts のシグネチャ変更を伴うため Group B 相当を再派遣

## 検査メソッドのメモ
- 🔴/💣 ゼロは「開発時に Opus 敵対レビューを通した機能群」を再レビューした結果として妥当。
  開発時レビューの「修正済み」主張を追試する構成（group-C 付録）は信頼の検証として有効だった
- Sonnet (Group D) の W-D-1 は重大度過大気味（実挙動は妥当、実問題は壊れやすい初期化のみ）。
  オーケストレータ判断で挙動維持のリファクタに格下げ — 前回の「Sonnet は過大評価傾向」と一致
- Opus (Group E) は今回も E-C-1 の縁のエッジ（W-E-3）を机上再現付きで検出。boot スクリプト = Opus 固定を継続
- ID 衝突に注意: 前回の W-A-2/W-B-1 等と今回の同名 ID は別物。ROADMAP では (前回) を付記して区別
- サンドボックスの `deno test` は権限プロンプトで落ちる → `-A` 明示が必要（次回プロンプトに含めると吉）
