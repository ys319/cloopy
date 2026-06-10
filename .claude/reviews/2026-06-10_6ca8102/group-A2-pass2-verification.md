---
group: A2
topic: pass2-verification
date: 2026-06-10
model: opus
---

# Group A2: Pass 2 敵対的検証（Group A 重大指摘）

対象コミット: 6ca8102 / 検証日: 2026-06-10 / 検証手段: コード精読 + Deno 実機検証
（docker は実行不可）。

各指摘を「反証を試みる」立場で精査した。実行パスを追って成立を確認できたものを
CONFIRMED、条件・前提が誤っているものを REFUTED、骨子は正しいが症状/影響/修正範囲を
書き換えるべきものを REVISED とした。

---

## E-A-1 — インスタンス名のデフォルト値が `Deno.env.get` から来る

### VERDICT: CONFIRMED（ただし重大度は **🔴 Error → 🟡 Warning** に格下げ）

**確認した事実（実機検証あり）**:

- `manage.sh:40` は `"$DENO" run --allow-all cli/main.ts` を実行するのみ。`.env` を
  `source` も `export` もしない。
- CLI 側に `--env-file` フラグ・`std/dotenv` の `load()`・`Deno.env` への注入は
  一切ない（`cli/deno.json` の imports / 全ソース grep で確認）。Deno は明示フラグ
  なしに `.env` を読み込まない。
- 実機検証: `.env` に `CLOOPY_INSTANCE_NAME=mybox` を書いた状態で
  `Deno.env.get("CLOOPY_INSTANCE_NAME")` は `undefined`、`readEnvFile().get(...)`
  は `"mybox"` を返した。→ `setup.ts:128` の `currentInstance` は **常に
  `DEFAULT_INSTANCE_NAME`（= `cloopy`）にフォールバックする**。port(l.144)・
  tz(l.160)・ws(l.175) も同じ `Deno.env.get` 依存で同症状。

よって「再セットアップ時、既存 `.env` 値がプロンプトのデフォルトに反映されない
（常に出荷時デフォルトが表示される）」という主張は **事実**。`settings.ts` は
`readEnvFile` ベースで正しく既存値を表示するため、setup と settings の不整合も事実。

**ただし重大度を格下げする根拠（敵対的検証で判明した緩和要因）**:

指摘は「ユーザーの既存設定が上書きされる」と書くが、`setup.ts` は各値を
`if (input !== current)` のときだけ `setEnvVar` する（l.140/156/173/181）。
`current` がデフォルト値なので:

- ユーザーが既存 `mybox` を維持したくてプロンプトのデフォルト（`cloopy`）を Enter で
  受け入れると → `instanceInput === "cloopy" === currentInstance` → **書き込みは発生
  せず、`.env` の `mybox` がそのまま温存される**（データ破壊なし。ただしユーザーは
  「cloopy に戻った」と誤認する）。
- ユーザーが明示的に新しい名前を入力したときだけ書き換わる（これは正しい挙動）。

つまり「サイレントに既存値が消える」破壊シナリオは成立しない。実害は **UX 上の
誤表示**（既存値が見えない／古い名前を再入力しないと維持されたか確信できない）に
留まる。データ整合性バグではないため Error ではなく Warning が妥当。

**正しい修正**: 第1パスの修正案 A（`setup` 冒頭で `readEnvFile` し全 `currentXxx` を
`envMap.get(KEY) ?? DEFAULT` に統一）が適切。`settings.ts` と実装を揃えるべき。

---

## E-A-2 — setup 中断（compose up 失敗）時に .env が部分書き込みで残り回復不能

### VERDICT: REVISED（重大度 **🔴 Error → 🟡 Warning**。「回復不能」は誤り）

**確認した事実**:

- `setup.ts:215-218`: `compose up` が `code !== 0` で `Deno.exit(1)`。この時点で
  `.env`（PUBKEY/UID/GID/インスタンス名等）と SSH 設定（`injectSshConfig` l.205）は
  書き込み済み。
- `checkEnvFile`（doctor.ts:77-92）は `CLOOPY_PUBKEY_PATH=.+` の存在のみで `ok` を返す
  → 次回 doctor の `.env` チェックは pass する。これは指摘通り。

**しかし「回復不能 / 何もできない」は実行パス追跡で REFUTE される**:

`compose up` 失敗の原因で分岐する（doctor.ts:151-172 / main.ts:7-19 を精読）:

1. **イメージビルド失敗が原因の場合** — イメージも実行中コンテナも無い →
   `checkImage` が `not built` → `needsImage=true` → main.ts l.13-15 が
   `buildAndStart()` を呼ぶ（setup ではなく）。`buildAndStart` は build+up を
   **再試行する**。よって「setup がスキップされ放置」ではなく、自動でビルド再試行が走る。

2. **非イメージ要因（ポート競合等）でイメージは焼けている場合** — `checkImage` ok、
   コンテナは停止。`checkContainer`/`checkSshConnect` は `info:true` で
   `needsEnv`/`needsImage` をトリガーしない（doctor.ts:174-231, 268-281）→
   `needsSetup=false` → main.ts は setup も buildAndStart も呼ばず `manage()` へ直行。
   このとき manage メニューは「起動」を提示する（manage.ts:72-74, `start` ケースは
   `compose up` を再実行）。**ユーザーは「起動」を選べば復帰できる**。

つまり「壊れた状態から回復できない」は成立しない。実害は「setup の最後で落ちたのに
次アクションの案内が無く、次回 `./manage.sh` 起動時に黙って manage 画面に入る」という
**UX/案内不足**であり、状態が破壊されるわけでも回復不能でもない。第1パスの修正案 A
（`Deno.exit(1)` 直前に再実行を促すメッセージ）相当で十分。Warning 妥当。

---

## E-A-3 — setup 再実行でインスタンス名変更時に旧ボリュームが孤立

### VERDICT: CONFIRMED（重大度 **🔴 Error → 🟡 Warning** に格下げ）

**確認した事実**:

- `docker-compose.yml:1` は `name: ${CLOOPY_INSTANCE_NAME:-cloopy}`。docker compose は
  `cwd`（= projectRoot、`compose()` が `cwd: projectRoot` 指定）の `.env` を自分で
  補間に読むため、プロジェクト名 = インスタンス名。named volume は
  `<instance>_home-data` / `_nix-store` / `_ssh-config` /（local.yml 有効時）
  `_workspace-data` とプレフィックスされる。
- manage.ts:221-228 `case "setup"`: 起動中なら現インスタンス名で `down`（`-v` なし →
  ボリューム温存）してから `setup()`。`setup()` 内で新インスタンス名を書くと、以後の
  compose は **新プロジェクト名**で動き、旧 `<oldName>_*` ボリュームは新プロジェクトの
  管理外として **Docker に残留（孤立）する**。`down` は旧名で実行済みなので旧コンテナは
  消えるが、旧ボリュームを掃除するルートはどこにもない。警告・案内も無い。

→ 「旧ボリュームが孤立し、警告が無い」は **事実**。

**重大度を格下げする根拠**: 孤立の影響は **ディスク消費のみ**。データ喪失は起きない
（むしろ旧データは残る）。`settings.ts` の JSDoc（l.44-48）が「インスタンス名は
ここでは編集不可（プロジェクト/ボリュームの rename になるため re-setup 専用）」と
設計意図を明記しており、その re-setup 経路に UI 警告が欠けているという**設計の穴 +
ドキュメント整合**の問題。Critical/Error 級のデータ被害ではないため Warning + Doc(🟣)
が妥当。修正は第1パス案 A（旧ボリューム残留を案内）か案 B（名前変更は reset 経由に
誘導）どちらでも可。

---

## C-A-1 — reset の `down -v` が workspace-data も無条件削除するのに警告に出ない

### VERDICT: CONFIRMED（重大度 **💣 Critical を維持**。データ喪失バグ）

**確認した事実（実行パスを完全に追跡）**:

1. ユーザーが setup で「ワークスペースに Docker ボリュームを使用」を選ぶと
   （setup.ts:185-198 → `generateLocalCompose`）、`docker-compose.local.yml` に
   ```yaml
   services:
     sandbox:
       volumes:
         - workspace-data:/home/developer/workspace
   volumes:
     workspace-data:
   ```
   が生成される（setup.ts:32-63）。このボリュームは `<instance>_workspace-data` として
   作成され、**ユーザーの実作業データ**を保持する。

2. reset の `compose(projectRoot, ["down", "-v"])`（manage.ts:492）は
   `getComposeFiles(projectRoot)`（**quiet=false、local.yml を自動で `-f` に追加**、
   compose.ts:21-38）経由で実行される。`docker compose -f base.yml -f local.yml down -v`
   は **両ファイルで定義された全 named volume を削除する** → `workspace-data` も消える。

3. reset の確認メッセージ（manage.ts:481-485）は **ハードコードの 3 項目固定**:
   ```
   - home-data (ホームディレクトリ)
   - nix-store (Nix/Devbox)
   - ssh-config (SSH ホスト鍵)
   ```
   `CLOOPY_WORKSPACE_VOLUME` を一切参照せず、条件分岐も無い。→ workspace-data が
   削除対象に **列挙されない**まま消える。

4. ドキュメント整合: README.md:18 は「ワークスペースは Docker ボリュームで永続化、
   作り直してもデータは残る」、README.md:119-121 の手動 reset 手順は
   `docker volume rm cloopy_home-data cloopy_nix-store` と**明示的に
   workspace-data を除外**し「（ワークスペースは保持）」と書く。CLI の `down -v` は
   この保証・コメントと**真っ向から矛盾**する。

**敵対的に反証を試みた結果**: 唯一の緩和は「ワークスペースに volume を選ぶのは
デフォルト false で、Windows ユーザー等の一部のみ」という点。しかし選んだユーザーに
とっては「保持されると書かれた/案内されたワークスペースが警告なく消える」典型的な
データ喪失であり、緩和にならない。Critical 維持が妥当。

**正しい修正**: 第1パス案 B（workspace-data を reset 対象から外す or 個別確認）が安全。
最小でも案 A（`CLOOPY_WORKSPACE_VOLUME=true` 時に workspace-data を警告に列挙し、
削除に同意させる）が必須。`backup` ケース（manage.ts:288-293）が既に
`CLOOPY_WORKSPACE_VOLUME==="true"` を条件にしているので、同じ判定を reset の
メッセージにも入れれば整合する。

---

## 追加確認（Warning の信頼度判定）

### W-A-1 — manage.sh: unzip 失敗で不完全 deno が残る

**判定: 信頼度 中（妥当だが発生条件は限定的）**

`manage.sh:11` の検出は `[ ! -f "$DENO" ]`（存在チェックのみ、実行可否は見ない）。
`set -euo pipefail`（l.2）下で `unzip`（l.31）が非ゼロ終了すれば即 `exit` し
`trap`（l.27）は `TMP_ZIP` のみ削除 → `.deno/bin` の部分展開物は残る。次回起動で
`-f` が真になり壊れた deno を実行しうる、は論理的に成立。ただし `unzip -o` が
0 バイトの `deno` を作って **かつ非ゼロ終了する**という複合条件が必要で、実発生は
レア。修正案（`unzip` 前に `rm -rf .deno/bin`、または `trap` を `.deno` 全体に拡張）は
妥当。Warning 妥当。

### W-A-4 — settings: カスタム DNS に IPv4 検証なし（firewall への波及含む）

**判定: 信頼度 高（事故面）／ 攻撃面はほぼ無し**

- settings.ts:111-130 のカスタム DNS 入力は `validate` 未指定。`primary`/`secondary`
  に任意文字列を `.env`（`CLOOPY_DNS_PRIMARY/SECONDARY`）へ書ける。port(l.193-198) /
  workspace(l.223) には validate があるのと非対称。
- 波及先: その値は docker-compose.yml:21-22,29-30 の env と `dns:` に渡り、さらに
  init-firewall.sh:49-50 が `DNS_V4+=("...")` に取り込んで
  `iptables -A CLOOPY-OUT -d "$d" -p udp --dport 53 -j ACCEPT`（l.180-181）の `-d`
  引数に渡す。**init-firewall 側にも IP 妥当性検証は無い**。
- 攻撃面の評価: 値の出所はローカル CLI を操作する当人のみ（リモート入力経路なし）。
  かつ `$ipt -A ... -d "$d"` は **クォート済み単一引数**で、`$d` にスペースや `;` を
  入れても別フラグ/別コマンドとして解釈されない（シェルインジェクション不可。
  `set -e` 不使用なので iptables がそのルールを弾いても後続は続行）。したがって
  **コマンドインジェクション等の攻撃面は成立しない**。
- 事故面の評価: 無効 IP（`abc`, `999.999.999.999`, 空白）を入れると iptables の
  該当ルール追加が失敗し、`:53` DROP（l.183-184）だけが残って **名前解決が全断**しうる
  （DNS ピンの ACCEPT が積めないまま DROP だけ効く）。これは firewall on 環境で
  実害になりうる。→ **事故防止のための入力検証は妥当**。第1パスの修正案（port と同様の
  `validate` 追加）でよい。攻撃面は無いので Critical ではなく Warning 妥当。

---

## まとめ（重大度変更提案）

| ID | 元 | 検証後 | 一言 |
|---|---|---|---|
| E-A-1 | 🔴 | 🟡 | 事実だが「上書き」破壊は起きず誤表示に留まる |
| E-A-2 | 🔴 | 🟡 | doctor スキップは事実、ただし回復不能は誤り（buildAndStart 再試行 or manage の「起動」で復帰可） |
| E-A-3 | 🔴 | 🟡 +🟣 | 旧ボリューム孤立は事実、影響はディスク消費のみ（データ喪失なし） |
| C-A-1 | 💣 | 💣 | 維持。workspace-data が警告なく消えるデータ喪失バグ。README の保証と矛盾 |
| W-A-1 | 🟡 | 🟡 | 維持（発生条件は限定的） |
| W-A-4 | 🟡 | 🟡 | 維持。攻撃面なし／事故面（DNS 全断）で検証追加は妥当 |
