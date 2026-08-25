import { describe, it, expect, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { apiRoutes } from "./api";
import { stateStore } from "../state-store";
import { sseBroker } from "../sse";

// `apiRoutes` usa os singletons `stateStore`/`sseBroker` diretamente (não
// injetados), então este teste manipula esses singletons e restaura o
// estado no `afterEach` para não vazar entre testes/arquivos.
function buildApp() {
  return new Elysia().use(apiRoutes({} as never, {} as never));
}

afterEach(async () => {
  stateStore.update((s) => {
    s.minVersion = null;
    s.forced = {};
  });
  await stateStore.flush();
});

describe("DELETE /api/emergency", () => {
  it("sends emergency-clear to everyone except terminals with an active forced update", async () => {
    const app = buildApp();

    stateStore.update((s) => {
      s.minVersion = "1.3.0";
      s.forced = { forced1: { minVersion: "1.5.0", createdAt: new Date().toISOString() } };
    });

    const forcedGot: string[] = [];
    const plainGot: string[] = [];
    const anonGot: string[] = [];
    const unsubForced = sseBroker.subscribe((m) => forcedGot.push(m), { terminalId: "forced1" });
    const unsubPlain = sseBroker.subscribe((m) => plainGot.push(m), { terminalId: "plain1" });
    const unsubAnon = sseBroker.subscribe((m) => anonGot.push(m));

    try {
      const res = await app.handle(new Request("http://localhost/api/emergency", { method: "DELETE" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok", minVersion: null });
      expect(stateStore.get().minVersion).toBeNull();

      expect(forcedGot).toHaveLength(0);
      expect(plainGot).toEqual(["event: emergency-clear\ndata: {}\n\n"]);
      expect(anonGot).toEqual(["event: emergency-clear\ndata: {}\n\n"]);
    } finally {
      unsubForced();
      unsubPlain();
      unsubAnon();
    }
  });
});
