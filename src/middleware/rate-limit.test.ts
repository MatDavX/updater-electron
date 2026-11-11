import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { rateLimiter } from "./rate-limit";

// `rateLimiter()` lê RATE_LIMIT_MAX/RATE_LIMIT_WINDOW de `Bun.env` na hora em
// que é CONSTRUÍDO (não a cada request), então o env precisa estar setado
// antes da chamada — igual ao padrão de `forceOpenMode()` em fleet-admin.test.ts.
describe("rateLimiter", () => {
  const ORIGINAL_MAX = Bun.env.RATE_LIMIT_MAX;
  const ORIGINAL_WINDOW = Bun.env.RATE_LIMIT_WINDOW;

  beforeAll(() => {
    Bun.env.RATE_LIMIT_MAX = "3";
    Bun.env.RATE_LIMIT_WINDOW = "60000";
  });

  afterAll(() => {
    if (ORIGINAL_MAX === undefined) delete Bun.env.RATE_LIMIT_MAX;
    else Bun.env.RATE_LIMIT_MAX = ORIGINAL_MAX;
    if (ORIGINAL_WINDOW === undefined) delete Bun.env.RATE_LIMIT_WINDOW;
    else Bun.env.RATE_LIMIT_WINDOW = ORIGINAL_WINDOW;
  });

  it("propagates via .as('scoped') so a route on the parent app is limited", async () => {
    const max = 3;
    const app = new Elysia()
      .use(rateLimiter())
      .get("/ping", () => "pong");

    const req = () =>
      app.handle(
        new Request("http://localhost/ping", {
          headers: { "x-forwarded-for": "1.2.3.4" },
        }),
      );

    let last;
    for (let i = 0; i < max + 1; i++) {
      last = await req();
    }

    expect(last!.status).toBe(429);
    expect(last!.headers.get("x-ratelimit-limit")).toBe(String(max));
    const body = await last!.json();
    expect(body.error).toBe("Too many requests");
  });

  it("allows requests under the limit", async () => {
    const app = new Elysia()
      .use(rateLimiter())
      .get("/ping", () => "pong");

    const res = await app.handle(
      new Request("http://localhost/ping", {
        headers: { "x-forwarded-for": "5.6.7.8" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-limit")).toBe("3");
  });

  describe("chamadas autenticadas", () => {
    const OLD_SECRET = Bun.env.API_SECRET;
    const OLD_WEB = Bun.env.WEB_API_SECRET;

    beforeAll(() => {
      Bun.env.API_SECRET = "s3cr3t";
      Bun.env.WEB_API_SECRET = "w3b";
    });

    afterAll(() => {
      if (OLD_SECRET === undefined) delete Bun.env.API_SECRET;
      else Bun.env.API_SECRET = OLD_SECRET;
      if (OLD_WEB === undefined) delete Bun.env.WEB_API_SECRET;
      else Bun.env.WEB_API_SECRET = OLD_WEB;
    });

    const run = async (token: string, ip: string, n: number) => {
      const app = new Elysia().use(rateLimiter()).get("/ping", () => "pong");
      const res = [];
      for (let i = 0; i < n; i++) {
        res.push(
          await app.handle(
            new Request("http://localhost/ping", {
              headers: { authorization: `Bearer ${token}`, "x-forwarded-for": ip },
            }),
          ),
        );
      }
      return res;
    };

    it("token web não conta", async () => {
      const res = await run("w3b", "9.9.9.1", 10);
      expect(res.every((r) => r.status === 200)).toBe(true);
    });

    it("token admin não conta", async () => {
      const res = await run("s3cr3t", "9.9.9.2", 10);
      expect(res.every((r) => r.status === 200)).toBe(true);
    });

    it("token inválido continua contando", async () => {
      const res = await run("errado", "9.9.9.3", 4);
      expect(res[3].status).toBe(429);
    });
  });
});
