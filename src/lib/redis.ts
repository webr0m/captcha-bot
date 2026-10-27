/**
 * Cliente Redis para Cloudflare Workers.
 * Usa la API REST de Upstash (compatible con Redis) vía fetch.
 * Soportado por el bot: GET, SET, SETEX, DEL, INCR, EXPIRE, SMEMBERS, SISMEMBER, SADD, SREM, KEYS, PING.
 */

export interface RedisEnv {
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
}

async function upstashCommand(env: RedisEnv, args: Array<string | number>): Promise<any> {
  const res = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([args]),
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Upstash REST error (${res.status}): ${JSON.stringify(data)}`);
  }
  if (data && typeof data === "object" && !Array.isArray(data) && typeof data.error === "string") {
    throw new Error(`Upstash REST error: ${data.error}`);
  }
  if (Array.isArray(data)) return data[0];
  return data;
}

export interface RedisClient {
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  setex(key: string, seconds: number, value: string): Promise<void>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  smembers(key: string): Promise<string[]>;
  sismember(key: string, member: string): Promise<boolean>;
  sadd(key: string, member: string): Promise<number>;
  srem(key: string, member: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
}

export function createRedis(env: RedisEnv): RedisClient {
  return {
    async ping() {
      return (await upstashCommand(env, ["PING"])) as string;
    },
    async get(key) {
      const value = await upstashCommand(env, ["GET", key]);
      if (value === null || value === undefined) return null;
      return String(value);
    },
    async set(key, value) {
      await upstashCommand(env, ["SET", key, value]);
    },
    async setex(key, seconds, value) {
      await upstashCommand(env, ["SETEX", key, seconds, value]);
    },
    async del(...keys) {
      const result = await upstashCommand(env, ["DEL", ...keys]);
      return Number(result);
    },
    async incr(key) {
      const result = await upstashCommand(env, ["INCR", key]);
      return Number(result);
    },
    async expire(key, seconds) {
      const result = await upstashCommand(env, ["EXPIRE", key, seconds]);
      return Number(result);
    },
    async smembers(key) {
      const result = await upstashCommand(env, ["SMEMBERS", key]);
      if (Array.isArray(result)) return result.map((m) => String(m));
      return [];
    },
    async sismember(key, member) {
      const result = await upstashCommand(env, ["SISMEMBER", key, member]);
      return Number(result) === 1;
    },
    async sadd(key, member) {
      const result = await upstashCommand(env, ["SADD", key, member]);
      return Number(result);
    },
    async srem(key, member) {
      const result = await upstashCommand(env, ["SREM", key, member]);
      return Number(result);
    },
    async keys(pattern) {
      const result = await upstashCommand(env, ["KEYS", pattern]);
      if (Array.isArray(result)) return result.map((k) => String(k));
      return [];
    },
  };
}
