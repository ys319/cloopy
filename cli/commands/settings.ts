import { bold, cyan, dim } from "@std/fmt/colors";
import { Input, Select } from "../lib/prompt.ts";
import { ensureEnvFile, readEnvFile, setEnvVar } from "../lib/env.ts";
import {
  DEFAULT_SSH_PORT,
  DEFAULT_TIMEZONE,
  DEFAULT_WORKSPACE,
} from "../lib/constants.ts";

interface DnsPreset {
  name: string;
  v4: [string, string];
  v6: [string, string];
}

/** Filtering DNS resolver presets (malware/phishing scope, no content filter). */
const DNS_PRESETS: Record<string, DnsPreset> = {
  cloudflare: {
    name: "Cloudflare for Families (1.1.1.2)",
    v4: ["1.1.1.2", "1.0.0.2"],
    v6: ["2606:4700:4700::1112", "2606:4700:4700::1002"],
  },
  quad9: {
    name: "Quad9 (9.9.9.9)",
    v4: ["9.9.9.9", "149.112.112.112"],
    v6: ["2620:fe::fe", "2620:fe::9"],
  },
  opendns: {
    name: "Cisco OpenDNS (208.67.222.222)",
    v4: ["208.67.222.222", "208.67.220.220"],
    v6: ["2620:119:35::35", "2620:119:53::53"],
  },
};

/** Map a primary IPv4 resolver back to its preset key (else "custom"). */
function detectDnsPreset(primary: string): string {
  for (const [key, p] of Object.entries(DNS_PRESETS)) {
    if (p.v4[0] === primary) return key;
  }
  return "custom";
}

/**
 * Interactive settings editor. Writes changes to the user-editable section of
 * `.env` (never the auto-managed block). Instance name is intentionally NOT
 * editable here — changing it renames the Compose project and volumes, so it is
 * handled by re-setup only.
 *
 * @returns true if any setting was changed (so the caller can offer to recreate
 *          the container to apply it).
 */
export async function editSettings(projectRoot: string): Promise<boolean> {
  const envPath = ensureEnvFile(projectRoot);
  let changed = false;

  while (true) {
    const env = readEnvFile(projectRoot);
    const cur = (k: string, d: string) => env.get(k) ?? d;
    const dns = cur("CLOOPY_DNS_PRIMARY", "1.1.1.2");
    const dnsSecondary = cur("CLOOPY_DNS_SECONDARY", "1.0.0.2");
    const firewall = cur("CLOOPY_FIREWALL", "on");
    const allowHost = cur("CLOOPY_ALLOW_HOST", "on");
    const port = cur("CLOOPY_SSH_PORT", DEFAULT_SSH_PORT);
    const tz = cur("CLOOPY_TIMEZONE", DEFAULT_TIMEZONE);
    const workspace = cur("CLOOPY_HOST_WORKSPACE", DEFAULT_WORKSPACE);

    console.log("");
    console.log(bold(cyan("  設定変更")));
    console.log("");

    const choice = await Select.prompt({
      message: "変更する項目",
      maxRows: 20,
      options: [
        { name: `DNS リゾルバ      (${dns})`, value: "dns" },
        { name: `Firewall          (${firewall})`, value: "firewall" },
        { name: `ホスト連携        (${allowHost})`, value: "host" },
        { name: `SSH ポート        (${port})`, value: "port" },
        { name: `タイムゾーン      (${tz})`, value: "tz" },
        { name: `ワークスペース    (${workspace})`, value: "workspace" },
        Select.separator("────────────────────────────"),
        { name: "戻る", value: "back" },
      ],
    });

    if (choice === "back") break;

    console.log("");

    switch (choice) {
      case "dns": {
        const currentPreset = detectDnsPreset(dns);
        const preset = await Select.prompt({
          message: "DNS リゾルバを選択",
          default: currentPreset,
          options: [
            {
              name: `${DNS_PRESETS.cloudflare.name} — 最速・誤遮断少なめ`,
              value: "cloudflare",
            },
            {
              name: `${DNS_PRESETS.quad9.name} — セキュリティ最優先`,
              value: "quad9",
            },
            { name: DNS_PRESETS.opendns.name, value: "opendns" },
            { name: "カスタム (IPv4 リゾルバを手入力)", value: "custom" },
          ],
        });

        if (preset === "custom") {
          const primary = (await Input.prompt({
            message: "プライマリ DNS (IPv4)",
            default: dns,
          })).trim();
          if (!primary) {
            console.log(dim("  変更なし"));
            break;
          }
          const secondary = (await Input.prompt({
            message: "セカンダリ DNS (IPv4, 任意)",
            default: "",
          })).trim();
          const newSecondary = secondary || primary;
          if (primary === dns && newSecondary === dnsSecondary) {
            console.log(dim("  変更なし"));
            break;
          }
          setEnvVar(envPath, "CLOOPY_DNS_PRIMARY", primary);
          setEnvVar(envPath, "CLOOPY_DNS_SECONDARY", newSecondary);
          console.log(
            dim("  ※ IPv6 リゾルバは据え置きです。完全に変える場合は .env の"),
          );
          console.log(
            dim("    CLOOPY_DNS_V6_PRIMARY/SECONDARY も編集してください"),
          );
          changed = true;
        } else if (preset !== currentPreset) {
          const p = DNS_PRESETS[preset];
          setEnvVar(envPath, "CLOOPY_DNS_PRIMARY", p.v4[0]);
          setEnvVar(envPath, "CLOOPY_DNS_SECONDARY", p.v4[1]);
          setEnvVar(envPath, "CLOOPY_DNS_V6_PRIMARY", p.v6[0]);
          setEnvVar(envPath, "CLOOPY_DNS_V6_SECONDARY", p.v6[1]);
          changed = true;
        } else {
          console.log(dim("  変更なし"));
        }
        break;
      }

      case "firewall": {
        const v = await Select.prompt({
          message: "Firewall (egress フィルタ)",
          default: firewall,
          options: [
            {
              name: "on  — メタデータ/private 遮断 + マルウェア DNS フィルタ",
              value: "on",
            },
            {
              name: "off — キルスイッチ (全 egress フィルタ無効)",
              value: "off",
            },
          ],
        });
        if (v !== firewall) {
          setEnvVar(envPath, "CLOOPY_FIREWALL", v);
          changed = true;
        }
        break;
      }

      case "host": {
        const v = await Select.prompt({
          message: "host.docker.internal (ホスト連携)",
          default: allowHost,
          options: [
            { name: "on  — ホスト上のサービスに到達可", value: "on" },
            { name: "off — ホストへの通信も遮断", value: "off" },
          ],
        });
        if (v !== allowHost) {
          setEnvVar(envPath, "CLOOPY_ALLOW_HOST", v);
          changed = true;
        }
        break;
      }

      case "port": {
        const v = (await Input.prompt({
          message: "SSH ポート",
          default: port,
          validate: (s: string) => {
            const n = Number(s.trim());
            return Number.isInteger(n) && n >= 1 && n <= 65535
              ? true
              : "1〜65535 の数値を入力してください";
          },
        })).trim();
        if (v && v !== port) {
          setEnvVar(envPath, "CLOOPY_SSH_PORT", v);
          changed = true;
        }
        break;
      }

      case "tz": {
        const v = (await Input.prompt({
          message: "タイムゾーン (例: Asia/Tokyo, UTC)",
          default: tz,
        })).trim();
        if (v && v !== tz) {
          setEnvVar(envPath, "CLOOPY_TIMEZONE", v);
          changed = true;
        }
        break;
      }

      case "workspace": {
        const v = (await Input.prompt({
          message: "ワークスペースのホストパス",
          default: workspace,
        })).trim();
        if (v && v !== workspace) {
          setEnvVar(envPath, "CLOOPY_HOST_WORKSPACE", v);
          changed = true;
        }
        break;
      }
    }
  }

  return changed;
}
