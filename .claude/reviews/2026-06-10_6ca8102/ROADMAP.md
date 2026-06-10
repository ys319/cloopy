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

## 優先度: 中
| ID | 軸 | タグ | 内容 | 推定コスト | 着手タイミング |
|---|---|---|---|---|---|
| G: Phase 3 | 機能 | 🙋 | リモート接続プロファイル（HostName/known_hosts 可変化、docker 非依存の config 注入モード）。W-G-1（HostName localhost 固定）/ W-G-2 / W-G-3（bind 全 IF 固定 — **デフォルト変更は既存利用を即破壊するので不可**、.env 可変化のみ） | 1-2日 | Phase 1/2 完了済み — 必要になったら |
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
