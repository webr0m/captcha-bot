/**
 * Módulo donate — /donate y callback crypto.
 * Portado desde `bot/modules/donate.lua`.
 */

import { RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";

export async function handleDonate(env: RedisEnv, api: TelegramApi, chatId: number): Promise<void> {
  void env;
  const text = `🙏 <b>¡Gracias por tu interés en apoyar el proyecto!</b>\n\nPuedes contribuir con donaciones usando cualquiera de los siguientes métodos:`;
  const kb = {
    inline_keyboard: [
      [
        { text: "💳 Paypal", url: "https://paypal.me/webr0m" },
        { text: "🪙 Criptomonedas", callback_data: "crypto" },
      ],
      [{ text: "☕ Invítame un café", url: "https://buymeacoffee.com/webrom" }],
    ],
  };
  await api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: kb });
}

export async function handleCryptoCallback(env: RedisEnv, api: TelegramApi, chatId: number, cb: any): Promise<void> {
  void env;
  const text =
    `🪙 <b>Billeteras para enviar cryptos:</b>\n\n` +
    `<b>Bitcoin</b>\n<pre>bc1ql4txu06a00e285jef8ktldeu7s4lwl474hypat</pre>\n\n` +
    `<b>Litecoin</b>\n<pre>ltc1q0kf5ccq3d3t399vz5cae6yjdwpj7r4dl4gk7tt</pre>\n\n` +
    `<b>BTC</b>\n<pre>0x3C94F5F602E086aA8BF0FE216073275ee0b3aa51</pre>\n\n` +
    `<b>TON</b>\n<pre>UQAHNsfmoieCQUvx9w3hT4ffSmj4PRiWnCAE4lFsMqzc3-KZ</pre>`;
  await api.answerCallbackQuery(cb.id, "Gracias por tu interés 💡", true).catch(() => null);
  await api.sendMessage(chatId, text, { parse_mode: "HTML" });
}
