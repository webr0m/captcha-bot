/** Per-invocation timings. Never include URLs, keys, tokens, IDs or message text. */
const TRACE = Symbol("performanceTrace");
type Service = "redis" | "telegram";
interface Counter { requests: number; operations: number; elapsed_ms: number; errors: number; }
interface Trace { redis: Counter; telegram: Counter; }
export interface PerformanceEnv { PERFORMANCE_SAMPLE_RATE?: string; [TRACE]?: Trace; }

export function startPerformance<T extends PerformanceEnv>(env: T, kind: string, colo?: unknown) {
  const rate = Math.max(0, Math.min(1, Number(env.PERFORMANCE_SAMPLE_RATE) || 0));
  const selected = rate > 0 && (kind === "cron" || kind === "configuration" || Math.random() < rate);
  const started = Date.now();
  const counter = (): Counter => ({ requests: 0, operations: 0, elapsed_ms: 0, errors: 0 });
  const trace: Trace = { redis: counter(), telegram: counter() };
  return {
    env: selected ? { ...env, [TRACE]: trace } : env,
    finish() {
      if (selected) console.info("bot_performance", { kind, colo: typeof colo === "string" ? colo.slice(0, 8) : undefined, elapsed_ms: Date.now() - started, ...trace });
    },
  };
}

export async function measureIo<T>(env: PerformanceEnv, service: Service, operations: number, run: () => Promise<T>): Promise<T> {
  const counter = env[TRACE]?.[service];
  if (!counter) return run();
  const started = Date.now();
  counter.requests++;
  counter.operations += operations;
  try { return await run(); }
  catch (error) { counter.errors++; throw error; }
  finally { counter.elapsed_ms += Date.now() - started; }
}
