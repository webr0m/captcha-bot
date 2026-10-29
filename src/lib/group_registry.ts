/** Discovery index only: never grants authorization without checking Telegram. */
import { createRedis, type RedisEnv, type RedisCommand } from "./redis";
export const ADMIN_INDEX_READY = "admin_index:v1:ready";
export const adminGroupsKey = (userId: number) => `admin_groups:v1:${userId}`;

export async function adminIndexCommands(env: RedisEnv, gid: number, admins: any[]): Promise<RedisCommand[]> {
  const previous = await createRedis(env).smembers(`group_admins:v1:${gid}`);
  const current = new Set(admins.map((admin) => Number(admin?.user?.id)).filter((id) => Number.isSafeInteger(id) && id > 0));
  const commands: RedisCommand[] = [["DEL", `group_admins:v1:${gid}`]];
  for (const uid of previous) if (!current.has(Number(uid))) commands.push(["SREM", adminGroupsKey(Number(uid)), String(gid)]);
  for (const uid of current) commands.push(["SADD", adminGroupsKey(uid), String(gid)], ["SADD", `group_admins:v1:${gid}`, String(uid)]);
  return commands;
}
