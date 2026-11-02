/** Configure Telegram's default menu from the Worker, without exporting secrets. */
import { createRedis } from "./redis";
import { TelegramApi } from "./telegram";
import { MINIAPP_URL, type MiniAppEnv } from "./miniapp";

const MENU_KEY = "telegram_menu:miniapp:v1";
export async function ensureMiniAppMenu(
  env: MiniAppEnv,
  api: TelegramApi,
): Promise<void> {
  const rdb = createRedis(env);
  if ((await rdb.get(MENU_KEY)) === MINIAPP_URL) return;
  await api.setChatMenuButton({
    type: "web_app",
    text: "📱 Panel",
    web_app: { url: MINIAPP_URL },
  });
  const button = await api.getChatMenuButton();
  if (button?.type !== "web_app" || button?.web_app?.url !== MINIAPP_URL)
    throw new Error("Telegram menu verification failed");
  await rdb.set(MENU_KEY, MINIAPP_URL);
  console.info("telegram_miniapp_menu", { configured: true, verified: true });
}
