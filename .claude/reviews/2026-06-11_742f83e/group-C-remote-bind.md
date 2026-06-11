---
group: C
topic: リモート接続プロファイル + SSH 公開範囲 (CLOOPY_SSH_BIND)
files_reviewed: 4 (主) + 4 (横断)
date: 2026-06-11
model: opus
---

# Group C: リモート接続プロファイル + SSH 公開範囲 (CLOOPY_SSH_BIND)

## サマリ
- 全体として設計は堅牢。ROADMAP G Phase 3 で「修正済み」とされた 8 点はいずれも
  実装に存在することを追試で確認した（詳細は末尾の追試表）。store load 時の
  再検証・名前空間衝突ガード・ホスト鍵指紋確認・TOFU 時の旧鍵削除・削除順序
  config→store・doctor の IPv6 bind 受理・カスタム bind 非上書き・docker
  デーモン停止の除外、すべて OK。
- ただし入力検証に **2 つの穴** がある: (1) `validateRemoteHost` がハイフン
  始まりのホスト名（`-G`・`--`・`-D` 等の単独フラグ形）を受理し、`scanRemoteHostKeys`
  が `--` セパレータなしで ssh-keyscan に渡す（実害は限定的だが深層防御の綻び）。
  (2) `identityFile` パスが改行・空白の検証を受けずに SSH config の `IdentityFile`
  行へ生に流れる（自己攻撃のみ・特権境界なしだが name/host とは非対称）。
- `hasHostBlock` ベースの名前空間衝突ガードは cloopy 管理ブロック（マーカー付き）
  しか検出しないため、ユーザ手書きの素の `Host <name>` ブロックや大文字差・
  複数パターン行は検出しない。設計意図（ローカルインスタンス＝マーカー管理）の
  範囲では機能するが、想定外の手編集ケースを取りこぼす。
- 重大度件数: 🟢 5 / 🔵 3 / 🟡 2 / 🔴 0 / 💣 0
- ドキュメント軸: 🟣 2
- タグ別: 🤖 0 / 🙋 3

## ファイル別分類
| 分類 | ファイル | 一言コメント |
|---|---|---|
| 🟡 Warning | cli/lib/remote.ts:114-122, 146-156 | `validateRemoteHost` がハイフン始まり host を受理 + keyscan に `--` 無し |
| 🔵 Low | cli/commands/remote.ts:151-166, 235-238 | identityFile パスの改行/空白を未検証で config 行へ |
| 🔵 Low | cli/commands/remote.ts:107-117 | 名前衝突ガードが marker 管理ブロックのみ・大文字差・複数パターン行を取りこぼす |
| 🔵 Low | cli/commands/remote.ts:222-238 | add の永続化順序 (store→known_hosts→config) が remove と逆・理由が未文書化 |
| 🟢 Safe | cli/lib/remote.ts (store load/validators) | 再検証は堅牢・JSON null/配列も安全に弾く |
| 🟢 Safe | cli/lib/remote_test.ts | 11 件全 pass・死んだ assertion なし・縛りも妥当 |
| 🟢 Safe | cli/main.ts | dockerMissing 分岐は detail==="not found" と厳密一致・デーモン停止は除外 |
| 🟢 Safe | cli/commands/doctor.ts (bind 検証) | v4/v6/空 を正確に判定・コロン漏れ/範囲外/DNS 名を拒否 |
| 🟢 Safe | cli/commands/setup.ts (bind 既定) | `bindSet && currentBind===""` で安全側既定・readEnvFile は .env のみ参照 |
| 🟣 Doc | cli/commands/remote.ts:222-234 | add の順序ロジックにコメントが無い（remove には有る） |
| 🟣 Doc | cli/commands/doctor.ts:113-116 | `0.0.0.0:` を受理するが IPv6 を黙って落とす旨の警告が doctor に無い |

> settings.ts は横断参照のみ（主担当外）。bind ラベル表示・keep 選択肢は
> setup と意味論一致を確認、指摘なし。

## 詳細指摘

### 🟡 W-C-1 🙋: `validateRemoteHost` がハイフン始まりホストを受理し keyscan に `--` 無しで渡る
- **対象**: `cli/lib/remote.ts:114-122`（バリデータ）+ `cli/lib/remote.ts:146-156`（keyscan 呼び出し）
- **症状**: 文字集合が `^[A-Za-z0-9._:-]+$` のため `-G` `--` `-D` `-4` `-T` 等の
  「ハイフン始まり = ssh-keyscan/ssh のオプション形」が検証を通過する。
  `scanRemoteHostKeys` は `args: ["-p", port, "-T", "5", host]` と host を
  **`--` セパレータ無しで末尾 positional** に置くため、host が `-G` なら
  ssh-keyscan は `-G` オプションとして解釈する。
- **根本原因**: `validateRemoteHost` は空白・`#`・`=` は弾くが「先頭ハイフン」を
  許す。`testConnection`（remote.ts:47-56）は `ssh` 呼び出しで `--` を入れて
  いるのに、`scanRemoteHostKeys` には `--` が無い（非対称）。
- **実害評価**: 実測では `-G`/`-f`（引数欠落）は usage エラーで非ゼロ終了、
  `-D`/`-`/`--` は接続失敗か空結果になり `lines.length===0` で `ok:false` に
  落ちる。ssh-keyscan には「末尾 positional に来ると危険な副作用を起こす」
  フラグが無いため**現状はコマンドインジェクション不成立**。ただし validator
  が「config を壊す入力を弾く」と謳う以上、ハイフン始まりを通すのは設計の穴。
  将来 keyscan のフラグが増える／別コマンドへ host を流す箇所が増えると顕在化。
- **修正案**:
  - 候補 A（最小・推奨）: `scanRemoteHostKeys` の args を
    `["-p", port, "-T", "5", "--", host]` にして positional を固定（ssh-keyscan は
    `--` を受理する）。`testConnection` と対称になる。
  - 候補 B: `validateRemoteHost` で先頭ハイフンを拒否（`if (t.startsWith("-")) return "..."`）。
    DNS 名・IP は先頭ハイフン非合法なので副作用なし。A と B 併用が堅い。
- **テスト**: `validateRemoteHost("-G")` / `"--"` / `"-"` が string（拒否）を返す
  ことを `remote_test.ts` の「config を壊す入力を拒否」に追加。

### 🔵 L-C-1 🙋: identityFile パスの改行・空白が SSH config 行へ未検証で流れる
- **対象**: `cli/commands/remote.ts:151-166`（identity 入力 validate）+ `:235-238`
  （`injectSshConfig` への引き渡し）。実際の行生成は `cli/lib/ssh.ts:buildHostBlock`
  （Group A 主担当）。
- **症状**: identity の validate は `Deno.statSync(expandHome(t)).isFile` だけを
  見る。パス文字列の改行・空白は検査しない。改行を含むパス
  （`/home/u/key\n    ProxyCommand evil`、Unix では作成可能なファイル名）を
  入力すると `IdentityFile` 行の後に任意の SSH config ディレクティブ
  （ProxyCommand 等）が注入される。実測で再現確認済み。空白を含む正当な
  パス（`/home/u/my key`）も無引用で `IdentityFile /home/u/my key` となり
  ssh が 2 トークンに割る（正当ユースケースの潜在バグ）。
- **根本原因**: name/host/port は config 行破壊を厳格に弾くのに identityFile
  だけ「存在チェックのみ」で非対称。`buildHostBlock` 側も値を引用しない。
- **実害評価**: 特権境界を跨がない（ユーザ自身の SSH config をユーザ自身が
  壊すだけ）ため Low。ただし「config を壊さない」という他バリデータの不変条件
  と矛盾し、空白パスは善意ユーザでも踏む。
- **修正案**:
  - 候補 A: identity validate に「改行・復帰を含むパスを拒否」を追加（remote 側で
    完結・担当ファイル内）。
  - 候補 B: `buildHostBlock` で IdentityFile 値を二重引用（ssh は引用パスを受理）。
    Group A 主担当 — 空白パス対応も同時に解決。A+B 併用が理想。
- **テスト**: 改行入りパスが validate で拒否される単体テスト。

### 🔵 L-C-2 🙋: 名前空間衝突ガードが marker 管理ブロックしか検出しない
- **対象**: `cli/commands/remote.ts:107-117`（`hasHostBlock(readCloopyConfig(), name)`）
- **症状**: `hasHostBlock`（ssh.ts:302-306）は `# --- name ---\nHost name\n` の
  **マーカー付きブロックのみ** に一致する。実測で確認:
  - 素の `Host cloopy`（マーカー無し・ユーザ手書き）→ 検出されない
  - `Host cloopy othername`（複数パターン行）→ 検出されない
  - `Host Cloopy`（大文字差）→ `hasHostBlock(..., "cloopy")` は false
  さらに store 内の衝突判定 `find((r) => r.name === name)`（remote.ts:107）と
  setup 側 `remoteNames.includes(v)`（setup.ts:187）は**大文字小文字区別**なので、
  ローカル `cloopy` とリモート `Cloopy` が共存登録できる。
- **根本原因**: ガードの守備範囲が「cloopy 管理の local インスタンスブロック」に
  限定されている。設計意図（ローカルインスタンス＝必ず marker 管理）の範囲では
  正しく機能するが、ユーザが cloopy 管理外の同名 Host を持つ／大文字差で別名を
  作るケースを取りこぼす。SSH の Host パターンは大小区別なのでアプリ的には別名
  として機能し、実害は限定的。
- **実害評価**: ローカルインスタンスを上書きする主経路（marker 管理ブロック）は
  守られているため Low。取りこぼすのは「ユーザ手書きの素 Host」「大文字差」で、
  いずれも `ssh <name>` の宛先が二重定義/別名になる程度。
- **修正案**: 🙋 判断要。
  - 候補 A（現状維持）: 設計意図どおりとして許容。ただし「marker 管理ブロックのみ
    検出」をコメントで明示。
  - 候補 B: 衝突判定を小文字正規化し、`hasHostBlock` をマーカー非依存の素の
    `Host` 行検出に拡張（誤検出＝ユーザの正当な無関係 Host を弾くリスクとの
    トレードオフ）。汎用開発環境では B は誤遮断を招きやすく、A 寄りが妥当か。
- **テスト**: 大文字差の store エントリ + ローカルインスタンス名の共存可否を
  明示するテスト（現挙動を pin）。

### 🔵 L-C-3 🙋: add の永続化順序が remove と逆・不変条件が未文書化
- **対象**: `cli/commands/remote.ts:222-238`
- **症状**: `removeEntry` は config→known_hosts→store の順序とその理由
  （途中失敗でも store に残し再削除可能にする）を明記（:274-277）。一方
  `addOrUpdate` は store(:227)→known_hosts(:228-234)→config(:235) の逆順で、
  コメントが無い。
- **根本原因**: 設計としては逆順で**正しい** — `injectSshConfig` が途中で
  throw しても「store にエントリあり・config にブロック無し」となり、これは
  remove 不変条件と同じ「回復可能側」（再 add で `existing` ヒット、または
  一覧表示→削除が可能）。ただし add 側にその意図の記述が無いため、将来の
  改変で順序が壊れても気づけない。
- **修正案**: add 側に remove と同趣旨のコメント（「store を先に確定し config を
  後にするのは、途中失敗でもエントリを store に残して回復可能にするため」）を
  追加。挙動変更なし。
- **テスト**: 不要（ドキュメントのみ）。

### 🟣 D-C-1 🤖: add の順序ロジックにコメントが無い
- **対象**: `cli/commands/remote.ts:222-234`
- **症状**: L-C-3 と同根。remove には順序の根拠コメントがあるが add には無い。
- **修正案**: コメント追加のみ（担当ファイル内・🤖 可だが L-C-3 の判断に従属）。

### 🟣 D-C-2 🙋: doctor が `0.0.0.0:` を受理するが IPv6 脱落を警告しない
- **対象**: `cli/commands/doctor.ts:113-116`
- **症状**: doctor の bind 検証は `0.0.0.0:` を ACCEPT する（compose 的には正当な
  port 文字列）。だが CLAUDE.md と compose コメントは「`0.0.0.0:` は IPv4 のみに
  なる罠」と明記しており、doctor はこれを素通しする。UI（setup/settings）は
  `0.0.0.0:` を生成しないので実害は手編集ユーザのみ。
- **修正案**: doctor で `v === "0.0.0.0:"` のとき info レベルで「IPv6 が公開され
  ません。全 IF 公開なら空文字にしてください」と案内（任意・🙋）。

## 重要な設計の可視化

リモート登録フロー（入力検証 → keyscan/指紋 → known_hosts 固定 → config 注入 → store 保存）:

```
[ユーザ入力]
   │
   ▼
エントリ名 name         remote.ts:100-105  validate: validateRemoteName
   │                                       (英字始まり・英数_- のみ・≤64)
   ▼ (重複/衝突ガード)
store に existing? ──no──► hasHostBlock(config, name)?  remote.ts:107-117
   │ yes                       │ yes                     ⚠ L-C-2: marker 管理
   ▼                           ▼                            ブロックのみ検出
上書き確認 Confirm          ローカル用として拒否 return
   │ (no→return)
   ▼
リモートホスト hostName   remote.ts:127-132  validate: validateRemoteHost
   │                                         ⚠ W-C-1: 先頭ハイフン許容
   ▼
SSH ポート port          remote.ts:134-138  validate: validateRemotePort (1-65535)
   │
   ▼
秘密鍵 identityFile      remote.ts:151-166  validate: statSync().isFile のみ
   │                                         ⚠ L-C-1: 改行/空白 未検証
   ▼
scanRemoteHostKeys(host, port)              remote.ts:170 → lib/remote.ts:146
   │   ssh-keyscan -p port -T 5 host        ⚠ W-C-1: "--" 無し
   ├── ok=true ─► 指紋 SHA256 表示          remote.ts:175-181 fingerprintSha256
   │               │
   │               ▼ Confirm(default:false) remote.ts:189-192  ← 信頼 default:No (OK)
   │               │ no→return
   │               ▼ knownHostsLines = scan.lines
   │
   └── ok=false ─► TOFU 確認 Confirm(default:false)  remote.ts:207-212
                     │ no→return / yes→knownHostsLines=null
   ▼
profile 構築 + saveRemoteStore(store)       remote.ts:215-227   ← ① store 永続化
   │                                                              (atomic 0600)
   ▼
knownHostsLines?                            remote.ts:228-234   ← ② known_hosts
   ├── あり ─► upsertHostsKnownHosts(name,host,port,lines)        固定 (Group A)
   └── なし ─► removeKnownHostsEntry(name)   (TOFU: 旧 pin 削除)
   ▼
injectSshConfig(port, name, {hostName, identityFile})  remote.ts:235-238  ← ③ config
   │                                         ⚠ L-C-3: 順序 ①②③ は remove の逆
   ▼                                            (回復可能側に倒れる・意図は正しい)
接続テスト Confirm(default:true) → testConnection(name)  remote.ts:245-249
                                   ssh -o BatchMode=yes -- name exit  (✓ "--" 有り)
```

削除フロー（config→known_hosts→store・回復可能順序）:
```
removeSshConfigEntry(name)   remote.ts:278  ← ① config ブロック除去
   ▼
removeKnownHostsEntry(name)  remote.ts:279  ← ② marker 行のみ除去
   ▼
store.remotes.filter + save  remote.ts:280-281  ← ③ store から除去
（途中失敗 → store にエントリ残存 → 再削除可能。逆順なら config に孤児ブロック残）
```

## 横断観点での所見
- **設計境界**: remote.ts は ssh.ts（Group A）の純粋関数群（`upsertKnownHosts`/
  `injectSshConfig`/`hasHostBlock`/`parseKeyscanOutput`）を呼ぶだけで、known_hosts/
  config の実書き込みロジックは持たない。境界は明快。W-C-1 の `--` 欠落と L-C-1 の
  identityFile 引用は **ssh.ts 側（Group A）でも直せる**論点があり、remote 側
  （バリデータ）でも直せる二択。最終判断は親オーケストレータへ。
- **入力検証**: store load 時再検証（remote.ts:63-82）は raw 値の trim 一致まで
  要求し、JSON null/配列/version 不一致/欠損フィールドを安全に弾く。手編集
  パストラバーサル（`../`）・オプション注入（`-o...` は `=` で弾く）・範囲外 port を
  入口で潰す設計は健全。唯一の穴がハイフン始まり host（W-C-1）。
- **セキュリティ境界**: ホスト鍵は keyscan→SHA256 指紋表示→ユーザ確認（default:No）
  →標準 known_hosts 固定、の MITM 対策フローが正しく実装されている。TOFU
  フォールバック時は旧 pin を削除（remote.ts:233）し接続先変更後の mismatch を
  防ぐ。指紋計算（keys.ts:fingerprintSha256）も OpenSSH 形式（生鍵 blob の SHA-256・
  unpadded base64）で正確。
- **CLOOPY_SSH_BIND 三者一貫性**: compose（末尾コロン込み・空=全 IF）/ doctor
  検証（v4/v6/空を正確判定）/ setup 既定（安全側「いいえ」・明示空保存時のみ「はい」）/
  settings ラベル（空=LAN・LOCAL_BIND=ローカル・他=カスタム値表示）が一貫。
  24bd127 の「既存 .env 再 setup でも既定いいえ」も `bindSet && currentBind===""`
  で正しく実装（readEnvFile は .env のみ参照のため Deno.env 汚染の懸念なし）。
- **main.ts リモート専用モード**: `dockerMissing` は `dockerResult.detail === "not found"`
  と厳密一致（doctor.ts:350）。`checkDocker` は `Deno.errors.NotFound` のときだけ
  `"not found"` を返し、デーモン停止は `"not responding"` なので、Docker Desktop
  起動忘れでリモート専用モードへ逸れない設計どおり。
- **テスト網羅**: 11 件全 pass（sandbox では `--allow-write` 明示が必要）。
  死んだ assertion・空振りなし。store 再検証の主要ベクトル（パストラバーサル・
  オプション注入・空白・範囲外・IPv6 正常）を網羅。**不足**: (a) ハイフン始まり
  host（W-C-1）、(b) identityFile 改行（L-C-1）、(c) 大文字差衝突（L-C-2）の
  ケースが未カバー。コマンド組み立て（testConnection/scanRemoteHostKeys の argv）と
  addOrUpdate/removeEntry のフロー自体は対話 UI 依存のため単体テストなし（妥当）。
- **ドキュメント整合**: コードと CLAUDE.md（リモート接続プロファイル/ホスト鍵管理/
  CLOOPY_SSH_BIND 各節）はおおむね一致。差分は D-C-1（add 順序コメント欠落）と
  D-C-2（doctor が `0.0.0.0:` 罠を案内しない）の 2 点のみ。

---

## 付録: ROADMAP G Phase 3「修正済み 8 点」の追試結果

| # | 修正項目 | 実装箇所 | 追試結果 |
|---|---|---|---|
| 1 | docker デーモン停止をリモート専用へ誘導しない | doctor.ts:350, main.ts:12-21 | ✅ `detail==="not found"` 厳密一致・"not responding" 除外 |
| 2 | CRLF 正規化 | ssh.ts:315-321 `readCloopyConfig` | ✅ `.replaceAll("\r\n","\n")`・remote も経由 |
| 3 | doctor の IPv6 bind 受理 | doctor.ts:116 `v6Ok` | ✅ `[::1]:`/`[fd00::1]:` を ACCEPT・実測確認 |
| 4 | カスタム bind 非上書き | setup.ts:221-226, settings.ts:252-262 | ✅ カスタム値は維持・keep 選択肢提示 |
| 5 | store load 時の name/host/port 再検証 | remote.ts:63-82 | ✅ 全バリデータ再適用 + raw trim 一致要求 |
| 6 | 双方向衝突ガード | remote.ts:107-117（リモート→ローカル）+ setup.ts:173-191（ローカル→リモート） | ✅ 双方向あり（ただし L-C-2 の取りこぼし） |
| 7 | 削除順序 config→store | remote.ts:278-281 | ✅ config→known_hosts→store・理由コメント有り |
| 8 | ホスト鍵信頼 default:No | remote.ts:192（信頼）, :211（TOFU） | ✅ どちらも `default: false` |
