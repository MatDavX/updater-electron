import { Elysia, t } from "elysia";
import type { StateStore } from "../state-store";
import type { SSEBroker } from "../sse";
import { authGuard } from "../middleware/auth";
import { listFleet, setForced, clearForced, removeTerminal, effectiveMinVersion } from "../fleet";

const SEMVER = /^\d+\.\d+\.\d+$/;

// Rotas ADMIN (token) de frota: listar terminais e forçar/cancelar update
// obrigatório em UM terminal. O cliente só entra em modo obrigatório se a
// versão dele for menor que minVersion (guard no PDV) — forçar "1.5.0" num
// terminal já em 1.5.0 é no-op lá.
export function fleetAdminRoutes(store: StateStore, broker: SSEBroker) {
  return new Elysia({ prefix: "/api/fleet" })
    .use(authGuard())
    .get("/", () => ({
      terminals: listFleet(store, (id) => broker.isConnected(id)),
    }))
    .post(
      "/:terminalId/force",
      ({ params, body, set }) => {
        const { terminalId } = params;
        const { minVersion } = body;
        if (!store.get().fleet[terminalId]) {
          set.status = 404;
          return { error: "Terminal not found" };
        }
        if (!SEMVER.test(minVersion)) {
          set.status = 400;
          return { error: "minVersion must be x.y.z" };
        }
        setForced(store, terminalId, minVersion);
        // Apps abertos recebem na hora; fechados pegam no boot via
        // /min-version.json?terminalId= (Task S4, min-version.ts).
        const delivered = broker.sendTo(terminalId, "emergency", { minVersion, version: minVersion });
        return { status: "ok", terminalId, minVersion, online: delivered > 0 };
      },
      { body: t.Object({ minVersion: t.String({ maxLength: 32 }) }) },
    )
    .delete("/:terminalId/force", ({ params }) => {
      const { terminalId } = params;
      clearForced(store, terminalId);
      // Se ainda houver emergência GLOBAL ativa, o terminal continua
      // obrigado a atualizar — não mandamos "emergency-clear" nesse caso,
      // senão o modal obrigatório seria dispensado indevidamente.
      const eff = effectiveMinVersion(store, terminalId);
      if (eff === null) {
        broker.sendTo(terminalId, "emergency-clear", {});
      } else {
        broker.sendTo(terminalId, "emergency", { minVersion: eff, version: eff });
      }
      return { status: "ok", terminalId };
    })
    .delete("/:terminalId", ({ params, set }) => {
      const removed = removeTerminal(store, params.terminalId);
      if (!removed) {
        set.status = 404;
        return { error: "Terminal not found" };
      }
      return { status: "ok", terminalId: params.terminalId };
    });
}
