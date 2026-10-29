/**
 * Cliente Redis para Cloudflare Workers.
 * Usa la API REST de Upstash (compatible con Redis) vía fetch.
 * Incluye MGET/MSET y pipeline explícito para reducir viajes HTTP.
 */

import { measureIo, type PerformanceEnv } from "./performance";

export interface RedisEnv extends PerformanceEnv {
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
}

export type RedisCommand = Array<string | number>;

async function upstashRequest(env: RedisEnv, body: RedisCommand | RedisCommand[], pipeline = false): Promise<any> {
  return measureIo(env, "redis", pipeline ? body.length : 1, async () => {
    const res = await fetch(env.UPSTASH_REDIS_REST_URL.replace(/\/+$/, "") + (pipeline ? "/pipeline" : ""), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Upstash REST error (${res.status}): ${JSON.stringify(data)}`);
    return data;
  });
}

function commandResult(data: any): any {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    if (typeof data.error === "string") {
      throw new Error(`Upstash REST error: ${data.error}`);
    }
    if ("result" in data) return data.result;
  }
  if (Array.isArray(data)) return data[0];
  throw new Error("Invalid Upstash REST response");
}

async function upstashCommand(env: RedisEnv, args: RedisCommand): Promise<any> {
  return commandResult(await upstashRequest(env, args));
}

export interface RedisClient {
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  set(key: string, value: string): Promise<void>;
  mset(values: Record<string, string>): Promise<void>;
  /** Independent commands, in order. Not atomic; never replay after partial failure. */
  pipeline(commands: RedisCommand[]): Promise<any[]>;
  setex(key: string, seconds: number, value: string): Promise<void>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  incrby(key: string, amount: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  setnx(key: string, value: string): Promise<boolean>;
  compareSet(key: string, expected: string, value: string, seconds: number): Promise<boolean>;
  smembers(key: string): Promise<string[]>;
  sismember(key: string, member: string): Promise<boolean>;
  sadd(key: string, member: string): Promise<number>;
  srem(key: string, member: string): Promise<number>;
  scard(key: string): Promise<number>;
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
    async mget(...keys) {
      if (!keys.length) return [];
      const values = await upstashCommand(env, ["MGET", ...keys]);
      if (!Array.isArray(values) || values.length !== keys.length) throw new Error("Invalid Upstash MGET response");
      return values.map((value) => value === null || value === undefined ? null : String(value));
    },
    async set(key, value) {
      await upstashCommand(env, ["SET", key, value]);
    },
    async mset(values) {
      const entries = Object.entries(values);
      if (entries.length) await upstashCommand(env, ["MSET", ...entries.flat()]);
    },
    async pipeline(commands) {
      if (!commands.length) return [];
      const data = await upstashRequest(env, commands, true);
      if (!Array.isArray(data) || data.length !== commands.length) throw new Error("Invalid Upstash pipeline response");
      return data.map(commandResult);
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
    async incrby(key, amount) {
      const result = await upstashCommand(env, ["INCRBY", key, amount]);
      return Number(result);
    },
    async expire(key, seconds) {
      const result = await upstashCommand(env, ["EXPIRE", key, seconds]);
      return Number(result);
    },
    async setnx(key, value) {
      const result = await upstashCommand(env, ["SET", key, value, "NX"]);
      return result === "OK";
    },
    async compareSet(key, expected, value, seconds) {
      const script = "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]); return 1 else return 0 end";
      return Number(await upstashCommand(env, ["EVAL", script, 1, key, expected, value, seconds])) === 1;
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
    async scard(key) {
      const result = await upstashCommand(env, ["SCARD", key]);
      return Number(result);
    },
    async keys(pattern) {
      const result = await upstashCommand(env, ["KEYS", pattern]);
      if (Array.isArray(result)) return result.map((k) => String(k));
      return [];
    },
  };
}
