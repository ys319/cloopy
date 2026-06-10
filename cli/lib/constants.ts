/** デフォルトインスタンス名 */
export const DEFAULT_INSTANCE_NAME = "cloopy";

/** デフォルト SSH ポート */
export const DEFAULT_SSH_PORT = "10022";

/** デフォルトタイムゾーン */
export const DEFAULT_TIMEZONE = "Asia/Tokyo";

/** デフォルトワークスペースパス */
export const DEFAULT_WORKSPACE = "./workspace";

/**
 * SSH ポートを localhost のみに bind する CLOOPY_SSH_BIND 値。
 * compose 側は `"${CLOOPY_SSH_BIND:-}${CLOOPY_SSH_PORT:-10022}:22"` のため
 * 末尾コロンを含む。空文字 = 全インターフェース (Docker 既定の v4+v6)。
 */
export const LOCAL_BIND = "127.0.0.1:";

/** docker compose --wait-timeout (秒) */
export const COMPOSE_WAIT_TIMEOUT = "300";

/** docker compose up で常に使用する引数 */
// --build: イメージを常に最新の Dockerfile/s6 スクリプトと同期させる。
// これがないと git pull 後の再作成が「旧イメージ + 新 compose 設定」の
// 組合せになり、初期化スクリプトの前提が食い違って起動不能になりうる
// （キャッシュが効くので通常は数秒で済む）。
export const COMPOSE_UP_ARGS = [
  "up",
  "-d",
  "--build",
  "--wait",
  "--wait-timeout",
  COMPOSE_WAIT_TIMEOUT,
  "--remove-orphans",
] as const;
