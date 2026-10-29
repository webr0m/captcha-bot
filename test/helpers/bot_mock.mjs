import assert from "node:assert/strict";

export const env = { BOT_TOKEN: "test-token", UPSTASH_REDIS_REST_URL: "https://redis.test", UPSTASH_REDIS_REST_TOKEN: "test-redis", WEBHOOK_SECRET: "test-secret" };

export function mockBot(t, options = {}) {
  const values = new Map(Object.entries(options.values ?? {}));
  const sets = new Map(Object.entries(options.sets ?? {}).map(([key, items]) => [key, new Set(items)]));
  const expires = new Map();
  const calls = [];
  const commands = [];
  const admins = new Set(options.admins ?? [7]);
  let messageId = 100;
  let requestCount = 0;
  function get(key) {
    if ((expires.get(key) ?? Infinity) <= Date.now()) { values.delete(key); sets.delete(key); expires.delete(key); }
    return values.get(key) ?? null;
  }
  function command(args) {
    commands.push(args);
    const [cmd, key, ...rest] = args;
    switch (cmd) {
      case "PING": return "PONG";
      case "GET": return get(key);
      case "MGET": return [key, ...rest].map(get);
      case "MSET": {
        const entries = [key, ...rest];
        for (let i = 0; i < entries.length; i += 2) { values.set(entries[i], String(entries[i + 1])); expires.delete(entries[i]); }
        return "OK";
      }
      case "SET":
        if (rest.includes("NX") && get(key) !== null) return null;
        values.set(key, String(rest[0]));
        expires.delete(key);
        return "OK";
      case "SETEX": values.set(key, String(rest[1])); expires.set(key, Date.now() + Number(rest[0]) * 1000); return "OK";
      case "DEL": return [key, ...rest].reduce((n, k) => { const had = values.has(k) || sets.has(k); values.delete(k); sets.delete(k); expires.delete(k); return n + Number(had); }, 0);
      case "INCR": case "INCRBY": { const value = Number(get(key) ?? 0) + (cmd === "INCR" ? 1 : Number(rest[0])); values.set(key, String(value)); return value; }
      case "EXPIRE": expires.set(key, Date.now() + Number(rest[0]) * 1000); return 1;
      case "SMEMBERS": return [...(sets.get(key) ?? [])];
      case "SISMEMBER": return Number(sets.get(key)?.has(String(rest[0])) ?? false);
      case "SCARD": return sets.get(key)?.size ?? 0;
      case "SADD": { const set = sets.get(key) ?? new Set(); const old = set.size; set.add(String(rest[0])); sets.set(key, set); return set.size - old; }
      case "SREM": return Number(sets.get(key)?.delete(String(rest[0])) ?? false);
      case "KEYS": { const re = new RegExp(`^${key.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`); return [...new Set([...values.keys(), ...sets.keys()])].filter((k) => re.test(k)); }
      case "EVAL": {
        // compareSet: EVAL script 1 key expected value seconds.
        assert.match(key, /redis\.call\('GET'/);
        const [, target, expected, value, seconds] = rest;
        if (get(target) !== expected) return 0;
        values.set(target, value); expires.set(target, Date.now() + Number(seconds) * 1000); return 1;
      }
      default: throw new Error(`Unexpected Redis command: ${cmd}`);
    }
  }
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    requestCount++;
    if (requestCount > (options.maxRequests ?? Infinity)) throw new Error("Too many subrequests by single Worker invocation");
    const url = String(input);
    if (url === env.UPSTASH_REDIS_REST_URL) return Response.json({ result: command(JSON.parse(init.body)) });
    if (url === `${env.UPSTASH_REDIS_REST_URL}/pipeline`) return Response.json(JSON.parse(init.body).map((args) => ({ result: command(args) })));
    assert.ok(url.startsWith("https://api.telegram.org/bottest-token/"), `Unexpected external request: ${url}`);
    const method = url.split("/").at(-1);
    const body = JSON.parse(init.body ?? "{}");
    calls.push({ method, body });
    const custom = await options.telegram?.(method, body);
    if (custom instanceof Response) return custom;
    if (custom !== undefined) return Response.json({ ok: true, result: custom });
    let result = true;
    if (method === "getMe") result = { id: 999, username: "Antiubot", is_bot: true };
    else if (method === "getChatMember") result = { status: admins.has(body.user_id) || body.user_id === 999 ? "administrator" : "member", can_delete_messages: true, can_restrict_members: true };
    else if (method === "getChatAdministrators") result = [...admins].map((id) => ({ user: { id }, status: "administrator" }));
    else if (method === "getChat") result = body.chat_id < 0 ? { id: body.chat_id, type: "supergroup", title: "Grupo de prueba", is_forum: options.forum ?? true, permissions: options.permissions ?? { can_send_messages: true, can_send_photos: false } } : { id: body.chat_id, first_name: "Usuario" };
    else if (method.startsWith("send")) result = { message_id: ++messageId, chat: { id: body.chat_id }, message_thread_id: body.message_thread_id };
    else if (method === "getChatMemberCount") result = 10;
    return Response.json({ ok: true, result });
  });
  return { values, sets, expires, calls, commands, admins, get, get requestCount() { return requestCount; }, resetRequestCount() { requestCount = 0; } };
}

export function message(overrides = {}) {
  return { message_id: 20, chat: { id: -1001, type: "supergroup", is_forum: true }, from: { id: 42, first_name: "Usuario" }, is_topic_message: true, message_thread_id: 55, text: "hola", ...overrides };
}

export function callback(data, overrides = {}) {
  return { id: "callback-1", data, from: { id: 7 }, message: message({ from: { id: 999 }, message_id: 100 }), ...overrides };
}
