import { mock } from "node:test";
import "../test/helpers/ts_loader.mjs";
import { mockBot, env, message, callback } from "../test/helpers/bot_mock.mjs";

const { handleUpdate } = await import("../src/lib/dispatcher.ts");
const { TelegramApi } = await import("../src/lib/telegram.ts");
const results = [];
for (const [name, options, update] of [
  ["private_config_80_groups", { values: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`group_known:${-1001 - i}`, "true"])) }, { message: message({ chat: { id: 7, type: "private" }, from: { id: 7, first_name: "Admin" }, text: "/config" }) }],
  ["settings_section", {}, { callback_query: callback("settings:section:-1001:captcha", { message: message({ chat: { id: 7, type: "private" } }) }) }],
  ["normal_group_message", { values: { "group_access_refresh:-1001": "1", "group:-1001:captcha_enabled": "true", "verify:-1001:42": "ok" } }, { message: message() }],
  ["group_link", { values: { "group_access_refresh:-1001": "1", "verify:-1001:42": "ok" } }, { message: message({ text: "https://spam.example/" }) }],
]) {
  const state = mockBot({ mock }, options);
  await handleUpdate(env, new TelegramApi(env.BOT_TOKEN), update);
  results.push({ flow: name, http_requests: state.requestCount, redis_commands: state.commands.length, telegram_requests: state.calls.length });
  mock.restoreAll();
}
console.log(JSON.stringify({ label: process.argv[2] ?? "current", note: "Real code with mocked services; request counts, not a network latency measurement.", results }, null, 2));
