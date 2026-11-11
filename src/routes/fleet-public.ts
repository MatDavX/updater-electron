import { Elysia, t } from "elysia";
import type { StateStore } from "../state-store";
import type { SSEBroker } from "../sse";
import { upsertHeartbeat, effectiveMinVersion } from "../fleet";

const short = t.String({ minLength: 1, maxLength: 200 });
const optShort = t.Optional(t.String({ maxLength: 200 }));

// Rota PÚBLICA (sem token): o PDV se identifica aqui no boot, a cada 30 min e
// ao logar. Só alimenta inventário — nada aqui muda comportamento de update.
export function fleetPublicRoutes(store: StateStore, broker?: SSEBroker) {
  return new Elysia().post(
    "/fleet/heartbeat",
    ({ body, set }) => {
      const before = effectiveMinVersion(store, body.terminalId);
      upsertHeartbeat(store, body);
      // O heartbeat pode revelar a empresa do terminal; se isso subiu a
      // exigência efetiva (forçado por empresa), avisa o app já aberto.
      // Nunca envia emergency-clear daqui.
      const after = effectiveMinVersion(store, body.terminalId);
      if (broker && after !== null && after !== before) {
        broker.sendTo(body.terminalId, "emergency", { minVersion: after, version: after });
      }
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
