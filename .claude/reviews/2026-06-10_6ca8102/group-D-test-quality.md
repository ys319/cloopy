---
group: D
topic: テスト品質横断 + CI
files_reviewed: 9
date: 2026-06-10
model: sonnet
---

# Group D: テスト品質横断 + CI

## サマリ

- CI の `deno test cli/` コマンドがリポジトリルートから実行すると TS2307 で失敗する既知の挙動（ローカル再現済み）。Taskfile.yml の `test` タスクは `dir: cli` で正しく動くが、CI はこれと異なるコマンドを使っているため **ローカルでは pass・CI では fail** という乖離が生じうる。各テストファイル自体の品質は高く、全 19 テストがローカルで pass している。firewall テスト（test/*.sh）は実装との突き合わせにも問題なく、各ルールを構造的・カウンター両面で検証している。主な穴は `ssh.ts` の `injectSshConfig` を中心としたテストカバレッジ不足と、CI の設定誤りの 2 点。
- 重大度件数: 🟢 3 / 🔵 3 / 🟡 4 / 🔴 1 / 💣 0
- ドキュメント軸: 🟣 2
- タグ別: 🤖 3 / 🙋 4

## ファイル別分類

| 分類 | ファイル | 一言コメント |
|---|---|---|
| 🔴 Error | `.github/workflows/ci.yml:32` | `deno test cli/` がルートから実行で TS2307 エラー（Taskfile と乖離） |
| 🟡 Warning | `cli/lib/compose_test.ts:45` | `quiet=true suppresses log` テストがログ抑制を実際に検証していない（テスト名と検査内容の乖離） |
| 🟡 Warning | `cli/lib/workspace_test.ts:全体` | `$HOME` の親ディレクトリ（`/Users` 等）を渡すケースが未テスト |
| 🟡 Warning | `cli/lib/env_test.ts:113` | `setEnvVar` の BEGIN マーカーのみ存在して END がない場合のエッジケースが未テスト |
| 🟡 Warning | `cli/lib/ssh.ts:全体` | `injectSshConfig`・path 関数群のユニットテストがゼロ（最重要カバレッジ穴） |
| 🔵 Low | `.github/dependabot.yml:全体` | `github-actions` のみ追跡、`cli/deno.json` の JSR パッケージは対象外 |
| 🔵 Low | `.github/workflows/ci.yml:6-9` | `paths` フィルタに `deno.json`（ルートに存在しない）を列挙しており誤解を招く |
| 🔵 Low | `test/firewall-dns.sh:123-134` | fallback mode の CFB コンテナに `--add-host` がなく `host.docker.internal` ACCEPT が暗黙的に未検証 |
| 🟢 Safe | `cli/lib/compose_test.ts` | 基本 3 ケース pass。`getComposeFiles` の主要パスを網羅 |
| 🟢 Safe | `cli/lib/env_test.ts` | `readEnvFile`・`setEnvVar` 主要 10 ケース pass。Windows 改行・値に `=` 含む等も検証 |
| 🟢 Safe | `cli/lib/workspace_test.ts` | 6 ケース pass。SELinux 危険パスの拒否ロジックを適切に検証 |
| 🟢 Safe | `Taskfile.yml` | `lint`/`fmt`/`test`/`check` はすべて `dir: cli` 付きで正しく動作する |
| 🟣 Doc | `.github/workflows/ci.yml:9` | `paths` に `deno.json`（ルート不在）を列挙; CI のメンテナーが誤解する可能性 + W-D-3 |
| 🟣 Doc | `test/firewall-dns.sh:123` | CFB コンテナが `--add-host` 無しである理由のコメントなし。意図的だが説明が不足 + W-D-4 |

> `test/boot-timing.sh` はタイミング計測ツール（アサーションなし）なので重大度軸では 🟢 Safe に分類。サービス名 `sandbox` は `docker-compose.yml:4` と一致（正しい）。

## 詳細指摘

### 🔴 E-D-1 🙋: CI の `deno test cli/` がルートから実行で TS2307 エラー

- **対象**: `.github/workflows/ci.yml:32`
- **症状**: `deno test cli/ --allow-read --allow-write --allow-env` をリポジトリルートから実行すると、Deno が `cli/deno.json` の imports map を参照せず `@std/assert`・`@std/path`・`@std/fmt/colors` のすべてで `TS2307 Import not a dependency` エラーが 11 件発生し exit 1。ローカルでの再現を確認済み。
- **根本原因**: `deno test <dir>` でディレクトリパスを渡す場合、Deno v2 は CWD の `deno.json` を探す（ルートには存在しない）。ファイルパスを渡す場合はそのファイルに最も近い `deno.json` を ancestor walk で探すが、ディレクトリ渡しでは挙動が異なる。Taskfile.yml は `dir: cli` で CWD を変えてから `deno test` を実行しているため通過する。
- **修正案**:
  - 案 A（推奨）: `ci.yml:32` を `cd cli && deno test . --allow-read --allow-write --allow-env` に変更。Taskfile と完全に同一の実行方法。
  - 案 B: `deno test --config cli/deno.json cli/ --allow-read --allow-write --allow-env`（`--config` 明示）。ローカル検証済み（19 passed）。
  - 案 C: ルートに `cli/deno.json` を include する wrapper `deno.json` を作成。
- **テスト**: 修正後に `deno test --config cli/deno.json cli/ --allow-read --allow-write --allow-env` で 19 passed を確認（既確認）。

---

### 🟡 W-D-1 🙋: `getComposeFiles: quiet=true suppresses log` テストがログ抑制を検証していない

- **対象**: `cli/lib/compose_test.ts:45-55`
- **症状**: テスト名は「quiet=true suppresses log」だが、実際には `files.length === 4` しか検証しない。`quiet=false` の場合と区別するアサーションがなく、ログが出力されても/されなくても pass する。
- **根本原因**: `console.log` を差し替えるモックなしで副作用（stdout）を検証しようとした形跡がない。Deno のテストでは `using console = spy(...)` 等のアプローチが必要。
- **修正案**:
  - 案 A: テスト名を実態に合わせて `"getComposeFiles: quiet flag does not affect returned paths"` に改名し、戻り値の検証のみとする（🤖 の範囲）。
  - 案 B: Deno の `@std/mock` を使って `console.log` をスパイし、`quiet=true` 時に呼ばれないことを検証する。
- **テスト**: 不要（テスト自体の修正）。

---

### 🟡 W-D-2 🙋: `validateWorkspacePath` の `$HOME` 親ディレクトリ拒否が未テスト

- **対象**: `cli/lib/workspace_test.ts:全体`、実装 `cli/lib/workspace.ts:55`
- **症状**: `workspace.ts:55` の `resolve(home).startsWith(path + "/")` により `$HOME` の親（例: `/Users`、`/home`）を拒否する実装があるが、テストケースが存在しない。
- **根本原因**: `"$HOME 自体と ~ は拒否"` テスト（L27）は `HOME` 自体と末尾スラッシュのみ検証しており、`/Users` や `/home/user` の親（ただし `/home` は `FORBIDDEN_PATHS` に入っているので別経路）は検証していない。
- **修正案**: 以下のテストケースを追加:
  ```typescript
  Deno.test({
    name: "validateWorkspacePath: $HOME の親ディレクトリは拒否",
    ignore: isWindows || !HOME,
    fn() {
      const parent = resolve(HOME, "..");
      assertEquals(typeof validateWorkspacePath(parent), "string", parent);
    },
  });
  ```
- **テスト**: 上記が追加テスト。

---

### 🟡 W-D-3 🙋: `ssh.ts` の `injectSshConfig` がテストゼロ（カバレッジ最優先穴）

- **対象**: `cli/lib/ssh.ts:81-152`（`injectSshConfig`）
- **症状**: SSH 設定注入・上書き・`Include` 追加を行う核心ロジックが全くテストされていない。このコードが壊れると SSH 接続不能になりユーザー体験を直撃する。
- **根本原因**: `ssh.ts` に対応する `ssh_test.ts` が存在しない。
- **推奨テストケース上位 3 つ**（`ssh_test.ts` として追加）:
  1. `"injectSshConfig: 新規ファイルに Host ブロックを書き込む"` — `sshConfigPath()` が存在しない場合、正しい Host ブロックが生成されること、`knownHostsPath()` が `UserKnownHostsFile` に含まれること。
  2. `"injectSshConfig: 既存ブロックをポート変更で上書きする"` — 既存の `Host cloopy` ブロックがある場合、Port を変えて呼んだ後ブロックが一つのみで新 Port になること（重複挿入がないこと）。
  3. `"injectSshConfig: mainSshConfig に Include ディレクティブを追加する"` — `~/.ssh/config` が存在しない or Include なしの場合、`Include <cloopy/config>` が先頭に追加されること。
- **修正案**: 一時ディレクトリを使って `HOME`・`mainSshConfigPath` を差し替えた純粋ファイル操作テストを書く（`ensureKeyPair`・`refreshKnownHosts` は外部コマンドを呼ぶため統合テストの範囲）。

---

### 🟡 W-D-4 🔵: `setEnvVar` の `BEGIN` のみ存在して `END` がないエッジケース未テスト

- **対象**: `cli/lib/env_test.ts:全体`、実装 `cli/lib/env.ts:36`
- **症状**: `auto=true` かつ `BEGIN` マーカーのみ存在（`END` なし）の場合の挙動テストがない。実装は `content.includes(END_MARKER)` が false → append になる（正しい動作だが未テスト）。
- **修正案**: 以下のテストケースを追加:
  ```typescript
  Deno.test("setEnvVar: BEGIN あり END なしの場合は末尾に追加", () => {
    const { envPath, cleanup } = makeTmpProject();
    try {
      Deno.writeTextFileSync(envPath, "# BEGIN cloopy auto-managed\nA=1\n");
      setEnvVar(envPath, "B", "2", true);
      const content = Deno.readTextFileSync(envPath);
      assertEquals(content.includes("B=2"), true);
    } finally { cleanup(); }
  });
  ```

---

### 🔵 L-D-1 🙋: `dependabot.yml` が JSR パッケージ (`@std/*`, `@cliffy/*`) を追跡しない

- **対象**: `.github/dependabot.yml:全体`
- **症状**: `github-actions` のみ登録しており、`cli/deno.json` の `@std/assert`・`@std/fmt`・`@std/path`・`@cliffy/prompt` の JSR パッケージは dependabot の監視対象外。
- **根本原因**: 執筆時点（2026-06）では dependabot は Deno/JSR の `package-ecosystem` をサポートしていないため、設定追加は不可能。
- **修正案**: これは dependabot の制限であり現時点で解決策なし。ただし `cli/deno.json` に `@std/*` のバージョン固定を定期的に手動確認する運用をコメントで明記することを推奨（🙋 運用判断が必要）。
- **テスト**: 不要。

---

### 🔵 L-D-2 🤖: CI `paths` フィルタに存在しない `deno.json` を列挙

- **対象**: `.github/workflows/ci.yml:6,9`
- **症状**: `paths: ["cli/**", "deno.json", ...]` のうち `deno.json` はリポジトリルートに存在しない（実際は `cli/deno.json`）。CI のトリガー設定として misleading。
- **根本原因**: `cli/deno.json` の変更は `cli/**` でカバーされるため実害はない。
- **修正案**: `"deno.json"` を `"cli/deno.json"` に変更（🤖）:
  ```yaml
  paths: ["cli/**", "cli/deno.json", ".github/workflows/ci.yml"]
  ```
  または `deno.json` の行を削除（`cli/**` で包含されるため重複）。

---

### 🔵 L-D-3: `firewall-dns.sh` fallback テストで `--add-host` なしの意図が未コメント

- **対象**: `test/firewall-dns.sh:123-126`
- **症状**: fallback mode の CFB コンテナに `--add-host host.docker.internal:host-gateway` が意図的に付与されていないが、その理由のコメントがない。`init-firewall.sh` の `_host_ips v4` が空になって ALLOW_HOST の ACCEPT ルールが生成されない（= host allow を検証しない）という副作用が読者に見えない。
- **修正案**: L123-L125 付近に次のコメントを追加（🤖）:
  ```bash
  # no --add-host: host.docker.internal is not in /etc/hosts in this container,
  # so _host_ips returns empty and ALLOW_HOST ACCEPT rules are skipped.
  # This is intentional — fallback mode focuses only on the :53 pin, not host-allow.
  ```

---

### 🟣 D-D-1 🤖: CI `paths` フィルタの `deno.json` が誤解を招く（ドキュメント軸）

- **対象**: `.github/workflows/ci.yml:6,9`
- **症状**: `paths: ["cli/**", "deno.json", ...]` の `deno.json` はリポジトリルートに存在しない。CI のメンテナーが「ルートに deno.json を置くべき」と誤解する可能性がある。
- **修正案**: L-D-2 と同一（`deno.json` → `cli/deno.json` または削除）。

---

### 🟣 D-D-2: `firewall-dns.sh` fallback コンテナの意図未記述（ドキュメント軸）

- **対象**: `test/firewall-dns.sh:123-126`
- **症状**: L-D-3 と同一箇所。CFB コンテナの `--add-host` 省略理由のコメントなし。
- **修正案**: L-D-3 と同一。

---

## 重要な設計の可視化

### CI テストコマンドの CWD 依存による乖離

```
  ローカル開発者 (Taskfile)               GitHub Actions CI
  ─────────────────────────────────────   ──────────────────────────────────────
  task test                               deno test cli/ --allow-...
    └─ dir: cli (Taskfile.yml:34)           (CWD = GITHUB_WORKSPACE = repo root)
        └─ deno test --allow-...             │
            CWD = cli/                       ▼
            ancestor walk →                 Deno looks for deno.json at CWD (root)
            cli/deno.json ✅ Found           root/deno.json → NOT FOUND ❌
            imports: @std/*, @cliffy/* OK    TS2307: Import not a dependency
            19 tests PASS                   exit 1 ❌
```

修正: CI で `cd cli && deno test .` を使うか `--config cli/deno.json` を明示する（ci.yml:32）。

---

## 横断観点での所見

### テスト網羅

現時点でテスト対象のモジュールと欠落の優先度:

| 優先度 | モジュール | テストの有無 | 理由 |
|---|---|---|---|
| 🔴 最高 | `cli/lib/ssh.ts` (`injectSshConfig`) | なし | 壊れると SSH 不能。純粋ファイル操作なので書ける |
| 🟡 高 | `cli/lib/compose.ts` (`compose`, `getContainerId`, `getStatus`) | なし | Docker CLI をラップするため統合テスト必要だが `getComposeFiles` のみ今テスト済み |
| 🟡 高 | `cli/lib/env.ts` (`ensureEnvFile`) | なし | `.env.example` が存在しない場合の `Deno.exit(1)` パスが未検証 |
| 🔵 低 | `cli/lib/spinner.ts` | なし | timer の副作用のみ。ビジネスロジックなし |

### CI の検証範囲

CI が検証すること:
- `deno lint cli/` — lint（**ただし現状 pass**、imports map 不要）
- `deno fmt --check cli/` — フォーマット（**pass**）
- `deno test cli/ --allow-...` — **TS2307 エラーで fail（E-D-1）**

CI が検証しないこと:
- `docker build`（Docker イメージのビルド）
- `test/firewall-phase1.sh`, `test/firewall-dns.sh`（Docker 必要のため許容）
- シェルスクリプトの `shellcheck`（`docker/*.sh`, `test/*.sh` に適用なし）
- `cli/deno.json` の依存バージョン更新（dependabot 非対応）

### ドキュメント整合（🟣 Doc）

- `.github/workflows/ci.yml:6,9`: `paths` の `deno.json` がルートに存在しないという事実が、CI 設定を読むすべてのメンテナーに誤解を与えうる（D-D-1）。
- `test/firewall-dns.sh:123`: fallback mode コンテナで `--add-host` を意図的に省略した理由が無コメントで、テストの意図が読みにくい（D-D-2）。

### 設計境界

`test/firewall-*.sh` と `docker/s6-overlay/scripts/init-firewall.sh` の突き合わせでは、
現時点で**実装とテストの乖離なし**。DROP_V4 の 6 エントリすべてが `firewall-phase1.sh:75` で構造的に検証され、DNS pin の udp/tcp 両方が `firewall-dns.sh:68-71` で確認されている。`fc00::/7`・`fec0::/10` の IPv6 DROP と `fe80::/10` を意図的に開ける設計も `firewall-phase1.sh:126-130` で正しく検証されている。

唯一の小さな未検証領域は「`/etc/resolv.conf` に nameserver が空の場合に DNS-to-any の広範 ACCEPT フォールバックが入る」コードパス（`init-firewall.sh:197-200`）で、これは `test/firewall-dns.sh` の fallback テストでも触れていない。セキュリティ上のリグレッション防止の観点から、将来のテスト追加の候補として認識しておく価値がある。
