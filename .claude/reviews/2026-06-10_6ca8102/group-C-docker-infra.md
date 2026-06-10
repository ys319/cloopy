---
group: C
topic: Docker イメージ / s6-overlay / compose インフラ
files_reviewed: 14
date: 2026-06-10
model: opus
---

# Group C: Docker イメージ / s6-overlay / compose インフラ

## サマリ
- 全体として設計は堅牢。firewall の SSH 保険（`--sport 22` + ESTABLISHED）、fail-open/fail-closed
  の使い分け、staged authorized_keys コピー、marker 最適化された chown はいずれも意図が明確で
  コメントも丁寧。`bash -n` は全スクリプト合格。
- 一方で **`init-permissions` の `chown -R /home/developer` が bind-mount された workspace /
  asset ファイルへ再帰してホスト側の所有権を書き換える**（authorized_keys で避けたはずの罠）が
  最重要の論点。さらに firewall の **IPv4/IPv6 DNS ピン非対称**（片系だけ未設定だと `:53` 穴が残る）、
  `usermod` フォールバック時の GID 取りこぼし、s6 tarball の **チェックサム未検証**が続く。
- SSH 接続性を直接壊す指摘はなし（既存の保険は妥当）。ただし下記 E-C-1 は UID 変更時の初回起動を
  数分ブロックし得る（SSH 可用性に間接影響）。
- 重大度件数: 🟢 5 / 🔵 4 / 🟡 4 / 🔴 1 / 💣 0
- ドキュメント軸: 🟣 3
- タグ別: 🤖 2 / 🙋 8

## ファイル別分類
| 分類 | ファイル | 一言コメント |
|---|---|---|
| 🔴 Error | docker/s6-overlay/scripts/init-permissions.sh:84-92 | `chown -R $HOME` が bind-mount(workspace/asset) に再帰しホスト所有権を破壊し得る (E-C-1) |
| 🟡 Warning | docker/s6-overlay/scripts/init-permissions.sh:54 | `usermod` フォールバックが `-g` を渡さず GID 未適用 + 再帰 chown 復活 (W-C-1) |
| 🟡 Warning | docker/s6-overlay/scripts/init-firewall.sh:254-269 | IPv6 DNS ピン非対称: 片系のみ設定で `:53` 抜け道 (W-C-2) |
| 🟡 Warning | docker/Dockerfile:53-62 | s6-overlay tarball のチェックサム未検証（供給鎖） (W-C-3) |
| 🟡 Warning | docker/s6-overlay/scripts/init-permissions.sh:13-14,32 | PUID/PGID の境界値（0・非数値）未検証 (W-C-4) |
| 🔵 Low | docker-compose.yml:43 | `CLOOPY_PUBKEY_PATH` 未設定時に compose が不明瞭に失敗 (L-C-1) |
| 🔵 Low | docker/s6-overlay/scripts/init-firewall.sh:75 | `CLOOPY_FIREWALL`/`ALLOW_HOST` の値が大文字小文字・表記揺れに非寛容 (L-C-2) |
| 🔵 Low | docker/Dockerfile:全体 | `no-new-privileges` 下で UID 変更が passwd 書換えに依存（setuid 不可）— 現状は整合 (L-C-3) |
| 🔵 Low | docker-compose.yml:64-69 | healthcheck が firewall/bootstrap 完了を見ない（sshd 起動のみ） (L-C-4) |
| 🟣 Doc | docker/s6-overlay/scripts/init-firewall.sh:85-87 | コメント「order among DROPs is irrelevant」は ACCEPT 順序前提と紛らわしい (D-C-1) |
| 🟣 Doc | docker-compose.yml:54-56 | コメント「Remove this to fully disable the firewall」が CLOOPY_FIREWALL=off と二重 (D-C-2) |
| 🟣 Doc | assets/.zshenv:9 | `devbox` 未インストール時に毎ログイン eval が失敗し得る点が未記載 (D-C-3) |
| 🟢 Safe | docker/s6-overlay/scripts/init-ssh-keys.sh | staged copy 設計は正しく自己修復的。fail-closed 妥当 |
| 🟢 Safe | docker/s6-overlay/scripts/init-workspace-check.sh | 警告のみ・副作用なし。誘導メッセージも的確 |
| 🟢 Safe | docker/s6-overlay/scripts/bootstrap.sh | s6-setuidgid で非 root 実行・リトライ付き。SSH と独立で可用性に影響せず |
| 🟢 Safe | docker/s6-overlay/s6-rc.d/** | 依存グラフ（base←init-permissions←{ssh-keys,firewall,workspace-check,bootstrap}、sshd←ssh-keys）は CLAUDE.md と一致。型/up/run 妥当 |
| 🟢 Safe | docker/vendor/update-grml-zshrc.sh | 単純な vendoring。`set -euo pipefail` 済み |

> Doc は重大度と独立軸。E-C-1 のファイルは Warning(W-C-1/W-C-4) も併記。

## 詳細指摘

### 🔴 E-C-1 🙋: `chown -R /home/developer` が bind-mount に再帰しホスト側所有権を破壊し得る
- **対象**: `docker/s6-overlay/scripts/init-permissions.sh:84-92`（first boot / UID 変更時）
- **症状**: `docker-compose.yml` は `/home/developer` 配下に bind mount を 3 つ重ねている:
  `./workspace`(50), `./assets/.zshenv`(45), `./assets/CLAUDE.md`(45→`/home/developer/.claude/`)。
  marker 不一致（初回起動 or PUID/PGID 変更）時、`chown -R "${PUID}:${PGID}" /home/developer` が
  これら bind mount にも再帰し、**ホスト上の実ファイル/ディレクトリの所有権を書き換える**。
  rootless Docker では subuid に chown され、以後ホストから `workspace` や `assets/` が
  読めなくなる/git 操作が壊れる。これは CLAUDE.md が authorized_keys について明示的に避けている罠
  （「bind mount を直接 chown するとホストの実ファイルを書き換える」62-66 行）とまったく同じ構造で、
  home ボリュームだけは対策が漏れている。
- **根本原因**: `home-data` 名前付きボリュームが `/home/developer` にマウントされ、その「内側」に
  ホスト bind mount が入れ子になっている。`chown -R` はマウント境界を越えて辿る。
- **影響度**: 通常運用（UID 固定）では marker 一致で再帰 chown はスキップされるため発火頻度は低い。
  だが (a) 初回起動、(b) `CLOOPY_USER_UID` 変更（workspace UID 不一致を直すため init-workspace-check
  が案内する操作そのもの）で確実に発火する。**workspace を直したい操作がホスト所有権破壊を誘発する**
  という嫌な相互作用がある。SSH 接続性自体は壊さないが、UID 変更時はこの再帰が完了するまで
  init-ssh-keys→sshd がブロックされる（timeout 300s）ため可用性にも間接影響。
- **修正案**:
  - 候補 A（推奨・低リスク）: bind mount を `chown -R` の対象から除外する。`chown` を
    `find "${USER_HOME}" -xdev` ベースに変えてマウント境界（`-xdev`）を越えないようにする。ただし
    `home-data` 自体が `/home/developer` マウントなので `-xdev` だと配下の bind mount だけ除外でき、
    かつ `home-data` 直下は同一 fs として chown される。要検証（bind mount は別 dev になる）。
  - 候補 B: 既知の bind パス（`workspace`, `.zshenv`, `.claude/CLAUDE.md`）を `-prune` で明示除外。
    パスがハードコードになる代償あり。
  - 候補 C: home の永続物（`.ssh`, `.nix-profile`, `.local`, `.cache` 等）だけを列挙して chown し、
    `/home/developer` 全体の `-R` をやめる。最小権限だが列挙漏れリスク。
- **テスト**: `test/` に「`CLOOPY_USER_UID` を変えて再起動 → ホスト側 `workspace/` と
  `assets/.zshenv` の `stat -c %u` が変化しないこと」を検証するケースを追加。SELinux/rootless 両方で。

### 🟡 W-C-1 🙋: `usermod` フォールバックが `-g` を渡さず GID 未適用・再帰 chown が復活
- **対象**: `docker/s6-overlay/scripts/init-permissions.sh:54`
- **症状**: `/etc/passwd` の developer 行が想定フォーマットに一致しない場合のフォールバックは
  `usermod -o -u "$PUID" "${USER_NAME}"` のみで、**`-g "$PGID"` を渡していない**。よって PGID が
  CURRENT_GID と異なるケースでこの分岐に落ちると GID が反映されない。加えて `usermod -u` は
  まさにこの設計が避けたかった「home 全体の再帰 re-chown」を誘発する（22-28 行のコメント参照）ので、
  フォールバック時は二重に再帰 chown が走り起動が遅延する。
- **根本原因**: 上流の sed 成功パスは uid:gid 両方を書き換えるが、フォールバックは uid だけ。
- **修正案**: フォールバックを `usermod -o -u "$PUID" -g "$PGID" "${USER_NAME}"` にする（🙋: 再帰
  chown の副作用が残る点は許容かを要判断。groupmod は上で処理済みなので `-g` は番号参照で済むはず）。
  発火頻度は極小（passwd 改変時のみ）だが GID 取りこぼしは静かなバグ。
- **テスト**: passwd 行を意図的に壊した状態でフォールバックが UID/GID 両方を適用することを確認。

### 🟡 W-C-2 🙋: IPv6 DNS ピンの非対称 — 片系のみ設定で `:53` 抜け道が残る
- **対象**: `docker/s6-overlay/scripts/init-firewall.sh:177-201`（v4）/ `254-269`（v6）
- **症状**: DNS ピンは「`DNS_V4` が空でなければ v4 の `:53` を DROP」「`DNS_V6` が空でなければ v6 の
  `:53` を DROP」と**系ごとに独立**。デフォルト compose は v4/v6 両方を注入するので問題ないが、
  ユーザーが `.env` で `CLOOPY_DNS_PRIMARY` だけ設定し `CLOOPY_DNS_V6_*` を空にする（あるいは CLI の
  custom 入力は v6 を据え置くが、空にする経路も `.env` 直編集で存在）と、**IPv6 を持つネットワークでは
  任意の IPv6 resolver への `:53` が DROP されず、フィルタを迂回できる**（マルウェア DNS フィルタの
  バイパス）。逆も同様（v6 だけ設定し v4 の `:53` が素通り）。fallback コメント（187-189, 263-269）は
  「resolv.conf スコープに退避」と説明するが、これは「混在設定」ではなく「両系とも未設定」を想定した
  記述。
- **根本原因**: 「DNS が設定されている」の判定が AND ではなく系別 OR。
- **修正案**:
  - 候補 A: v4 か v6 のどちらか一方でもピンが有効なら、**他系は `:53` を全 DROP**（resolver を
    持たない系から `:53` を出させない）。最も堅いがフォールバックを持たない系で DNS を完全に閉じる。
  - 候補 B: 起動時に「片系のみ設定」を検出して WARN ログを出し、未設定系は明示的に `:53` DROP する。
  - 候補 C（最小）: ドキュメント/CLI で「v4/v6 は必ずセットで設定」を強制（CLI custom 入力で v6 も
    プリセット連動させる）。実装変更は最小だが `.env` 直編集の穴は残る。
- **テスト**: `test/firewall-dns.sh` に「`CLOOPY_DNS_V6_*` を空・v4 のみ設定 → 任意 IPv6 resolver への
  `:53` が DROP されること（または期待挙動）」を追加。
- **注**: これは却下済みの allowlist/ポート遮断とは無関係の、既存 DNS ピン機能の**完全性**の論点。

### 🟡 W-C-3 🙋: s6-overlay tarball のチェックサム未検証（供給鎖）
- **対象**: `docker/Dockerfile:53-62`
- **症状**: `ADD https://github.com/.../s6-overlay-noarch.tar.xz` と `wget` で取得した arch 別
  tarball を**チェックサム検証なしで `tar -Jxpf` 展開し、PID 1 (`/init`) として実行**している。
  リリースアセットが差し替わる/中間者が介在すると、PID 1 にコードが注入される最も影響の大きい経路。
  s6-overlay は各リリースに `.sha256` を併せて公開しているので検証は容易。
- **根本原因**: バージョンは `ARG S6_OVERLAY_VERSION` でピン済みだがダイジェスト未固定。
- **修正案（🙋）**: `S6_OVERLAY_SHA256_NOARCH` / `_AARCH64` / `_X86_64` を `ARG` で固定し、展開前に
  `echo "${SHA}  /tmp/...tar.xz" | sha256sum -c -` を挟む。`manage.sh` 一発体験は不変（ビルド時のみ・
  ネットワークは元々必要）。コスト: バージョン更新時に 3 ダイジェストの追従が要る（`update-grml-zshrc.sh`
  に倣い更新スクリプト化するとよい）。「得られる防御」= PID 1 サプライチェーン改竄検知。「壊れ得るもの」=
  なし（SSH/体験に無影響）。**比例性高め、推奨**。

### 🟡 W-C-4 🙋: PUID/PGID の境界値（0・非数値）が未検証
- **対象**: `docker/s6-overlay/scripts/init-permissions.sh:13-14, 32, 50-51`
- **症状**: `PUID=${PUID:-1000}` は数値・範囲を検証しない。`PUID=0` を渡すと sed が developer 行を
  `...:0:0:...` に書き換え、**developer が UID 0（root）として SSH ログインする**構成になり得る
  （`no-new-privileges` とは別軸で、特権ユーザーでの常用）。非数値（例 `PUID=abc`）だと sed の
  `[0-9]+` 正規表現に一致せず passwd は無変更のまま、後段 `chown "${PUID}:${PGID}"` が
  `chown abc:...` でエラー（`set -euo pipefail` で init-permissions が exit≠0 → 依存する
  ssh-keys/sshd が上がらず**起動失敗**）。CLI 側でバリデーションされている前提だが、`.env` 直編集や
  `docker run -e` の直接利用でガードが効かない。
- **修正案（🙋）**: 冒頭で `[[ "$PUID" =~ ^[0-9]+$ ]] && (( PUID >= 1 ))`（同 PGID）を検証し、不正なら
  WARN ログで 1000 にフォールバック（fail-safe）か、明示エラーで誘導。UID 0 を拒否するかは方針判断。
- **テスト**: `PUID=0` / `PUID=abc` での起動挙動を確認。

### 🔵 L-C-1 🙋: `CLOOPY_PUBKEY_PATH` 未設定時に compose が不明瞭に失敗
- **対象**: `docker-compose.yml:43`
- **症状**: `${CLOOPY_PUBKEY_PATH}:/etc/cloopy/authorized_keys:ro,z` はデフォルト値（`:-`）を持たない
  唯一の必須変数。未設定だと compose が空文字を bind source にしようとし、環境により不明瞭な
  エラー（カレントディレクトリのマウント等）になる。doctor が `.env` をチェックしている（doctor.ts:81）
  ので通常運用では拾えるが、compose を直接叩いた場合のメッセージが不親切。
- **修正案（🙋）**: compose の変数を `${CLOOPY_PUBKEY_PATH:?CLOOPY_PUBKEY_PATH must be set (run ./manage.sh setup)}`
  にして compose 段階で明示エラーにする。manage.sh 経路には無影響。
- **テスト**: `CLOOPY_PUBKEY_PATH` 未設定で `docker compose config` がエラーメッセージを返すこと。

### 🔵 L-C-2 🙋: `CLOOPY_FIREWALL`/`CLOOPY_ALLOW_HOST` が表記揺れに非寛容
- **対象**: `docker/s6-overlay/scripts/init-firewall.sh:75`（`= "off"`）, `164`/`243`（`= "on"`）
- **症状**: kill switch は `"off"` 完全一致のみ。`Off`/`OFF`/`0`/`false`/前後空白付きは「off 以外」=
  firewall ON 扱い（**fail-safe な方向**なので実害は小）。一方 `CLOOPY_ALLOW_HOST` は `"on"` 完全一致
  のみで、`On` 等は host 遮断（fail-closed）。意図した非対称だが、ユーザーが `CLOOPY_FIREWALL=Off` と
  書いて「切ったつもりが効いている」混乱は起き得る。
- **修正案（🙋）**: 比較前に `tr A-Z a-z` で正規化し前後空白を除去。挙動はより直感的になるが、
  「厳密一致 = タイポは安全側に倒す」現方針も妥当なので 🙋。
- **テスト**: `CLOOPY_FIREWALL=Off` で kill switch が効くこと（修正する場合）。

### 🔵 L-C-3 🙋: `no-new-privileges` と UID 変更方式の整合（現状は問題なし・記録）
- **対象**: `docker-compose.yml:59-60` + `init-permissions.sh:48-55`
- **症状**: `no-new-privileges:true` 下では setuid 経由の権限昇格が封じられるが、本実装は
  init-permissions が **root のまま** passwd を書き換え、sshd も root で起動するため UID 切替は
  問題なく成立する（s6 oneshot は root 実行・bootstrap のみ `s6-setuidgid`）。現状整合しており指摘は
  「将来 init-permissions を非 root 化したり setuid に頼る変更を入れると壊れる」という不変条件の記録。
- **修正案**: コード変更不要。CLAUDE.md か本スクリプト冒頭に「init-permissions は root 実行前提、
  no-new-privileges と両立」を一文残すと将来の事故を防げる（🟣 寄りだが設計不変条件なので L）。

### 🔵 L-C-4 🙋: healthcheck が sshd 起動のみで firewall/bootstrap を見ない
- **対象**: `docker-compose.yml:64-69`
- **症状**: healthcheck は `ss -lnt | grep :22` のみ。CLAUDE.md 通り「sshd は firewall 適用前に
  上がる」設計なので、healthcheck が healthy でも firewall ルール未適用の窓があり得る。これは
  意図された設計（接続性優先）であり**バグではない**が、healthy=「firewall も含め初期化完了」と
  誤解する余地がある。
- **修正案（🙋）**: 現状維持を推奨（sshd 可用性 = healthy が manage.sh の `--wait` と整合）。もし
  firewall 適用も保証したいなら別途 readiness マーカー（init-firewall 完了時に touch するファイルを
  healthcheck で確認）を足す案があるが、起動を遅らせるトレードオフ。記録のみ。

### 🟣 D-C-1 🤖: firewall コメントの DROP 順序記述が紛らわしい
- **対象**: `docker/s6-overlay/scripts/init-firewall.sh:85-87`
- **症状**: 「order among DROPs is irrelevant (all terminate), but every ACCEPT below must come first」
  は正しいが、`DROP_V4` 配列定義のすぐ上にあり「配列の並び順」と「チェイン投入順」が混同されやすい。
  実際の順序保証は `apply_v4`（ACCEPT を `-A` で先に積む）に依存する。
- **修正案（🤖）**: コメントを「ACCEPT は apply_v4/v6 で必ず先に投入される。この配列内の並びは
  到達順に影響しない」と明確化。

### 🟣 D-C-2 🤖: compose の cap_add コメントが kill switch 経路と二重で誤解を招く
- **対象**: `docker-compose.yml:54-56`
- **症状**: 「Remove this to fully disable the firewall (the script then fails open and warns)」と
  あるが、firewall の正規の無効化は `CLOOPY_FIREWALL=off`（クリーンに teardown）。NET_ADMIN 削除は
  「fail-open で警告だけ・既存ルールは残る」別経路で、無効化手段として案内すると CLAUDE.md
  134-135 行（`cap_add` を消すと fail-open になる＝望ましくない）と矛盾して読める。
- **修正案（🤖）**: コメントを「firewall を切るなら `CLOOPY_FIREWALL=off` を使う。NET_ADMIN を外すと
  firewall は fail-open（警告のみ・隔離なし）になるため非推奨」に修正。

### 🟣 D-C-3 🤖: `.zshenv` の devbox eval がインストール前に失敗し得る点が未記載
- **対象**: `assets/.zshenv:9`
- **症状**: `eval "$(devbox global shellenv ...)"` は `devbox` 未インストール時（bootstrap が
  まだ devbox を入れ終えていない / 失敗した初回 SSH ログイン）に `devbox: command not found` を
  毎ログイン吐く。SSH は bootstrap 完了前に繋がる設計（CLAUDE.md 52 行）なので現実に踏みやすい。
  致命的ではない（シェルは起動する）が、コメントも `command -v devbox` ガードもない。
- **修正案（🤖/🙋）**: 🤖 ならコメントで「bootstrap 完了前は未定義になり得る」と明記。🙋 なら
  `command -v devbox >/dev/null && eval "$(devbox global shellenv --preserve-path-stack -r)"` と
  ガードを足す（挙動変更なので 🙋 寄り）。

## 重要な設計の可視化

### boot シーケンス（s6 依存グラフ + 失敗パス）
```
S6_BEHAVIOUR_IF_STAGE2_FAILS=2  (Dockerfile:66 — どれか fail なら全停止)
        │
   base ─┘
        ▼
 init-permissions  (oneshot, set -euo pipefail)        scripts/init-permissions.sh
   │  ├─ passwd 書換え or usermod フォールバック         :48-55  (W-C-1: -g 漏れ)
   │  ├─ chown -R /home/developer  ◄── bind mount に再帰  :84-92  (E-C-1 🔴)
   │  └─ PUID/PGID 未検証で exit≠0 → 全停止              :13-14  (W-C-4)
   │
   ├──────────────┬───────────────┬──────────────┐
   ▼              ▼               ▼              ▼
 init-ssh-keys  init-firewall  init-workspace  svc-bootstrap
 (fail-CLOSED)  (fail-OPEN)    -check (warn)   (s6-setuidgid developer)
 鍵なし→exit1   NET_ADMIN無→   副作用なし       Nix/Devbox, リトライ3回
 = 起動失敗     warn+exit0                      失敗してもSSHは生存
 scripts:17-22  scripts:146-149  
   │
   ▼ (depends: init-ssh-keys のみ。firewall は依存にない)
 svc-sshd (longrun)  exec sshd -D -e            s6-rc.d/svc-sshd/run
   ▲
   └─ ★ 起動直後の窓: SSH 接続可だが firewall ルール未適用（CLAUDE.md:132-133, 設計上許容）

失敗時にユーザーが見るもの:
  鍵欠落      → [init-ssh-keys] ERROR + "Run ./manage.sh setup" 誘導 (良)
  NET_ADMIN無 → [init-firewall] WARN "egress is NOT restricted" (良, 起動継続)
  PUID不正    → set -e で無言に近い停止 (W-C-4: 誘導不足)
```

### firewall パケットフロー（DNS クエリの経路, CLOOPY-OUT チェイン)
```
アプリの egress パケット ─► OUTPUT ─► [-I 1 -j CLOOPY-OUT]  init-firewall.sh:153
                                          │ (上から評価, ACCEPT が先)
  ┌───────────────────────────────────────┤
  │ -o lo ─────────────► ACCEPT  :156   (127.0.0.11 埋込DNS への送出)
  │ ESTABLISHED,RELATED ► ACCEPT  :157   (戻り通信; conntrack 無なら下で保険)
  │ tcp --sport 22 ─────► ACCEPT  :159   ★SSH 応答の保険 (不変条件)
  │ host.docker.internal► ACCEPT  :167   (private DROP より前)
  │ -d DNS_V4 dport53 ──► ACCEPT  :180-181 (フィルタ resolver のみ)
  │ udp/tcp dport53 ────► DROP    :183-184 (他 resolver = ピン; v6 は別判定→W-C-2)
  │ -d 169.254/100.100/► DROP    :205-207 (IMDS/private; 公開IPは素通り)
  │   10/172.16/192.168/100.64
  └─ (no terminating) ─► RETURN ─► OUTPUT default ACCEPT (公開インターネット開放)

埋込DNS上流: 127.0.0.11 → (compose `dns:` がフィルタIPを指す) → DNS_V4 ACCEPT に合致
            compose の `dns:`(28-30) と firewall の DNS_V4(:49-50) が同 env を読むので同期
v6: fc00::/7(IMDS含む) DROP, fe80::/10 は意図的に開放(NDP/RA), ipv6-icmp ACCEPT(:238)
```

## 横断観点での所見
- **設計境界**: s6 依存グラフは CLAUDE.md の宣言と完全一致。fail-closed（ssh-keys）/ fail-open
  （firewall）の使い分けは一貫し意図的。`init-firewall` が sshd を依存に持たない＝起動窓は明文化済みで
  許容範囲。root 実行前提（bootstrap のみ非 root）も整合。
- **リソース所有権 (最重要)**: home ボリュームと bind mount の入れ子が E-C-1 の根本。authorized_keys
  では「bind mount を chown するな」を徹底したのに、`chown -R /home/developer` で同じ穴が再発している。
  marker 最適化のおかげで通常運用は安全だが、init-workspace-check が案内する UID 変更操作が
  ちょうど発火条件と重なる相互作用は要注意。
- **firewall 不変条件**: SSH 保険（`--sport 22` + ESTABLISHED の二段）と ACCEPT 先行順序、kill switch の
  teardown は健全。`apply_v4||true`/`apply_v6||true`（:291-292）で部分失敗が全体を止めない設計も妥当。
  唯一 W-C-2 の v4/v6 非対称が DNS ピンの完全性を損なう（デフォルトでは無害、ユーザー設定で露出）。
  env 値の iptables 注入は引用済みで rule 単位失敗に留まる（no `set -e`）ため実害は低いが、不正 IP の
  事前検証はない。
- **テスト網羅**: `firewall-dns.sh` は v4 ピン・host-allow 順序・fallback（無設定）を厚くカバー。
  欠落は (1) v4/v6 混在設定の非対称（W-C-2）, (2) UID 変更時の bind mount 所有権保全（E-C-1）。
  init-permissions / init-ssh-keys の自動テストは見当たらず（`boot-timing.sh` は起動時間計測中心）。
- **ドキュメント整合 (🟣)**: D-C-1（DROP 順序コメント）、D-C-2（cap_add コメントが kill switch と二重で
  CLAUDE.md と矛盾気味）、D-C-3（.zshenv の devbox 早期 eval）。いずれもコード無変更で直せる。

## セキュリティ向上の提案（却下済み案=allowlist/ポート遮断/承認ゲート以外, 比例性重視）

### W-C-3（再掲・最優先）: s6 tarball のチェックサム検証
- 得られる防御: PID 1 のサプライチェーン改竄検知。壊れ得るもの: なし（ビルド時のみ、SSH/manage.sh
  体験に無影響）。コスト: 3 ダイジェストの追従（更新スクリプト化推奨）。**最も比例性が高い。**

### S-C-1 🙋: `cap_drop: [ALL]` + 必要 cap だけ `cap_add`
- **対象**: `docker-compose.yml:57-58`
- 現状 default cap セットに NET_ADMIN を足すだけ。`cap_drop: ALL` してから `NET_ADMIN`（iptables 用）と
  sshd が必要とする最小限（`SETUID`/`SETGID`/`CHOWN`/`DAC_OVERRIDE`/`FOWNER`/`KILL` あたり）を足し直すと
  攻撃面が縮む。得られる防御: コンテナ内昇格・逸脱の難化。**壊れ得るもの（要検証・SSH 影響あり）**:
  sshd のログインは setuid/setgid/chown を使う。落としすぎると `ssh cloopy` でログイン不能になり得る
  ため、最小セットの実機検証（Approach B: `ssh cloopy` 疎通）が必須。init-permissions の chown も
  CHOWN/FOWNER を要する。コスト: cap セットの精査と回帰テスト。挙動変更大なので 🙋。

### S-C-2 🙋: NET_ADMIN をルール投入後に手放す案（ユーザー依頼の検討）
- **結論: 非推奨（コスト > 効果）**。理由:
  - `CLOOPY_FIREWALL=off`（kill switch）は **既存ルールの teardown を要する**ため、起動後に NET_ADMIN を
    失うと off へ切り替えても撤去できず、設定変更後の再作成が前提になる（compose の env 変更は元々
    再作成を要するので致命ではないが、「実行中コンテナが NET_ADMIN を持たない」状態は設定変更の
    再適用や将来の動的調整を不可能にする）。
  - s6 longrun に capability を後から落とす標準機構はなく、`capsh`/`setpriv` を噛ませる独自 run script が
    必要で、`no-new-privileges` との相互作用も検証コストが高い。
  - 得られる防御は「攻撃者がコンテナ内で root を取った後に iptables を書き換える」程度に限定的で、
    その時点で既に隔離前提が崩れている。**比例性が低い**。記録として「検討したが見送り」。

### S-C-3 🙋: read-only rootfs は不可（記録）
- bootstrap が `$HOME` に Nix/Devbox を書き、init-ssh-keys が `/etc/ssh/sshd_config.d/`・host key を
  毎起動書き、init-permissions が `/etc/passwd` を書き換える。`read_only: true` + tmpfs/volume の
  巧妙な切り分けが要るが、`/etc` 書換えがあるため労力大・体験を壊しやすい。**非推奨（記録のみ）**。

### S-C-4 🙋: sshd 追加強化の余地（小さく比例的）
- 現状 `cloopy.conf` は `PasswordAuthentication no` / `PermitRootLogin no` / `PermitEmptyPasswords no`
  と要点は押さえている（良）。追加候補: `AllowUsers developer`（developer 以外のログインを明示拒否、
  UID 0 化 W-C-4 への保険にもなる）、`X11Forwarding no`、`ClientAliveInterval`。
  得られる防御: 小〜中。壊れ得るもの: VS Code Remote SSH は developer ログインなので `AllowUsers
  developer` で問題なし（要確認）。コスト: 低。**比例的、検討推奨**。

### S-C-5 🙋: `pids_limit`/`mem_limit` の妥当性（記録）
- `pids_limit: 16384` / `mem_limit: 8g` は開発用途として妥当な上限。fork bomb/メモリ枯渇の host 巻き込み
  防止に寄与。**現状維持で良い**（指摘ではなく確認）。CPU 制限（`cpus`）は未設定だが開発体験優先で許容。
