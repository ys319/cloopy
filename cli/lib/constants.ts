/** デフォルトインスタンス名 */
export const DEFAULT_INSTANCE_NAME = "cloopy";

/** デフォルト SSH ポート */
export const DEFAULT_SSH_PORT = "10022";

/** デフォルトタイムゾーン */
export const DEFAULT_TIMEZONE = "Asia/Tokyo";

/** デフォルトワークスペースパス */
export const DEFAULT_WORKSPACE = "./workspace";

/** docker compose --wait-timeout (秒) */
export const COMPOSE_WAIT_TIMEOUT = "300";

/** docker compose up で常に使用する引数 */
export const COMPOSE_UP_ARGS = [
  "up",
  "-d",
  "--wait",
  "--wait-timeout",
  COMPOSE_WAIT_TIMEOUT,
  "--remove-orphans",
] as const;
