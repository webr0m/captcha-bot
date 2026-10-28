/**
 * Módulo cleaner — mantenimiento periodico (placeholder hasta portar cleanup avanzado).
 * Portado desde `bot/modules/cleaner.lua`.
 */

import { RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";

export async function runCleaner(_env: RedisEnv, _api: TelegramApi): Promise<void> {
  // TODO: implementar limpieza de keys expiradas / usuarios no verificados cuando se migren más módulos.
}
