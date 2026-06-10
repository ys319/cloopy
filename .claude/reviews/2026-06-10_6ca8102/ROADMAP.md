# ROADMAP

レビュー 2026-06-10_6ca8102 で「同セッション対応見送り」とした項目。🙋 はユーザー判断待ち。

## 優先度: 高（次回レビュー前に対応推奨）
| ID | 軸 | タグ | 内容 | 推定コスト | 着手タイミング |
|---|---|---|---|---|---|
（高優先はすべて対応済み — 下の「対応済み」参照）
| 実機検証 | - | - | ✅ **2026-06-10 確認済み**（macOS で UID 501→5001 の変更ブート: bind 3点の skip ログ確認・正常起動）。残: uCore 側は次回起動時に `ssh cloopy` 疎通を一応見る程度で OK | - | 済 |

### 対応済み（レビュー後の追補）
| ID | 内容 | 対応 |
|---|---|---|
| E-C-1 | `chown -R /home/developer` の bind mount 再帰によるホスト所有権破壊 | ✅ /proc/self/mountinfo でホスト bind を find -prune 除外（named volume は対象維持・グロブ文字エスケープ込み）。fake mountinfo シミュレーション 17 アサーション + Opus 敵対的検証 + **実機確認済み**（macOS UID 変更ブート） |
| W-B-1 + W-D-3 | injectSshConfig の非アトミック書き込み + テストゼロ | ✅ tmp→rename のアトミック書き込み（0600）+ upsertHostBlock / ensureIncludeLine を純粋関数化しテスト 10 本追加。テストが末尾改行食いと RegExp 未エスケープの潜在バグ 2 件も検出・修正 |
| W-C-3 | s6-overlay tarball のチェックサム未検証 | ✅ noarch / aarch64 / x86_64 の sha256 を ARG でピン留めし `sha256sum -c` で検証。値は公式リリースの .sha256 と実 tarball のローカルハッシュ計算の両方で照合済み。**実ビルド成功を実機確認済み（2026-06-10）** |
| G: Phase 1+2 | 複数 SSH 鍵対応 + GitHub `.keys` 取得 + 鍵管理メニュー | ✅ 🙋-G-1 は推奨どおり keys.json メタ store + 束ファイル再生成、🙋-G-2 のラベル付与（`github:<user>`）も採用。`cli/lib/keys.ts`（検証・指紋・store・束・fetch）+ `cli/commands/keys.ts`（一覧/追加3方式/削除、自動生成鍵は削除不可）。鍵反映は `up --force-recreate`（単一ファイル bind mount の inode 固定対策）。テスト 20 本（実鍵フィクスチャ・ssh-keygen 指紋照合）。**実機確認済み（2026-06-10: 鍵追加 → 再作成 → 追加鍵で SSH 成功）** |
| G: Phase 3 | リモート接続プロファイル + SSH 公開範囲（W-G-1/2/3/5） | ✅ remotes.json メタ store（`cli/lib/remote.ts`）+ メインメニュー「リモート接続」（`cli/commands/remote.ts`: 追加・更新/削除/接続テスト、keyscan 指紋確認 → `known_hosts.d/<名前>` にエントリ別固定、TOFU フォールバック）。`injectSshConfig` を HostName/IdentityFile/UserKnownHostsFile 可変化 + `removeHostBlock`/`hasHostBlock`。docker 無しマシンは main.ts がリモート専用モードを案内。W-G-3 は `CLOOPY_SSH_BIND`（末尾コロン形式、compose デフォルト空 = 従来の全 IF v4+v6 を完全維持、setup の既定は常に「ローカルのみ」（2026-06-11 ユーザー指示で既存 .env 再 setup も含めデフォルト no に統一）、settings「SSH 公開範囲」トグル、doctor 形式検証）。Opus 敵対的レビュー（3 レンズ→指摘別検証、確認 11 件・反証 0）→ 全件修正: docker デーモン停止をリモート専用誘導から除外 / CRLF config 正規化（既存 upsert 二重追加も解消）/ doctor の IPv6 bind 受理 / setup・settings がカスタム bind を上書きしない / store load 時の name/host/port 再検証（パストラバーサル・ssh オプション注入遮断）/ インスタンス名とリモート名の双方向衝突ガード / 削除順序 config→store / ホスト鍵信頼は default:No。テスト +22 本（計 77）。**実機確認待ち**: ローカル `ssh cloopy` 回帰 / リモート登録 → 接続 / bind 切替（127.0.0.1 時に LAN から拒否されること） |

## 優先度: 中
| ID | 軸 | タグ | 内容 | 推定コスト | 着手タイミング |
|---|---|---|---|---|---|
| G: 鍵分離 | 機能 | 🙋 | **keys.json のインスタンス分離**（2026-06-11 ユーザー提起）: 現状は全インスタンスが `~/.ssh/cloopy/authorized_keys` を共有し、片方への鍵追加が再作成後に両方へ反映される。store/束を `~/.ssh/cloopy/instances/<名前>/` へ移し、自動生成鍵は共有のまま（分離は追加鍵のみ）、移行は旧グローバル store のコピー程度でよい（後方互換への過剰投資は不要 — ユーザーは ~/.ssh/cloopy を定期的に消して作り直す運用）。インスタンス名変更時の孤立鍵ディレクトリは E-A-3 の警告に合流 | 半日 | Phase 3 の次 |
| UX-1 | UX | 🙋 | **リモートエントリへの SSH 接続をメニューから**（2026-06-11 ユーザー要望）: リモート接続メニューに「SSH 接続」を追加（manage の ssh ケースと同じ stdin/stdout inherit の対話接続。接続テストは BatchMode なので別物）。エントリ 1 件ならワンステップで | 30分-1時間 | 次の CLI 作業時 |
| UX-2 | UX | 🙋 | **対話プロンプトのキャンセル対応**（2026-06-11 ユーザー要望）: 設定変更などで項目を選び間違えると Input から抜けられず毎回 ^C している。ESC や空入力で一つ前のメニューへ戻れるように。⚠️ cliffy は空入力で default を返すため「空=キャンセル」は default 併用時に成立しない — keypress レベルの ESC ハンドリングか、cliffy の中断例外の捕捉可否を要調査（^C は cliffy が process exit する点も確認） | 半日（調査込み） | 次の CLI 作業時 |
| W-C-2 | 🟡 | 🙋 | DNS ピンの v4/v6 独立判定 — 片系のみ設定時に他系 :53 が素通り（フィルタバイパス経路）。両系の整合ルールを決めて test/firewall-dns.sh も拡張 | 半日 + 実機 | firewall を次に触るとき |
| W-C-4 | 🟡 | 🙋 | PUID/PGID の境界値検証（0 = root 化を拒否 or 警告、非数値 = 明示エラー） | 1-2時間 + 実機 | E-C-1 と同時 |
| E-A-3 | 🟡 | 🙋 | 再 setup でインスタンス名変更時、旧 `<name>_*` ボリュームが無警告で孤立（ディスク消費のみ・データ喪失なし）。変更検出時に旧ボリューム一覧と削除案内を表示 | 2-3時間 | 中 |
| F: Podman | 調査 | 🙋 | **推奨 Tier 0 = 非対応を README に明記**（uCore は docker 同梱でそのまま動くため）。Tier 1（podman.socket + docker compose、実験的・無保証の注記）はドキュメントのみなら低コスト。決定打 3 点の実機検証チェックリストは group-F §7 参照 | Tier 0: 30分 | ユーザー判断 |
| S-C-4 | 🟡 | 🙋 | sshd 追加強化（`AllowUsers developer` 等、比例的範囲）。SSH 接続性に直結するため実機検証とセット | 1-2時間 + 実機 | 中 |

## 優先度: 低（暇なときに）
| ID | 軸 | タグ | 内容 | 推定コスト | 着手タイミング |
|---|---|---|---|---|---|
| W-A-2 | 🟡 | 🙋 | logs 表示中の端末 raw モード残留疑い（Pass 2 未検証 — try/finally はあるので再現確認から） | 1時間 | 低 |
| W-A-3 | 🟡 | 🙋 | restore でボリューム削除後に作成失敗すると中途半端な状態。失敗時に再試行案内 or 削除前検証 | 2時間 | 低 |
| L-B-2 / L-B-3 | 🔵 | 🙋 | checkBootstrapStatus の logs 失敗サイレント無視 / refreshKnownHosts 失敗時の古い known_hosts 残留 | 各1時間 | 低 |
| L-C-1 | 🔵 | 🙋 | compose の `${CLOOPY_PUBKEY_PATH}` を `:?` 付きにして未設定時のエラーを明瞭化（.env なし直接 up のケース） | 30分 | 低 |
| L-C-2 | 🔵 | 🙋 | CLOOPY_FIREWALL/ALLOW_HOST の表記揺れ正規化（`Off` 等。現状は fail-safe 方向なので低優先） | 30分 | 低 |
| S-C-1 | 提案 | 🙋 | `cap_drop: [ALL]` + 最小 cap 足し直し。**SSH ログイン影響の実機検証必須**（group-C 参照）。S-C-2（NET_ADMIN 放棄）は検討の結果非推奨、S-C-3（read-only rootfs）は不可と結論済み — 再検討不要 | 半日 + 実機 | 低 |
| L-D-1 | 🔵 | - | dependabot は JSR パッケージ（@std/@cliffy）を追跡できない（プラットフォーム制限の記録。deno.lock 更新を手動運用） | - | 記録のみ |
