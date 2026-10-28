/**
 * Módulo di — animación de "escribiendo" con animación de stickers + MarkdownV2.
 * Portado desde `bot/modules/di.lua`.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { addTask } from "./tasks";

const ANIMATION_FILE_ID = "CgACAgEAAxkBAAEC4WhoiiRlq62N6TM-6_r2Sq0TFxwcCwACHQUAArYiUUR7SGkRhH0SGjYE";

function escapeMarkdownV2(text: string): string {
  return text.replace(/([_\\%*%\[\]\(\)\%~`\>%#\%+\-%=\|%{\}%!\%.])/g, "\\$1");
}

function escapeInlineMarkdown(text: string): string {
  // escapa por segmentos, preservando menciones [text](url) y emojis
  const parts = text.split(/(\[[^\]]*\]\([^)]*\))/g);
  return parts.map((p) => {
    if (/^\[[^\]]*\]\(.*\)$/.test(p)) {
      return p.replace(/([\\])/g, "$1");
    }
    return p.replace(/([_\\%*%\[\]\(\)\%~`\>%#\%+\-%=\|%{\}%!\%.])/g, "\\$1");
  }).join("");
}

function prepareMarkdownV2(text: string): string {
  const codeSplit = text.split(/```/);
  // simple: escapar todo except bloques de codigo
  const out: string[] = [];
  let inCode = false;
  for (const part of codeSplit) {
    if (part.startsWith("\n") || part.trim() === "") { /* noop */ }
    out.push(inCode ? escapeMarkdownV2(part) : escapeInlineMarkdown(part));
    inCode = !inCode;
  }
  return out.join("```");
}

export async function handleDi(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  const text = String(msg?.text ?? "");
  const isCommand = /^\/di(?:@\S+)?\s/.test(text);
  if (!isCommand) return;
  const userId = Number(msg?.from?.id);
  const chatId = Number(msg?.chat?.id);

  const cooldownKey = `cooldown:${userId}:di`;
  const last = await createRedis(env).get(cooldownKey);
  const lastNum = last ? Number(last) : 0;
  const nowSec = Math.floor(Date.now() / 1000);
  if (lastNum && nowSec - lastNum < 5) {
    const wait = 5 - (nowSec - lastNum);
    await api.sendMessage(chatId, `⏳ Por favor espera ${wait}s antes de volver a usar este comando.`);
    return;
  }
  await createRedis(env).setex(cooldownKey, 5, String(nowSec));

  const args = text.replace(/^\/di(?:@\S+)?\s*/, "");
  const mention = args.match(/^(@\S+)\s+(.+)$/);
  const finalText = mention ? `${mention[1]} ${mention[2]}` : args;
  if (!finalText) return;

  const sent = await api.sendAnimation(chatId, ANIMATION_FILE_ID, "");
  const sentAny = sent as any;
  const msgId = sentAny?.result?.message_id;
  const now = Math.floor(Date.now() / 1000);
  await addTask(env, { type: "del", chatId, param: Number(msgId), runAt: now + 2 });

  const safeText = prepareMarkdownV2(finalText);
  await api.sendMessage(chatId, safeText, { parse_mode: "MarkdownV2" });
}
