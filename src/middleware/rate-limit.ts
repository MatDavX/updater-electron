import { Elysia } from "elysia";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export function rateLimiter(opts?: { window?: number; max?: number }) {
  const window = opts?.window ?? (Number(Bun.env.RATE_LIMIT_WINDOW) || 60_000);
  const max = opts?.max ?? (Number(Bun.env.RATE_LIMIT_MAX) || 100);
  const store = new Map<string, RateLimitEntry>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key);
    }
  }, 60_000);

  return new Elysia({ name: "rate-limiter" })
    .onBeforeHandle(({ headers, set }) => {
      const ip =
        headers["x-forwarded-for"]?.split(",")[0]?.trim() ??
        headers["x-real-ip"] ??
        "unknown";

      const now = Date.now();
      let entry = store.get(ip);

      if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + window };
        store.set(ip, entry);
      }

      entry.count++;

      set.headers["x-ratelimit-limit"] = String(max);
      set.headers["x-ratelimit-remaining"] = String(
        Math.max(0, max - entry.count),
      );
      set.headers["x-ratelimit-reset"] = String(
        Math.ceil(entry.resetAt / 1000),
      );

      if (entry.count > max) {
        set.status = 429;
        return {
          error: "Too many requests",
          retryAfter: Math.ceil((entry.resetAt - now) / 1000),
        };
      }
    })
    // Mesmo bug de escopo que `authGuard` tinha: `onBeforeHandle` por padrão
    // só se aplica à própria instância do plugin, não ao app pai que faz
    // `.use(rateLimiter())`. `.as("scoped")` propaga um nível acima — em
    // `index.ts` o limiter é `.use()`d no `app` top-level, então o guard
    // passa a valer para as rotas do `app`.
    .as("scoped");
}
