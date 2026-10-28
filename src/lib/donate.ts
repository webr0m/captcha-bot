/**
 * Módulo donate — /donate y callback crypto.
 * Portado desde `bot/modules/donate.lua`.
 */

import { RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";

export async function handleDonate(env: any, api: TelegramApi, chatId: number): Promise<void> {
  const lang = await Promise.resolve("es");
  const text = `🙏 *¡Gracias por tu interés en apoyar el proyecto!*\n\nPuedes contribuir con donaciones usando cualquiera de los siguientes métodos:\n`;
  const kb = {
    inline_keyboard: [
      [
        { text: "💳 Paypal", url: "https://paypal.me/webr0m" },
        { text: "🪙 Criptomonedas", callback_data: "crypto" },
      ],
      [{ text: "☕ Invítame un café", url: "https://buymeacoffee.com/webrom" }],
    ],
  };
  await api.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

export async function handleCryptoCallback(env: any, api: TelegramApi, chatId: number, cb: any): Promise<void> {
  const text = `🪙 *Billeteras para enviar cryptos:*\n\n*Bitcoin*\n` + "```" + "bc1ql4txu06a00e285jef8ktldeu7s4lwl474hypat" + "```" + `\n\n*Litecoin*\n` + "```" + "ltc1q0kf5ccq3d3t399vz5cae6yjdwpj7r4dl4gk7tt" + "```" + `\n\n*BTC*\n` + "```" + "0x3C94F5F602E086aA8BF0FE216073275ee0b3aa51" + "```" + `\n\n*TON*\n` + "```" + "UQAHNsfmoieCQUvx9w3hT4ffSmj4PRiWnCAE4lFsMqzc3-KZ" + "```";
  await api.answerCallbackQuery(cb.id, "Gracias por tu interés 💡", true).catch(() => null);
  await api.sendMessage(chatId, text, { parse_mode: "MarkdownV2" });
}
