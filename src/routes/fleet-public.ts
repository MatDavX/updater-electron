import { Elysia, t } from "elysia";
import type { StateStore } from "../state-store";
import { upsertHeartbeat } from "../fleet";

const short = t.String({ minLength: 1, maxLength: 200 });
const optShort = t.Optional(t.String({ maxLength: 200 }));

// Rota PÚBLICA (sem token): o PDV se identifica aqui no boot, a cada 30 min e
// ao logar. Só alimenta inventário — nada aqui muda comportamento de update.
export function fleetPublicRoutes(store: StateStore) {
  return new Elysia().post(
    "/fleet/heartbeat",
    ({ body, set }) => {
      upsertHeartbeat(store, body);
      set.status = 204;
      return;
    },
    {
      body: t.Object({
        terminalId: t.String({ minLength: 1, maxLength: 64 }),
        terminalName: short,
        version: t.String({ minLength: 1, maxLength: 32 }),
        platform: t.String({ minLength: 1, maxLength: 32 }),
        arch: t.String({ minLength: 1, maxLength: 32 }),
        companyId: optShort,
        unitId: optShort,
        userId: optShort,
        userName: optShort,
        userEmail: optShort,
      }),
    },
  );
}
