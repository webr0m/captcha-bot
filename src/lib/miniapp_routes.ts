import { TelegramApi } from "./telegram";
import { hasGroupAccessLive } from "./access";
import {
  validateInitData,
  listAdminGroups,
  readSettings,
  saveSettings,
  readStats,
  MiniAppError,
  type MiniAppEnv,
} from "./miniapp";

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
export async function handleMiniAppRequest(
  request: Request,
  env: MiniAppEnv,
): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: HEADERS });
  try {
    const url = new URL(request.url);
    const path = url.pathname;
    if (
      ![
        "/api/miniapp/groups",
        "/api/miniapp/settings",
        "/api/miniapp/stats",
      ].includes(path)
    )
      return json({ ok: false, error: "Ruta desconocida." }, 404);
    if (
      request.method !== "GET" &&
      !(path === "/api/miniapp/settings" && request.method === "POST")
    )
      return json({ ok: false, error: "Método no permitido." }, 405);
    let body: any = null;
    if (request.method === "POST") {
      if (
        !(request.headers.get("Content-Type") ?? "").startsWith(
          "application/json",
        )
      )
        throw new MiniAppError("Envía JSON válido.");
      const text = await request.text();
      if (text.length > 32768)
        throw new MiniAppError("Solicitud demasiado grande.", 413);
      try {
        body = JSON.parse(text);
      } catch {
        throw new MiniAppError("JSON inválido.");
      }
    }
    // Authentication stays out of URLs, access logs and referrers.
    const header = request.headers.get("Authorization") ?? "";
    const initData = header.startsWith("tma ")
      ? header.slice(4)
      : typeof body?.initData === "string"
        ? body.initData
        : "";
    const auth = await validateInitData(initData, env.BOT_TOKEN);
    if (!auth.ok)
      return json(
        {
          ok: false,
          error:
            "Sesión inválida o caducada. Cierra y abre la Mini App desde Telegram.",
        },
        401,
      );
    const api = TelegramApi.fromEnv(env);
    if (path === "/api/miniapp/groups") {
      const page = Number(url.searchParams.get("page") ?? 0);
      if (!Number.isSafeInteger(page) || page < 0)
        throw new MiniAppError("Página inválida.");
      return json({
        ok: true,
        ...(await listAdminGroups(env, api, auth.userId, page)),
      });
    }
    const rawGid =
      request.method === "POST" ? body?.gid : url.searchParams.get("gid");
    if (
      (typeof rawGid !== "string" && typeof rawGid !== "number") ||
      !/^-[1-9]\d*$/.test(String(rawGid))
    )
      throw new MiniAppError("Grupo inválido.");
    const gid = Number(rawGid);
    if (!Number.isSafeInteger(gid)) throw new MiniAppError("Grupo inválido.");
    if (request.method === "POST")
      return json(
        await saveSettings(env, api, gid, auth.userId, body?.changes),
      );
    if (
      !(await hasGroupAccessLive(env, api, gid, auth.userId, { cache: false }))
    )
      return json(
        { ok: false, error: "No eres administrador del grupo." },
        403,
      );
    if (path === "/api/miniapp/settings") {
      const [settings, group] = await Promise.all([
        readSettings(env, gid),
        api.getChat(gid).catch(() => null),
      ]);
      return json({
        ok: true,
        settings,
        group: { id: gid, title: String(group?.title || `Grupo ${gid}`) },
      });
    }
    return json({ ok: true, stats: await readStats(env, api, gid) });
  } catch (error) {
    if (error instanceof MiniAppError)
      return json({ ok: false, error: error.message }, error.status);
    // Do not return upstream errors: they may contain credentials or private data.
    console.error("miniapp_request_failed");
    return json(
      {
        ok: false,
        error:
          "No se pudo completar la solicitud. Actualiza e inténtalo nuevamente.",
      },
      503,
    );
  }
}
