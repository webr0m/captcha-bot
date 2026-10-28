/**
 * Parseo de la respuesta de CAS (Combot Anti-Spam) y de su caché.
 * Módulo puro, sin red, para tests.
 */

export interface CasVerdict {
  listed: boolean;
  offenses: number;
}

/**
 * La API de CAS responde `{ok:true,result:{offenses:N}}` cuando el usuario
 * está en la lista, y `{ok:false,error:"Not found"}` cuando no lo está.
 */
export function parseCasResponse(payload: any): CasVerdict {
  if (payload && payload.ok === true) {
    const raw = Number(payload.result?.offenses ?? 0);
    const offenses = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 1;
    return { listed: true, offenses };
  }
  return { listed: false, offenses: 0 };
}

export function encodeCasCache(verdict: CasVerdict): string {
  return verdict.listed ? `listed:${verdict.offenses}` : "clean";
}

export function decodeCasCache(value: string | null | undefined): CasVerdict | null {
  if (!value) return null;
  if (value === "clean") return { listed: false, offenses: 0 };
  const m = String(value).match(/^listed:(\d+)$/);
  if (!m) return null;
  return { listed: true, offenses: Number(m[1]) };
}
