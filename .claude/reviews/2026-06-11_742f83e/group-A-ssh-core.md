---
group: A
topic: ssh.ts known_hosts / SSH config 注入コア
files_reviewed: 2
date: 2026-06-11
model: opus
---

# Group A: ssh.ts known_hosts / SSH config 注入コア

## サマリ

前回 SUMMARY の W-B-1（injectSshConfig の非アトミック書き込み）と W-D-3（テスト
ゼロ）は **実質解消済み**。`writeFileAtomic`（tmp→rename, 0600）が全書き込みを
torn-write 安全にし、`ssh_test.ts` が 27 本（うち known_hosts/config 純粋関数を
HOME 差し替えの実ファイル統合 + 敵対的フィクスチャで）カバーする。全テスト合格、
`deno check` / `deno lint` クリーン。HMAC-SHA1 フィクスチャ（`ssh-keygen -H`）は
独立再計算で **本物と確認**（localhost / 192.168.1.50 の両塩・両ハッシュ一致）。

CLAUDE.md「ホスト鍵管理」章の不変条件（マーカー除去・token 除去・ハッシュ照合の
小文字化・コメント/@/ワイルドカード不触・カンマ別名の部分除去・削除はマーカーのみ）
は実装・テスト双方で概ね成立。突き崩しは出来なかったが、**設計上許容されている
が要記録の挙動**が複数あり（敵対的マーカー一致でのユーザー行除去、port 22 の
bare/`[host]:22` token 非対称、`.env` 経由の未検証インスタンス名が buildHostBlock
に生で届く経路、リモート最終エントリ削除後の banner 残骸 + dangling Include）。
重大度は最大でも 🟡。設計原則違反（💣）・データ破壊（🔴）は無し。

- 重大度件数: 🟢 5 / 🔵 4 / 🟡 2 / 🔴 0 / 💣 0
- ドキュメント軸: 🟣 3
- タグ別: 🤖 0 / 🙋 3

## ファイル別分類

| 分類 | ファイル | 一言コメント |
|---|---|---|
| 🟢 Safe | `cli/lib/ssh.ts` (escapeRegExp / toSshPath / writeFileAtomic / knownHostsToken / knownHostsMarker / parseKeyscanOutput / hashedHostMatches) | 純粋・防御的。RegExp エスケープ・base64 失敗の握り潰し・0600 すべて適切 |
| 🟡 Warning | `cli/lib/ssh.ts:229-251` (buildHostBlock) | `.env` 経由の未検証インスタンス名が生で複数行に補間され config インジェクション余地（W-A-1） |
| 🟡 Warning | `cli/lib/ssh.ts:392-414` (transformKnownHostsLine) | 4 番目フィールド一致だけでユーザー行を除去する敵対的マーカー衝突（W-A-2） |
| 🔵 Low | `cli/lib/ssh.ts:345-347` (knownHostsToken) | port 22 で bare host を返すため `[host]:22` 表記の既存 pin を取り逃す非対称（L-A-1） |
| 🔵 Low | `cli/lib/ssh.ts:186-199` (removeHostBlock) | 最終ブロック削除で banner 残骸 + main config の Include が dangling（L-A-2） |
| 🔵 Low | `cli/lib/ssh.ts:421-435` (filterKnownHostsContent) | 除去エントリ周辺の空行が孤立残留（cosmetic）・CRLF 混在を正規化しない（L-A-3） |
| 🔵 Low | `cli/lib/ssh.ts:529-577` (refreshKnownHosts) | keyscan 全失敗時に旧 known_hosts を残置（既知 L-B-3）。本体は妥当（L-A-4） |
| 🟢 Safe | `cli/lib/ssh_test.ts` | フィクスチャ本物・敵対ケース網羅・死んだ assertion なし。下記の薄い箇所のみ |
| 🟣 Doc | `cli/lib/ssh_test.ts:325-347` | マーカー除去とトークン除去を分離検証するテストが無い（D-A-1） |
| 🟣 Doc | `cli/lib/ssh.ts:438-443` (upsertKnownHosts コメント) | 「pure」表記はないが I/O 関数。挙動説明は正確（D-A-2） |
| 🟣 Doc | `cli/lib/ssh.ts:129-148` (writeFileAtomic コメント) | クロスデバイス rename・symlink 実体化への言及なし（D-A-3） |

> Doc は重大度独立軸。W-A-1 / W-A-2 は実装側、D-A-1 はテスト側の所見。

## 詳細指摘

### 🟡 W-A-1 🙋: `.env` 由来の未検証インスタンス名が buildHostBlock に生で届く

- **対象**: `cli/lib/ssh.ts:229-251`（`buildHostBlock`）、経由 `injectSshConfig:261`
- **症状**: インスタンス名に改行を含めると Host ブロックが複数 `Host` 行に割れる。
  検証コード `upsertHostBlock("", "x\nHost evil", block(...))` で `Host` 行が
  **3 本**生成されることを確認（`escapeRegExp` は RegExp 用で、補間先の
  `buildHostBlock` の生文字列化は別問題）。
- **根本原因**: `buildHostBlock` が `name` を `# --- ${name} ---` / `Host ${name}`
  に無検証で補間する。対話パスは setup.ts:184（`/^[a-zA-Z][a-zA-Z0-9_-]*$/`）と
  remote.ts:104（`validateRemoteName`、同等 + 64 文字制限）で防いでいるが、
  **非対話パス**（setup.ts:82 / manage.ts:316,358 が `CLOOPY_INSTANCE_NAME` を
  `.env` から無検証で読む → `injectSshConfig` / `refreshKnownHosts` へ）では
  手編集 `.env` の不正名がそのまま到達する。CLAUDE.md は doctor の `.env`
  形式チェックに言及するが、インスタンス名のメタ文字検証は確認できなかった。
- **影響範囲**: known_hosts 側は marker（`cloopy:<name>`）に入るだけで literal
  比較かつ行末コメントなので実害は軽微。config 側（`buildHostBlock`）が唯一の
  injection 面。実際の悪用には攻撃者が `.env` を書ける必要があり前提が重い →
  🟡 据え置き（💣 ではない）。
- **修正案**:
  - 候補 A（推奨・防御多重化）: `buildHostBlock`（または `injectSshConfig`）冒頭で
    `validateRemoteName` 相当を呼び、不正名は throw。lib 層で閉じるので全呼び元を
    一括で守れる。
  - 候補 B: doctor の `.env` チェックに `CLOOPY_INSTANCE_NAME` 形式検証を追加
    （範囲外ファイル変更を伴うため親に委ねる）。
- **テスト**: `buildHostBlock` に改行・空白・`Host`/`# ---` を含む名前を渡したとき
  throw する（または `Host` 行が 1 本に保たれる）アサーション。

### 🟡 W-A-2 🙋: 4 番目フィールド一致だけで無関係なユーザー行を除去し得る

- **対象**: `cli/lib/ssh.ts:401`（`if (fields[3] === marker) return null;`）
- **症状**: ホストが全く無関係でも 4 番目トークンが `cloopy:<name>` に一致する
  ユーザー行が削除される。検証: `filterKnownHostsContent("evil.com ssh-ed25519 ABCDEF cloopy:dev", "cloopy:dev", [])`
  → **DROPPED**（host は `evil.com` で token 不一致なのにマーカーで除去）。
- **根本原因**: マーカーは「cloopy 所有」の印として位置（index 3）一致で判定する
  設計（これ自体は正しい — 自分の旧 pin を host 変更後も追える）。しかし
  「マーカーは cloopy が書いた行にしか付かない」前提に依存しており、ユーザーや
  他ツールが偶然 4 番目に同文字列を置いた行を巻き込む。`cloopy:<name>` は
  namespace 付きで衝突確率は実用上ゼロ、かつ known_hosts の 4 番目はコメント
  フィールドで通常空 → 実害ほぼ無し。設計どおりだが**記録すべき仮定**。
- **影響範囲**: 低（マーカーの namespace が事実上の防御）。CLAUDE.md にも
  「マーカーで自己識別」と明記済みで方針一致。
- **修正案**:
  - 候補 A（現状維持・推奨）: 仕様として受容。コメントに「4 番目フィールドの
    マーカー一致は host 非依存で除去する（cloopy 所有の証）」と 1 行追記すれば
    レビュー時の誤読を防げる。
  - 候補 B（厳格化）: マーカー一致に加えて「host token も自分のものか」を併用 →
    ただし host 変更後の旧 pin 追跡という設計意図を壊すため非推奨。
- **テスト**: 「host token 不一致でもマーカー一致なら除去」を意図として固定する
  テスト（現状は token 一致行で兼ねており意図が曖昧 → D-A-1 と統合可）。

### 🔵 L-A-1: port 22 の bare host token と `[host]:22` 表記の非対称

- **対象**: `cli/lib/ssh.ts:345-347`（`knownHostsToken`）
- **症状**: `knownHostsToken("example.com","22")` は bare `example.com` を返す。
  既存 known_hosts に `[example.com]:22 ...` 形式の pin があると token 一致せず
  **温存**される（検証で KEPT を確認）。ssh は両者を同一宛先として扱うため、
  リモートを port 22 で登録 → リセットで鍵変更時に旧 `[host]:22` 行が残り
  key-changed を誘発し得る。
- **根本原因**: token 生成は ssh/keyscan の正準形（22 は bare）に合わせている
  一方、除去側は file 内の異表記（`[host]:22`）を正準化しない。ローカルは
  常に非 22（10022 等）なので無関係。リモート port 22 のみで、かつユーザーが
  ブラケット表記で手書きした場合という二重に稀な条件。
- **影響範囲**: 低（標準 keyscan/openssh は port 22 を bare で書くため自然発生
  しにくい）。
- **修正案**: `upsertKnownHosts` のトークン集合に port==22 のとき `[host]:22`
  別名も追加する（数行）。ただし発生条件が稀なため 🙋 不要の Low として記録に留める。
- **テスト**: `filterKnownHostsContent("[example.com]:22 ...", _, ["example.com"])`
  が除去する、を追加するなら有効。

### 🔵 L-A-2: リモート最終エントリ削除で banner 残骸 + dangling Include

- **対象**: `cli/lib/ssh.ts:186-199`（`removeHostBlock`）、`:327-334`
  （`removeSshConfigEntry`）
- **症状**: banner 付き config から唯一の Host ブロックを削除すると
  `"# cloopy - Claude Code sandbox\n# Auto-generated ...\n"`（banner のみ）が残る
  （検証済み）。`result.trim() === ""` の空判定は banner が非空白なので発火せず、
  `~/.ssh/config` の `Include` も削除されない（設計上 Include は消さない方針）。
- **根本原因**: `removeHostBlock` の空ファイル化は「ブロックのみ・banner 無し」を
  想定。banner 行は trim 後も残る。
- **影響範囲**: 機能的に無害（ホスト 0 件の config を Include しても ssh は何も
  しない）。整理されない残骸という美観/運用上の小さな引っかかりのみ。
- **修正案**: removeSshConfigEntry 後に「ブロックが 1 つも無ければ Include 行と
  cloopy config を削除」する掃除を入れるか、現状を仕様として受容。範囲外
  （main config / remote.ts）に触れるため記録に留める。
- **テスト**: 不要（仕様確認なら removeHostBlock の banner 残留を固定する
  アサーション）。

### 🔵 L-A-3: 除去跡の孤立空行 / CRLF 混在を known_hosts 側で正規化しない

- **対象**: `cli/lib/ssh.ts:421-435`（`filterKnownHostsContent`）、`:462`
  （`upsertKnownHosts` の読み取り）
- **症状**:
  (a) マーカー行が空行で挟まれていると除去後に孤立空行が残る（検証:
  `"...cloopy:dev\n\n...cloopy:dev\n"` → `"\n"`）。
  (b) `readCloopyConfig`（config）は CRLF→LF 正規化するが、known_hosts 読み取り
  （`Deno.readTextFileSync(path)` line 462）は正規化しない。CRLF 編集された
  known_hosts では保持行に `\r` が残り、追記は LF なので**混在**になる。
  ただし分類は `line.trim()` 後のフィールドで行うためマーカー/トークン照合自体は
  正しく機能する（CRLF マーカー行の DROP を検証済み）。
- **根本原因**: known_hosts は「行の集合・空行/順序は無意味」なので config ほど
  厳密な整形をしていない。ssh は空行・CRLF とも許容。
- **影響範囲**: 純 cosmetic。機能影響なし。
- **修正案**: 必要なら upsertKnownHosts 冒頭で `content.replaceAll("\r\n","\n")`、
  および空行の連続圧縮。優先度低。
- **テスト**: 不要。

### 🔵 L-A-4: refreshKnownHosts のリトライ枯渇時に旧エントリ残置（既知 L-B-3）

- **対象**: `cli/lib/ssh.ts:529-577`
- **症状**: keyscan が 3 回とも失敗 / 鍵 0 件だと `console.error` のみで return し、
  `upsertKnownHosts` を呼ばない → 旧 `[localhost]:port` pin が残る。リセットで
  鍵が変わった直後にこの経路を踏むと key-changed の窓が残る。
- **根本原因**: 前回 ROADMAP の L-B-3 と同一。本体（リトライ・stderr=null・port を
  `-p` 引数化）は妥当で、keyscan 不能時に**古い pin を消すべきか残すべきか**は
  トレードオフ（消すと接続不能、残すと mismatch）。
- **影響範囲**: 低・既知。
- **修正案**: 既存 ROADMAP L-B-3 に合流。新規対応不要。
- **テスト**: refreshKnownHosts は外部コマンド依存で純粋化されておらず単体化困難
  （parseKeyscanOutput は分離済みでテスト有り = 妥当な切り出し）。

### 🟣 D-A-1 🙋: マーカー除去とトークン除去を分離検証するテストが無い

- **対象**: `cli/lib/ssh_test.ts:325-347`
- **症状**: 「マーカー行と token 完全一致行のみ除去」テストの対象マーカー行
  `[localhost]:10022 ${KH_KEY} cloopy:dev` は**マーカーも token も両方一致**する
  ため、除去がマーカー経路（`fields[3]===marker`）由来か token 経路由来かを
  区別できない。CLAUDE.md が掲げる「マーカー一致（host 変更後も追える旧 pin）」と
  「token 一致」は別不変条件なのに、マーカー経路を host token 不一致で単独検証する
  テストが無い。
- **修正案**: `[oldhost]:9999 ${KH_KEY} cloopy:dev` を `tokens=["[localhost]:10022"]`
  （host 不一致）で渡し、マーカー経路だけで除去されることを固定するテストを追加。
  逆に「マーカー無し・token 一致」で除去されるテストは 366 行のハッシュ照合 +
  329 行で兼ねられているが、平文 token 単独（マーカー無し平文行）の除去固定も薄い。
- **テスト自体のバグ根拠**: 既存アサーションは間違ってはいない（除去は正しく起きる）
  が、**不変条件を縛れていない**（リファクタで片方の経路を壊しても緑のまま通り得る）。

### 🟣 D-A-2: upsertKnownHosts のドキュメント整合（軽微）

- **対象**: `cli/lib/ssh.ts:438-443`
- **症状**: コメントは挙動（marker + token で旧 pin 除去 → 追記）を正確に説明。
  指摘なしレベルだが、`tokens` 集合に「lines 由来のホスト名も加える」（:452-457）
  点がコメント本文に明示されていない（lines のホストと引数 host が食い違う将来の
  リモートで効く重要ロジック）。
- **修正案**: 「keyscan 行に現れたホスト名も除去対象 token に含める」を 1 行追記。
  コードのみで完結する Doc 改善。

### 🟣 D-A-3: writeFileAtomic のクロスデバイス / symlink 言及なし

- **対象**: `cli/lib/ssh.ts:129-148`
- **症状**: `${path}.tmp~` を同一ディレクトリに作り `renameSync` するので
  **クロスデバイス問題は構造的に回避済み**（同 dir rename = 同一 FS、原子的）—
  これは正しい実装。ただしコメントは torn-write 防止のみ言及し、(a) symlink な
  `~/.ssh/known_hosts` は rename で実体ファイルに置換され symlink が壊れる
  （前回 ROADMAP で「保証範囲外」と整理済み）、(b) 同一ディレクトリ前提が
  クロスデバイス安全の根拠、を明記していない。
- **修正案**: 「tmp は同一ディレクトリに作るのでクロスデバイス rename にならない。
  symlink は実体化される（既知・範囲外）」を 1-2 行追記。コードのみで直る。

## 重要な設計の可視化

known_hosts アップサートのデータフロー（行分類 → 除去判定 → 追記 → アトミック書き込み）:

```
refreshKnownHosts(port, name)            ssh.ts:529   [local: host=固定 "localhost"]
  │  ssh-keyscan -p <port> localhost (最大3回リトライ, 2s)
  ▼
parseKeyscanOutput(stdout)               ssh.ts:505   "<host> <type> <b64>" 抽出/不正行skip
  │  lines[]
  ▼
upsertKnownHosts(name, host, port, lines) ssh.ts:445
  │
  ├─① 除去対象トークン集合を構築            ssh.ts:451-457
  │     seed = knownHostsToken(host,port)  → 22:bare / 他:[host]:port   [L-A-1: 22非対称]
  │     + lines の各 host フィールド（| / @ 始まりは除外, カンマ分割）
  │
  ├─② marker = "cloopy:<name>"            ssh.ts:458   [W-A-1: name無検証経路]
  │
  ├─③ 既存 known_hosts 読込（NotFound→""）  ssh.ts:460-465  [L-A-3: CRLF未正規化]
  │
  ▼
filterKnownHostsContent(content, marker, tokens)         ssh.ts:421
  │  tokens を小文字化 → 1 行ずつ
  ▼
transformKnownHostsLine(rawLine, marker, lowerTokens)    ssh.ts:392
  │
  ├─ trim 後 空 / "#" / "@" 始まり        → keep (rawLine)   [コメント/@cert/@revoked不触]
  ├─ fields < 3                            → keep
  ├─ fields[3] === marker                  → DROP             ④ [W-A-2: 位置一致のみ]
  ├─ host が "|" 始まり (HashKnownHosts)
  │     └ hashedHostMatches(field, token)  → 一致で DROP      ⑤ HMAC-SHA1(salt,小文字token)
  │          (base64失敗/形式不正は false=keep)               ssh.ts:354
  └─ 平文 host: カンマ別名を分割
        ├ 全別名一致                       → DROP             ⑥
        ├ 一部一致                         → 残別名で行再構築  ⑦ [他pin巻き込み防止]
        └ 不一致                           → keep
  │
  ▼ kept[].join("\n")
updated                                   ssh.ts:466
  │  末尾 \n 補正 (:467) → lines 各行に " <marker>" 付けて追記 (:468)
  ▼
writeFileAtomic(path, updated)            ssh.ts:135 / :470
     tmp(path.tmp~, 0600) → renameSync     [同一dir=クロスデバイス安全, torn-write無]
                                           [D-A-3: symlink実体化は既知/範囲外]
```

## 横断観点での所見

- **設計境界**: 純粋関数（upsertHostBlock / removeHostBlock / ensureIncludeLine /
  buildHostBlock / hasHostBlock / filterKnownHostsContent / parseKeyscanOutput /
  knownHostsToken / hashedHostMatches）と I/O 関数（injectSshConfig /
  removeSshConfigEntry / upsertKnownHosts / removeKnownHostsEntry / refreshKnownHosts）
  の分離が明確で、純粋側にテストが集まっている。W-D-3（テストゼロ）は解消。前回
  W-B-1 の torn-write はアトミック書き込みで解消、二段書き込みの部分失敗は
  「cloopy config 先行 → Include 後続」順で失敗しても無害（再 setup で回復）= 受容妥当。
- **リソース所有権**: known_hosts はマーカー（cloopy 所有印）+ token（宛先一致）の
  二系統で「自分の行」を識別。所有モデルは CLAUDE.md と一致。W-A-2 はその所有モデルの
  前提（マーカーは cloopy しか書かない）が暗黙であることの記録。
- **テスト網羅**: 27 本合格・HMAC フィクスチャ本物・敵対ケース（カンマ別名・
  HashKnownHosts・壊れたハッシュ行・大文字小文字・@/ワイルドカード・CRLF・tmp 残骸）
  を広くカバー。薄いのは (D-A-1) マーカー経路と token 経路の分離検証、(W-A-1)
  名前インジェクションの否定テスト、port 22 の `[host]:22` 取り逃し（L-A-1）。
- **正規表現安全性**: `escapeRegExp`（:120）が upsertHostBlock / removeHostBlock /
  hasHostBlock のユーザー名補間を保護。メタ文字（`.` `+` 等）の誤マッチ・誤除去が
  起きないことを検証で確認。RegExp に入るのは config 系のみで、known_hosts 側は
  literal 比較（marker `===`）と HMAC で RegExp 不使用 = エスケープ漏れの面が小さい。
  唯一 buildHostBlock の生補間（RegExp ではなく生成文字列）が W-A-1。
- **ドキュメント整合**: CLAUDE.md「ホスト鍵管理」章の記述（マーカー行末コメント・
  非ハッシュ化 keyscan・小文字化照合・カンマ別名の部分除去・削除はマーカーのみ・
  localhost upsert）はすべて実装と一致。コメント側の小さな補強余地が D-A-2 / D-A-3。
```
