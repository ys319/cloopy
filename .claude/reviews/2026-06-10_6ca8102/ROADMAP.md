# ROADMAP

レビュー 2026-06-10_6ca8102 で「同セッション対応見送り」とした項目。🙋 はユーザー判断待ち。

## 優先度: 高（次回レビュー前に対応推奨）
| ID | 軸 | タグ | 内容 | 推定コスト | 着手タイミング |
|---|---|---|---|---|---|
| W-B-1 + W-D-3 | 🟡 | 🙋 | `ssh.ts` injectSshConfig: 書き込み失敗時の巻き戻しなし + **テストゼロ**（~/.ssh/config 破損 = SSH 全滅に直結）。tmp 書き込み→rename のアトミック化 + マーカー処理のユニットテスト | 1日 | 高 |
| W-C-3 | 🟡 | 🙋 | Dockerfile: s6-overlay tarball をチェックサム未検証で展開し PID 1 実行（供給鎖）。リリースの sha256 を ARG でピン留め | 1-2時間 + ビルド確認 | 高 |
| 実機検証 | - | - | ✅ **2026-06-10 確認済み**（macOS で UID 501→5001 の変更ブート: bind 3点の skip ログ確認・正常起動）。残: uCore 側は次回起動時に `ssh cloopy` 疎通を一応見る程度で OK | - | 済 |

### 対応済み（レビュー後の追補）
| ID | 内容 | 対応 |
|---|---|---|
| E-C-1 | `chown -R /home/developer` の bind mount 再帰によるホスト所有権破壊 | ✅ /proc/self/mountinfo でホスト bind を find -prune 除外（named volume は対象維持・グロブ文字エスケープ込み）。fake mountinfo シミュレーション 17 アサーション + Opus 敵対的検証済み。**実機検証のみ残**（上の実機検証行参照） |

## 優先度: 中
| ID | 軸 | タグ | 内容 | 推定コスト | 着手タイミング |
|---|---|---|---|---|---|
| G: Phase 1 | 機能 | 🙋 | **複数 SSH 鍵対応**: CLI 管理の束ファイル（~/.ssh/cloopy/authorized_keys = 自動生成鍵 + 追加鍵）を CLOOPY_PUBKEY_PATH に向ける + ペースト/ファイル指定で鍵追加。staged-copy 設計と相性良・Docker 側変更ゼロ。設計判断: 鍵の真実を束ファイル直編集にするか keys.json メタ store にするか（G レポートは後者推奨） | 半日-1日 | リモート接続が必要になったら最初に |
| G: Phase 2 | 機能 | 🙋 | `github.com/<user>.keys` 取得 + 鍵管理メニュー（一覧/削除/指紋表示）。取得鍵のユーザー確認表示・`github:<user>` ラベル付与・404/空応答ハンドリング | 1-2日 | Phase 1 の後 |
| G: Phase 3 | 機能 | 🙋 | リモート接続プロファイル（HostName/known_hosts 可変化、docker 非依存の config 注入モード）。W-G-1（HostName localhost 固定）/ W-G-2 / W-G-3（bind 全 IF 固定 — **デフォルト変更は既存利用を即破壊するので不可**、.env 可変化のみ） | 1-2日 | Phase 1/2 の後 |
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
