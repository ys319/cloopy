# ROADMAP

レビュー 2026-06-11_742f83e で「同セッション対応見送り」とした項目 + 前回
（2026-06-10_6ca8102）からの継続分。🙋 はユーザー判断待ち。前回 ROADMAP の
ID と今回の ID が同名で衝突する場合は「(前回)」を付記して区別する。

## 優先度: 高（次回レビュー前に対応推奨）
| ID | 軸 | タグ | 内容 | 推定コスト | 着手タイミング |
|---|---|---|---|---|---|
| W-C-1 | 🟡 | 🙋 | `scanRemoteHostKeys` の args に `--` を追加し（testConnection と対称化）、`validateRemoteHost` で先頭ハイフンを拒否。現状インジェクション不成立だが validator の不変条件「config を壊す入力を弾く」の綻び。テスト: `validateRemoteHost("-G")` 等の拒否ケース追加 | 30分-1時間 | 次の CLI 作業時 |
| W-B-1 | 🟡 | 🙋 | truncated ssh-rsa blob（`ssh-rsa AAAAB3NzaC1yc2E=` 等）が parsePublicKey を通過 → ユーザーが追加成功と誤認して SSH 不能（可用性）。`rsaBits === undefined` で `ok: false` にする 3 行 + テスト 1 本。挙動変更（従来通った鍵が弾かれる）のため 🙋 | 30分 | W-C-1 と同時 |
| W-A-1 | 🟡 | 🙋 | `.env` 手編集の未検証インスタンス名が `buildHostBlock` に生補間され Host ブロックが割れる（対話パスは検証済み・非対話パス setup.ts:82 / manage.ts:316,358 が無検証）。推奨: `injectSshConfig` 冒頭で `validateRemoteName` 相当を呼び throw（lib 層で全呼び元を一括防御）。否定テスト追加 | 1-2時間 | W-C-1 と同時 |

## 優先度: 中
| ID | 軸 | タグ | 内容 | 推定コスト | 着手タイミング |
|---|---|---|---|---|---|
| W-E-3 | 🟡 | 🙋 | init-permissions.sh:93-95 — host bind の source パスが `*/volumes/*/_data` を含むと named volume 誤判定 → prune 漏れ → `chown -R` がホスト実ファイルへ再帰（E-C-1 の縁。机上再現済み・通常構成では発火しない）。候補 B: 判定を絶対パス先頭一致（`/var/lib/(docker\|containers)/` + rootless prefix）に厳格化 / 候補 C: 判定反転（mountpoint==base と /nix 以外は全 prune、CLAUDE.md の named volume 方針と要整合）。**実機検証必須** | 半日 + 実機 | L-E-3 と同時 |
| L-E-3 | 🔵 | 🙋 | 同スクリプトの mountinfo 読み取りを NUL 区切り化（`printf '%b\0'` + `read -d ''`）— 改行入り mountpoint で prune が分割される机上再現済み。fake mountinfo の単体ハーネス化で W-E-3 共々回帰で守る | 2-3時間 + 実機 | W-E-3 と同時 |
| L-C-1 | 🔵 | 🙋 | identityFile パスの改行を validate で拒否（remote 側）+ `buildHostBlock` で IdentityFile 値を二重引用（ssh.ts 側 — 空白入り正当パスの潜在バグも同時解決）。A+B 併用が理想 | 1-2時間 | W-A-1 と同時 |
| W-E-1 (前回 W-C-2) | 🟡 | 🙋 | DNS ピンの v4/v6 独立判定 — 片系のみ設定時に他系 :53 が素通り（`.env` 直編集で露出、デフォルト compose は無害）。最小案: 片系のみ検出 → WARN + 未設定系も :53 DROP。test/firewall-dns.sh に混在ケース追加 | 半日 + 実機 | firewall を次に触るとき |
| W-E-2 (前回 W-C-4) | 🟡 | 🙋 | PUID/PGID 境界値検証（0 = root 化を拒否 or 警告、非数値 = 明示エラー。現状は非数値で起動失敗） | 1-2時間 + 実機 | W-E-3 と同時 |
| S-E-1 (前回 S-C-4) | 提案 | 🙋 | sshd 追加強化: `AllowUsers developer`（W-E-2 の UID 0 化への保険にも）+ `X11Forwarding no` 等。VS Code Remote SSH 疎通の実機検証とセット | 1-2時間 + 実機 | 中 |
| E-A-3 | 🟡 | 🙋 | インスタンス名変更で旧ボリューム孤立・無警告（前回から継続）。変更検出時に旧ボリューム一覧と削除案内。**鍵分離 (90e38d2) 後は旧 `~/.ssh/cloopy/instances/<旧名>/` も同様に孤立するため警告に合流させる**。L-D-2（instanceName の setup 後 stale）は 90e38d2 のループ内再読込で解消済み | 2-3時間 | 次の CLI 作業時 |
| UX-1 | UX | 🙋 | リモートエントリへの SSH 接続をメニューから（前回から継続。接続テストは BatchMode なので別物） | 30分-1時間 | 次の CLI 作業時 |
| UX-2 + W-D-2 | UX | 🙋 | 対話プロンプトのキャンセル対応（前回から継続）。2 階層メニュー追加で対象 Select が増えた（悪化はなし・各サブメニューに「戻る」あり）。cliffy の ESC ハンドリング要調査 | 半日（調査込み） | 次の CLI 作業時 |
| F: Podman | 調査 | 🙋 | 推奨 Tier 0 = 非対応を README に明記（前回から継続・変化なし） | 30分 | ユーザー判断 |

## 優先度: 低（暇なときに）
| ID | 軸 | タグ | 内容 | 推定コスト | 着手タイミング |
|---|---|---|---|---|---|
| L-A-1 | 🔵 | - | port 22 の bare token と `[host]:22` 表記の非対称 — リモート port 22 + ユーザー手書きブラケット表記の二重稀ケースで旧 pin 残留。`upsertKnownHosts` の token 集合に `[host]:22` 別名追加（数行） | 30分 | 低 |
| L-A-2 | 🔵 | 🙋 | リモート最終エントリ削除で banner 残骸 + dangling Include（機能的に無害・美観のみ）。掃除を入れるか仕様として受容 | 1時間 | 低 |
| L-C-2 | 🔵 | 🙋 | 名前衝突ガードが marker 管理ブロックのみ検出（ユーザー手書き素 Host・複数パターン行・大文字差を取りこぼし）。設計意図の範囲では機能 — 厳格化は誤遮断とのトレードオフ、現状維持寄り | 2時間 | 低 |
| D-C-2 | 🟣 | 🙋 | doctor が `0.0.0.0:` を受理するが「IPv6 が公開されない」旨を案内しない（手編集ユーザーのみ） | 30分 | 低 |
| L-B-1 | 🔵 | 🙋 | fetchGithubKeys のレスポンスサイズ上限なし（GitHub 仕様変更への保険） | 1時間 | 低 |
| L-B-4 | 🔵 | 🙋 | 「ファイルから追加」でコメントなし鍵にラベルを問わない（paste 方式との非対称・UX） | 1時間 | 低 |
| L-E-1 (前回 L-C-1) | 🔵 | 🙋 | compose の `${CLOOPY_PUBKEY_PATH}` を `:?run ./manage.sh setup` 化（前回から継続） | 30分 | 低 |
| L-E-2 (前回 L-C-2) | 🔵 | 🙋 | FIREWALL/ALLOW_HOST の表記揺れ非寛容（fail-safe 方向なので据置で問題なしと再確認） | 30分 | 記録のみ |
| W-F-1 | 🟡 | 🙋 | テストの `if (r.ok)` ナローイングガードを `assert()` 型ガードへ置換（実害なし・可読性のみ） | 1時間 | 低 |
| L-F-4 | 🔵 | 🙋 | sk-*（FIDO2）鍵のパーステストなし — 実フィクスチャ生成にハードウェアキーが必要なため、ユーザーの実鍵提供があれば追加 | 30分（鍵があれば） | ユーザー次第 |
| 前回 W-A-2 | 🟡 | 🙋 | logs 表示中の端末 raw モード残留疑い（前回から継続・コード変更なし。再現確認から） | 1時間 | 低 |
| 前回 W-A-3 | 🟡 | 🙋 | restore でボリューム削除後に作成失敗すると修復不能（前回から継続。エラー表示は改善済み） | 2時間 | 低 |
| L-A-4 (前回 L-B-3) | 🔵 | 🙋 | refreshKnownHosts の keyscan 全失敗時に旧 pin 残置（消すと接続不能/残すと mismatch のトレードオフ。既知・据置） | 1時間 | 低 |
| 前回 L-B-2 | 🔵 | 🙋 | checkBootstrapStatus の logs 失敗サイレント無視（前回から継続） | 1時間 | 低 |
| 前回 S-C-1 | 提案 | 🙋 | `cap_drop: [ALL]` + 最小 cap 足し直し（前回から継続。S-C-2/S-C-3 は再検討不要と結論済み） | 半日 + 実機 | 低 |
| 前回 L-D-1 | 🔵 | - | dependabot の JSR 非対応（プラットフォーム制限の記録。deno.lock 手動運用） | - | 記録のみ |

## 対応済み（レビュー後の追補）
| ID | 内容 | 対応 |
|---|---|---|
| G: 鍵分離 | keys.json のインスタンス分離（全インスタンスが束/store を共有し、片方への鍵追加が両方へ反映される） | ✅ 2026-06-12 `90e38d2`。store/束を `~/.ssh/cloopy/instances/<名前>/` へ分離（`keys.ts` 全関数に instanceName 引数）、自動生成鍵は共有のまま。旧グローバル keys.json は `loadKeyStore` 初回アクセス時にコピー移行・**レガシー残置**（別チェックアウトの移行元。残存中は新インスタンスも継承 — CLAUDE.md に許容と明記）。`CLOOPY_PUBKEY_PATH` は再 setup / 鍵管理でインスタンス束へ自動移行。manage() の env/instanceName をループ内再読込化（L-D-2 同時解消）。Opus 敵対レビュー（3 レンズ → 指摘別検証）: 確認 3 件すべて修正（.env 手編集の `../` トラバーサル → `instanceKeysDir` で `INSTANCE_NAME_PATTERN` 検証 throw / instances ツリー 0700 / 移行境界「束は作らない」のテスト固定）・反証 5 件（表示パスでの移行書き込み = 設計どおり / 新インスタンスへの鍵継承 = 文書化済み / 旧グローバル束の残置 = スコープ外 等）。テスト 87 → 92 本。**実機確認は未**: 鍵追加 → 再作成 → 追加鍵で SSH / 旧構成からの移行起動 |

## 受容済み（対応不要と整理した項目の記録）
| ID | 内容 | 整理 |
|---|---|---|
| W-A-2 (今回) | known_hosts のマーカー一致は host 非依存で行除去 | 設計どおり（マーカー = cloopy 所有印・ホスト変更後の旧 pin 追跡に必要）。前提をコメント明記済み `c574095` |
| W-B-2 | store 保存 → 束生成の間の部分失敗で乖離 | 発生は disk full 級のみ・次回操作で再整合。順序根拠をコメント化 `c574095`、トランザクション化は不採用 |
| W-F-2 の ensureEnvFile | `Deno.exit(1)` パスのテスト | プロセス終了パスは単体テスト対象外と整理（validatePublicKeyInput / RSA_MIN_BITS はテスト追加済み `27f820c`） |
| D-E-1 の fail-fast 化 | 未サポート arch でビルド失敗させる案 | amd64/arm64 限定運用では発火しないためコメント明記のみ `c574095` |
