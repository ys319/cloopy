---
group: E
topic: Docker イメージ / s6-overlay / firewall / 起動スクリプト
files_reviewed: 18
date: 2026-06-11
model: opus
---

# Group E: Docker / s6-overlay / firewall / 起動スクリプト

## サマリ
- 前回 (group-C, 6ca8102) の高優先指摘はいずれも丁寧に潰されている。**E-C-1**（chown
  -R が bind mount に再帰しホスト所有権を破壊）は `/proc/self/mountinfo` 解析 +
  `find -prune` で正しく解決され、机上シミュレーションでも host bind の除外 / named
  volume の維持 / グロブ文字 (`[v2]`) のエスケープがすべて期待どおり動作した。**W-C-1**
  （usermod フォールバックの `-g` 漏れ）、**W-C-3**（s6 tarball sha256 未検証）も解消、
  sha256 3 種は公式 v3.2.0.2 の `.sha256` と**完全一致を実機照合済み**（下記 §検証）。
- 一方で、E-C-1 の新実装には **3 つの低確率エッジケース**が残る: (1) host bind の
  source パスが `/volumes/<x>/_data` を含むと named volume と誤判定し**除外漏れ→再帰
  chown でホスト所有権破壊**（過剰除外＝危険方向）、(2) mountpoint に改行 (`\012`) を
  含むと `printf '%b'` 復号後に `read` ループが分割し prune が壊れる（同じく除外漏れ）、
  (3) これらは `printf '%b\0'` + `read -d ''` の NUL 区切りで一括解決できる。いずれも
  実運用での発火確率は極小（パスに改行/`_data` を含む構成）。
- **W-C-2（DNS ピン v4/v6 独立判定）は未解決**。`apply_v4`/`apply_v6` は系別 OR のまま
  で、`.env` 直編集で片系だけ空にすると他系 `:53` が素通りしフィルタを迂回できる。
  test/firewall-dns.sh にも混在ケースの追加はなし。**W-C-4（PUID/PGID 境界値）も未解決**。
- **W-C-1 は解消済み**（fallback に `-g` 追加 + コメント明記、742 のレビュー対象 diff で確認）。
- SSH 接続性を直接壊す指摘はなし。s6 依存グラフは CLAUDE.md と完全一致。`bash -n` は
  全スクリプト合格。manage.sh の Deno インストールはアトミック化（tmp dir→mv）+ unzip
  前提チェック + 実行検証が入り堅牢化（前回 W-A 系の維持を確認）。manage.bat も
  `-UseBasicParsing` 追加で IE エンジン依存を除去。
- 重大度件数: 🟢 9 / 🔵 3 / 🟡 3 / 🔴 0 / 💣 0
- ドキュメント軸: 🟣 2
- タグ別: 🤖 1 / 🙋 7

## ROADMAP 項目の現状判定
| ID | 前回内容 | 現状 |
|---|---|---|
| **W-C-2** | DNS ピン v4/v6 独立判定（片系のみ設定で他系 `:53` 素通り） | **未解決**。init-firewall.sh:179/256 は系別 OR のまま。test 拡張なし。再掲 (W-E-1) |
| **W-C-4** | PUID/PGID 境界値（0=root化 / 非数値）未検証 | **未解決**。init-permissions.sh:13-14 で検証なし。再掲 (W-E-2) |
| **S-C-4** | sshd 追加強化（`AllowUsers developer` 等） | **未対応**。cloopy.conf は前回同様 3 行（PasswordAuth/PermitRoot/PermitEmpty）。再掲 (S-E-1) |
| **L-C-1** | `${CLOOPY_PUBKEY_PATH}` の `:?` 化 | **未解決**。docker-compose.yml:48 はデフォルト値なしのまま。再掲 (L-E-1) |
| **L-C-2** | FIREWALL/ALLOW_HOST の表記揺れ正規化 | **未解決**。init-firewall.sh:75/166/245 は完全一致のまま（fail-safe 方向なので低優先据置）。再掲 (L-E-2) |
| W-C-1 | usermod フォールバックの `-g` 漏れ | ✅ **解消**（init-permissions.sh:56 に `-g "$PGID"` + コメント） |
| W-C-3 | s6 tarball sha256 未検証 | ✅ **解消・実機照合済**（Dockerfile:16-18, 60, 67/70。公式 .sha256 と一致） |
| E-C-1 | chown -R の bind mount 再帰 | ✅ **解消**（mountinfo 除外。ただし下記 W-E-3 の残エッジあり） |
| D-C-1 | DROP 順序コメント紛らわしい | ✅ **解消**（init-firewall.sh:85-89 で apply_v4 順序を明記） |
| D-C-2 | cap_add コメントが kill switch と二重 | ✅ **解消**（docker-compose.yml:59-63 で CLOOPY_FIREWALL=off 優先を明記） |
| D-C-3 | .zshenv の devbox 早期 eval | ✅ **解消**（assets/.zshenv:10 に `command -v devbox` ガード + コメント） |

## ファイル別分類
| 分類 | ファイル | 一言コメント |
|---|---|---|
| 🟡 Warning | docker/s6-overlay/scripts/init-permissions.sh:93-95 | host bind の source が `/volumes/*/_data` を含むと named volume 誤判定→除外漏れ→ホスト所有権破壊 (W-E-3) |
| 🟡 Warning | docker/s6-overlay/scripts/init-firewall.sh:179,256 | DNS ピン v4/v6 独立判定 — 片系のみ設定で他系 `:53` 素通り（W-C-2 再掲・未解決）(W-E-1) |
| 🟡 Warning | docker/s6-overlay/scripts/init-permissions.sh:13-14,32 | PUID/PGID 境界値（0・非数値）未検証（W-C-4 再掲・未解決）(W-E-2) |
| 🔵 Low | docker/s6-overlay/scripts/init-permissions.sh:97,118 | mountpoint に改行（`\012`）を含むと read ループが分割し prune 破綻（NUL 区切りで解決可）(L-E-3) |
| 🔵 Low | docker-compose.yml:48 | `${CLOOPY_PUBKEY_PATH}` を `:?` 化（L-C-1 再掲・未解決）(L-E-1) |
| 🔵 Low | docker/s6-overlay/scripts/init-firewall.sh:75,166,245 | FIREWALL/ALLOW_HOST 表記揺れ非寛容（L-C-2 再掲・fail-safe 方向）(L-E-2) |
| 🟣 Doc | docker/Dockerfile:66-67 | `TARGETARCH` の `*) → x86_64` フォールバックが armhf/riscv 等で誤アーキを掴む（コメント補足推奨）(D-E-1) |
| 🟣 Doc | .env.example:19 vs docker-compose.yml | `CLOOPY_SSH_BIND` の CLI 既定「ローカルのみ」と compose 既定「空=全 IF」の差が .env.example で読み取りにくい (D-E-2) |
| 🟢 Safe | docker/Dockerfile（sha256 ピン） | noarch/aarch64/x86_64 の 3 値が公式 .sha256 と完全一致。`sha256sum -c` で展開前に検証・fail で停止 |
| 🟢 Safe | docker/s6-overlay/scripts/init-permissions.sh（mountinfo 除外コア） | host bind 除外 / named volume 維持 / glob エスケープが机上検証で正しく動作。-h で symlink target 不触 |
| 🟢 Safe | docker/s6-overlay/scripts/init-ssh-keys.sh | staged copy + install -m600 -o PUID -g PGID、空/欠落で fail-closed、placeholder dir 自己修復。前回同様健全 |
| 🟢 Safe | docker/s6-overlay/scripts/init-firewall.sh（ルール順序・kill switch） | ACCEPT 先行・`--sport 22` 保険・ESTABLISHED 検証 WARN・teardown 完全撤去。awk 非依存も維持 |
| 🟢 Safe | docker/s6-overlay/scripts/init-workspace-check.sh | 警告のみ・chown せず。前回同様 |
| 🟢 Safe | docker/s6-overlay/scripts/bootstrap.sh | s6-setuidgid developer・curl リトライ・SSH と独立。変更なし |
| 🟢 Safe | docker/s6-overlay/s6-rc.d/** | 依存グラフ（base←init-permissions←{ssh-keys,firewall,workspace-check,bootstrap}, sshd←ssh-keys）が CLAUDE.md と一致 |
| 🟢 Safe | assets/.zshenv | devbox ガード追加で first-boot SSH のエラー連発を解消（D-C-3 解消） |
| 🟢 Safe | assets/CLAUDE.md | 規約どおり全文英語。内容も最新（Devbox/zsh/VS Code Remote）。指摘なし |
| 🟢 Safe | manage.sh / manage.bat | Deno アトミックインストール（tmp→mv）+ unzip 前提検査 + 実行検証。bat は UseBasicParsing 追加 |
| 🟢 Safe | test/firewall-phase1.sh / firewall-dns.sh | per-rule counter・:53 hole 閉鎖・kill switch・fail-open を厚くカバー。dns の `--add-host` 省略コメント追加は妥当 |

> Doc は重大度と独立軸。init-permissions.sh は W-E-2/W-E-3/L-E-3 を併記。

## 詳細指摘

### 🟡 W-E-3 🙋: host bind の source パスに `/volumes/*/_data` を含むと named volume 誤判定で除外漏れ
- **対象**: `docker/s6-overlay/scripts/init-permissions.sh:93-95`
- **症状**: `host_bind_mounts_under` は mountinfo の **root（4 列目 = ソース側パス）**が
  `*/volumes/*/_data` / `*/volumes/*/_data/*` にマッチすると named volume と判断して
  `continue`（= prune 対象から除外 = 再帰 chown の対象に含める）。これは「named volume の
  中身は container 所有でよい」という意図だが、判定が**パス文字列の部分一致**なので、
  ホスト bind の実体パスがたまたまこのパターンを含むと誤判定する。例:
  - ユーザーが `docker-compose.local.yml` で `~/docker/volumes/myproj/_data:/home/developer/x`
    のような bind を足す（Docker の volumes ディレクトリ配下を直接 bind するのは珍しくない）
  - workspace の実体が `…/volumes/foo/_data` 配下
  この場合、当該 bind は prune されず `chown -R` がホスト実ファイルへ再帰する = **E-C-1 で
  塞いだはずの「ホスト所有権破壊」が再発**（過剰除外＝危険方向の誤判定）。机上検証で
  `40 22 0:30 /home/user/docker/volumes/myproj/_data /home/developer/workspace …` を食わせると
  結果リストから当該 workspace が**消える**（=prune されない）ことを確認済み。
- **根本原因**: named volume と host bind の判別を root パスの substring で行っている。両者を
  確実に分けるには root パスではなく **mount の major:minor / mountinfo の super source や
  filesystem type、あるいは `optional fields` の `shared`/`master` ピアグループ**等の構造的
  シグナルが要るが、いずれも環境依存で確実ではない。
- **影響度**: 通常構成（compose 既定の workspace は `./workspace`、named volume は
  `…/volumes/<proj>_<name>/_data`）では発火しない。`docker-compose.local.yml` で volumes
  ディレクトリ配下を bind する非標準構成 + UID 変更/初回起動が重なったときのみ。確率は低いが
  **方向が危険**（ホストデータ破壊）なので Warning。
- **修正案（🙋）**:
  - 候補 A: named volume の root を「Docker/Podman の data-root を実際に解決して prefix 一致」
    で判定（`docker info` 相当の情報はコンテナ内にないため難しい。非推奨）。
  - 候補 B: パターンを厳格化し `^/var/lib/(docker|containers)/.*/volumes/[^/]+/_data(/|$)` 等の
    **絶対パス先頭一致**にする（少なくとも相対的な `~/docker/volumes/...` 直 bind は誤判定
    しにくくなる。ただし rootless の data-root は `~/.local/share/containers/...` なので
    prefix 列挙が要る）。
  - 候補 C（最も安全・推奨）: **判定を反転**し「named volume を含める」のではなく
    「`/home/developer` 直下の home-data 自体（mountpoint == base）と /nix は chown、
    それ以外の base 配下 mountpoint はすべて prune」にする。workspace-data named volume を
    `/home/developer/workspace` に重ねる構成では当該 volume も prune されてしまうが、
    その volume は init 時に空 or 既に正しい所有なので実害は限定的（要検証）。CLAUDE.md の
    「named volume は chown 対象維持」方針と衝突するため 🙋。
- **テスト**: fake mountinfo に「root が `/home/x/docker/volumes/y/_data` の host bind」を
  足して prune されること（=結果リストに残ること）を検証するケースを追加。

### 🟡 W-E-1 🙋: DNS ピンの v4/v6 独立判定（W-C-2 再掲・未解決）
- **対象**: `docker/s6-overlay/scripts/init-firewall.sh:179`（v4）/ `256`（v6）
- **現状**: 前回 W-C-2 から**コード変更なし**。`if [ ${#DNS_V4[@]} -gt 0 ]` と
  `if [ ${#DNS_V6[@]} -gt 0 ]` が系別 OR で独立し、片系だけ空にすると他系の `:53` DROP が
  入らない。`.env` で `CLOOPY_DNS_V6_PRIMARY=` だけ空にする経路（compose 既定は両系注入なので
  通常は無害だが直編集で露出）で **任意 IPv6 resolver への `:53` が素通り = マルウェア DNS
  フィルタのバイパス**。test/firewall-dns.sh にも混在ケースは未追加。
- **修正案（🙋）**: 前回候補 A/B/C のいずれか。最小は候補 B（片系のみ検出→WARN ログ + 未設定系
  を明示 `:53` DROP）。実装変更は数行。**ROADMAP 優先度「中」のまま据置が妥当**だが、firewall を
  次に触る際の同梱を推奨。
- **テスト**: firewall-dns.sh に「v6 のみ空 → 任意 IPv6 resolver `:53` の扱い」ケース追加。

### 🟡 W-E-2 🙋: PUID/PGID の境界値未検証（W-C-4 再掲・未解決）
- **対象**: `docker/s6-overlay/scripts/init-permissions.sh:13-14, 32, 50-51`
- **現状**: 前回 W-C-4 から**変更なし**。`PUID=0` で developer が root 化、`PUID=abc` で
  sed 不一致 → 後段 `chown abc:...` がエラー → `set -euo pipefail` で init-permissions が
  exit≠0 → 依存する ssh-keys/sshd が上がらず**起動失敗**。CLI バリデーション前提だが
  `.env` 直編集 / `docker run -e` 直叩きでガードが効かない。
- **修正案（🙋）**: 冒頭で `[[ "$PUID" =~ ^[0-9]+$ ]] && (( PUID >= 1 ))`（同 PGID）検証。
  不正なら 1000 へ fail-safe フォールバック or 明示エラー。UID 0 拒否は方針判断。

### 🔵 L-E-3 🙋: mountpoint に改行を含むと prune ループが分割される
- **対象**: `docker/s6-overlay/scripts/init-permissions.sh:97`（`printf '%b\n'`）+ `118`
  （`while IFS= read -r mnt`）
- **症状**: mountinfo は mountpoint の空白/タブ/改行/バックスラッシュを octal escape
  （`\040`/`\011`/`\012`/`\134`）で表す。`host_bind_mounts_under` は `printf '%b\n'` で復号
  するため、`\012`（改行）を含むパスは**実改行に復号され**、`chown_tree` の
  `while IFS= read -r mnt` が 1 パスを 2 行に分割する。机上検証で `…/two\012lines` を流すと
  prune エントリが本来 4 個のところ 8 個（`…/two` と `lines` の 2 パス分）になり、**当該 bind
  は prune されず chown される**（除外漏れ）。バックスラッシュ単体（`\134`）の復号自体は
  正しく動作することは確認済み（`glob_escape` が再エスケープ）。
- **根本原因**: NUL 以外を区切りに使う改行ベースのパイプライン。
- **修正案（🤖 寄りだが挙動に関わるので🙋）**: `host_bind_mounts_under` を `printf '%b\0'`、
  `chown_tree` の読み取りを `while IFS= read -r -d '' mnt` に変える（NUL 区切り）。find は既に
  `-print0`/`xargs -0` で NUL 安全なので整合する。確率は極小（パスに改行）だが、入れるなら
  NUL 化が筋。
- **テスト**: fake mountinfo に `\012` を含む mountpoint を足し prune が 1 エントリに収まること。

### 🔵 L-E-1 🙋: `${CLOOPY_PUBKEY_PATH}` 未設定時の compose エラーが不親切（L-C-1 再掲・未解決）
- **対象**: `docker-compose.yml:48`
- **現状**: 前回 L-C-1 から変更なし。`${CLOOPY_PUBKEY_PATH}:/etc/cloopy/authorized_keys:ro,z`
  はデフォルト値を持たない唯一の必須変数。doctor で拾える前提だが compose 直叩きで不明瞭。
- **修正案（🙋）**: `${CLOOPY_PUBKEY_PATH:?run ./manage.sh setup}` 化。manage.sh 経路に無影響。

### 🔵 L-E-2 🙋: FIREWALL/ALLOW_HOST の表記揺れ非寛容（L-C-2 再掲・未解決）
- **対象**: `docker/s6-overlay/scripts/init-firewall.sh:75`（`= "off"`）, `166`/`245`（`= "on"`）
- **現状**: 変更なし。`CLOOPY_FIREWALL=Off`/`OFF` は「off 以外」= ON 扱い（fail-safe 方向）。
  `CLOOPY_ALLOW_HOST` は `"on"` 完全一致で `On` は host 遮断（fail-closed）。前回どおり
  「厳密一致 = タイポは安全側」も妥当な方針なので**低優先据置で問題なし**。

### 🟣 D-E-1 🤖: Dockerfile の arch フォールバックが armhf/riscv 等で誤アーキを掴む
- **対象**: `docker/Dockerfile:66-67`
- **症状**: `case "${TARGETARCH}" in arm64) aarch64;; *) x86_64;; esac` は **arm64 以外を
  すべて x86_64 とみなす**。armhf / riscv64 / ppc64le / s390x でビルドすると x86_64 tarball を
  掴み、sha256 は一致するが**実行不能なバイナリが PID 1 になる**（あるいは tar 展開後に
  `/init` が exec 不能で即死）。cloopy は amd64/arm64 のみ想定なので実害はほぼないが、
  sha256 ピンの「不正アセットを弾く」恩恵が arch ミスマッチには効かない点はコメントすべき。
- **修正案（🤖）**: コメントで「amd64/arm64 のみサポート。他 arch はビルド非対応」と明記する
  か、`*) echo "ERROR: unsupported TARGETARCH" >&2; exit 1`（🙋: ビルド失敗にするのは挙動変更）。
  最小は Dockerfile 冒頭 or この RUN にコメント 1 行。

### 🟣 D-E-2 🤖: `.env.example` の CLOOPY_SSH_BIND 既定説明と compose 既定の差が読み取りにくい
- **対象**: `.env.example:17-23` と `docker-compose.yml:14`
- **症状**: `.env.example` は `127.0.0.1:` を「CLI default for new setups」、`(empty/unset)` を
  「all interfaces … reachable from the LAN」と説明するが、**変数をコメントアウトした状態
  （`# CLOOPY_SSH_BIND=127.0.0.1:`）= compose 既定では空 = 全 IF 公開**になる。つまり
  「素の `docker compose` 利用者」と「`manage.sh` 利用者」で既定が逆（CLAUDE.md の
  「素の docker compose は従来挙動=全 IF」とは整合しているが、.env.example だけ読むと
  `127.0.0.1:` が既定と誤読しやすい）。
- **修正案（🤖）**: `.env.example` のコメントに「変数未設定（この行をコメントのまま）だと全 IF
  公開。ローカルのみにするには行を有効化して `127.0.0.1:` を設定」と明記。CLAUDE.md は
  Group E 対象外のため編集しない（並列レビュー配慮）。

## 重要な設計の可視化

### init-permissions: mountinfo 解析 → 除外リスト → chown フロー（行番号付き）
```
set -euo pipefail (init-permissions.sh:2)
   │
   ▼
[1] UID/GID 調整 (:32-58)
   ├─ groupmod -o -g PGID (新GIDなら) ............ :44  (FS 非走査・高速)
   ├─ sed で passwd の uid:gid 書換え (成功パス) .. :51
   └─ else: usermod -o -u PUID -g PGID (fallback) :56  ◄ W-C-1 解消（-g 追加済）
                                                       ◄ ただし PUID 未検証 = W-E-2
   ▼
[2] ボリューム所有権修正 (:60-157)
   CURRENT_OWNER="${PUID}:${PGID}" (:63)
   │
   ├─ host_bind_mounts_under(base) (:86-99)
   │     /proc/self/mountinfo を read:  _id _parent _dev root mnt _rest
   │       mnt が "$base"/* でなければ continue ........ :89-92
   │       root が */volumes/*/_data(/*) なら continue .. :93-95  ◄ W-E-3
   │            (named volume = chown 対象に残す意図。だが root の部分一致なので
   │             host bind の source が偶然このパターンだと誤除外→所有権破壊)
   │       printf '%b\n' "$mnt"  (octal \040 等を復号) .. :97   ◄ L-E-3
   │            (\012=改行も復号 → 下の read が分割)
   │
   ├─ glob_escape(s) (:104-111)  \ * ? [ をエスケープ
   │     机上検証: "proj[v2]" → "proj\[v2\]" で find -path が正しく prune ✓
   │
   ├─ chown_tree(base) (:115-132)
   │     while IFS= read -r mnt < host_bind_mounts_under: ... :118  ◄ L-E-3
   │        prune+=(-path "$(glob_escape "$mnt")" -prune -o)  :120
   │     prune 空 → timeout 300 chown -R PUID:PGID base ..... :124
   │     prune 有 → timeout 300 find base PRUNE -print0
   │                  | xargs -0 -r chown -h PUID:PGID ...... :129-130
   │                  (-h: symlink 自体を chown・target 不触)
   │                  (pipefail で find timeout(124) を伝播)
   │
   ├─ MARKER 一致 (UID 不変) → 再帰 chown スキップ・top-level のみ :134-141 (安全)
   └─ MARKER 不一致 (初回/UID変更) → chown_tree、失敗時 top-level :142-157
         fallback chown はマウント境界(base)のみ = bind 不触 (安全)
   ▼
[3] /run/sshd・~/.ssh 作成 + chmod 700 + chown (:159-165)
```

### firewall パケットフロー（W-C-2 該当箇所を明示）
```
egress ─► OUTPUT ─► [-I 1 -j CLOOPY-OUT]  apply_v4:155 / apply_v6:235
            │ (上から評価, ACCEPT が先)
  ├ -o lo ───────────────► ACCEPT  :158 / :237
  ├ ESTABLISHED,RELATED ──► ACCEPT  :159 / :238  (検証 WARN :212 / :278)
  ├ (v6) ipv6-icmp ──────► ACCEPT  :240  (NDP/RA 維持)
  ├ tcp --sport 22 ──────► ACCEPT  :161 / :241  ★SSH 保険(不変条件)
  ├ host.docker.internal ► ACCEPT  :169 / :248  (private DROP より前)
  ├ DNS_V4 dport53 ──────► ACCEPT  :182-183     (フィルタ resolver のみ)
  │ udp/tcp dport53 ─────► DROP    :185-186  ◄─┐ v4 ピン
  ├ DNS_V6 dport53 ──────► ACCEPT  :259-260     │ ★ v4/v6 が独立判定 (W-E-1)
  │ udp/tcp dport53 ─────► DROP    :262-263  ◄─┘ 片系空だと他系 :53 が DROP されず素通り
  └ DROP_V4/V6 (169.254/100.100/RFC1918/CGNAT/fc00::/7/fec0::/10) :207-209 / :274-276
     │
     └─ no terminating → RETURN → OUTPUT default ACCEPT (公開インターネット開放)
```

## 横断観点での所見
- **所有権 / SELinux 意味論（最重要）**: E-C-1 の mountinfo 除外は設計意図どおり機能し、
  机上シミュレーションで host bind 除外・named volume 維持・グロブエスケープ・`-h` symlink
  不触をすべて確認した。残る W-E-3（root パス部分一致による named volume 誤判定）と L-E-3
  （改行パスの read 分割）は**いずれも「除外漏れ→ホスト所有権破壊」方向**で、E-C-1 が塞いだ
  穴の縁に残る低確率ケース。NUL 区切り化（L-E-3）と判定の絶対パス先頭一致 or 反転（W-E-3）で
  閉じられる。SELinux の `z` フラグ運用（compose:41-43, 48/50/51/55）は CLAUDE.md と一致、
  ワークスペース `$HOME` 拒否は CLI 側（Group B/A 範囲）で担保。
- **firewall 不変条件**: ACCEPT 先行・`--sport 22` 二段保険・ESTABLISHED 検証 WARN・kill
  switch の teardown 完全性は前回どおり健全。`apply_v4||true`/`apply_v6||true`（:293-294）の
  部分失敗許容、fail-open（NET_ADMIN 欠落）も妥当。唯一 W-C-2（v4/v6 非対称）が DNS ピンの
  完全性を損なうが**デフォルト compose では両系注入で無害**、`.env` 直編集時のみ露出。
- **サプライチェーン**: s6 sha256 3 値は公式 v3.2.0.2 の `.sha256` と**完全一致を実機照合
  （WebFetch）**。`ADD`（noarch）→ `sha256sum -c`（Dockerfile:60）、`wget`（arch）→
  `sha256sum -c`（:70）で展開前検証・fail 時は `&&` チェーンで RUN が停止 = ビルド失敗。
  ピン更新運用はコメント（:11-14）で `.sha256` 追従を案内済み。残る穴は arch フォールバック
  （D-E-1）のみで amd64/arm64 限定運用では無害。
- **s6 依存グラフ**: 実体（s6-rc.d/）は CLAUDE.md 記載のツリーと完全一致。oneshot
  （init-*/svc-bootstrap）/ longrun（svc-sshd）区分、`with-contenv`、`s6-setuidgid developer`
  （bootstrap のみ非 root）、`init-firewall` が sshd を依存に持たない（起動窓は設計上許容）
  すべて整合。Dockerfile:103-104 の `chmod +x`（scripts 全部 + up/run）も過不足なし
  （data/dependencies.d は exec 不要）。
- **manage.sh / manage.bat**: Deno インストールが tmp dir → `mv -f` のアトミック化 +
  unzip 前提検査 + `--version` 実行検証で、前回 W-A 系（中途半端な壊れバイナリで再
  インストールがスキップされる）の対策を維持・強化。trap で tmp/zip を確実掃除。bat 側は
  `Invoke-WebRequest -UseBasicParsing` 追加で IE エンジン未初期化環境での失敗を回避。
  どちらもエラー時メッセージは具体的で誘導が効く。
- **assets**: `.zshenv` は `command -v devbox` ガードで first-boot SSH のエラー連発を解消
  （D-C-3 解消）。`CLAUDE.md` は規約どおり全文英語で内容も最新。
- **テスト網羅**: firewall-phase1/dns は per-rule counter・:53 hole 閉鎖・kill switch
  teardown・fail-open を厚くカバー。`firewall-dns.sh` の fallback コンテナで `--add-host` を
  あえて省く意図がコメント化された（:123-124）のは妥当。欠落は前回同様 (1) v4/v6 混在設定の
  非対称（W-E-1）、(2) UID 変更時の bind mount 所有権保全（E-C-1 は fake mountinfo の単体
  シミュレーションがあるが、実コンテナでの host stat 不変アサーションは boot-timing 系に
  未統合）。init-permissions の mountinfo パスを試験する単体ハーネスがあると W-E-3/L-E-3 を
  回帰で守れる。

## セキュリティ向上の提案（却下済み案 = allowlist / ポート遮断 / 承認ゲート以外、比例性重視）

### S-E-1 🙋: sshd 追加強化（S-C-4 再掲・未対応）
- **対象**: `docker/s6-overlay/scripts/init-ssh-keys.sh:45-49`（cloopy.conf）
- 現状 `PasswordAuthentication no` / `PermitRootLogin no` / `PermitEmptyPasswords no` の 3 行。
  追加候補: `AllowUsers developer`（developer 以外を明示拒否、W-E-2 の UID 0 化への保険にも）、
  `X11Forwarding no`、`ClientAliveInterval`。VS Code Remote SSH は developer ログインなので
  `AllowUsers developer` で問題なし（実機要確認）。**比例的・低コスト、検討推奨**。

### S-E-2 🙋: W-C-2 のフィルタバイパス閉鎖（DNS ピン v4/v6 整合）
- W-E-1 の修正は「マルウェア DNS フィルタの完全性」に直結するセキュリティ向上でもある。
  デフォルトでは無害だが `.env` 直編集で片系を空にすると無フィルタ resolver へ切替可能に
  なる穴。候補 B（片系のみ検出→未設定系を `:53` DROP + WARN）が最小・比例的。

### S-E-3（記録）: arch フォールバックの fail-fast 化
- D-E-1 を「コメント」ではなく「未サポート arch はビルド失敗」にすると、誤アーキの実行不能
  PID 1 を build 段階で弾ける。挙動変更のため 🙋。得られる防御は小（amd64/arm64 限定運用では
  発火しない）。記録のみ。

## 検証（このサンドボックスで実施した静的検証）
- `bash -n`: docker/s6-overlay/scripts/*.sh + test/*.sh + manage.sh **全合格**。
- **mountinfo 机上シミュレーション**（fake `/proc/self/mountinfo` を `$TMPDIR` で実行）:
  - host bind（workspace/.zshenv/.claude/CLAUDE.md/`proj[v2]`）の検出 ✓
  - named volume（`…/volumes/<name>/_data` を root に持つ home-data/workspace-data）の除外維持 ✓
  - `glob_escape` + `find -path -prune` で `proj[v2]` がディレクトリごと完全 prune（エスケープ
    なしだと中身まで列挙される＝バグ再現も確認）✓
  - **W-E-3 再現**: root が `/home/user/docker/volumes/myproj/_data` の host bind が結果から
    脱落（=prune されず chown 対象になる）✓
  - **L-E-3 再現**: mountpoint `…/two\012lines` が改行復号で read 分割 → prune 8 エントリ（本来
    4）に膨張 ✓
- **sha256 照合（WebFetch）**: 公式 v3.2.0.2 の noarch/x86_64/aarch64 `.sha256` と Dockerfile の
  3 ARG が**完全一致**。
- **docker は使用不可**のため、firewall ルールの実投入・実コンテナ起動・所有権実測は未実施
  （**実機検証必須**: W-E-3/L-E-3 の実コンテナ再現、W-E-1 の片系空での `:53` 挙動、S-E-1 の
  `AllowUsers developer` での VS Code Remote SSH 疎通）。
