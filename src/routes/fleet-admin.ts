import { Elysia, t } from "elysia";
import type { StateStore } from "../state-store";
import type { SSEBroker } from "../sse";
import { authGuard } from "../middleware/auth";
import { listFleet, setForced, clearForced, removeTerminal, effectiveMinVersion } from "../fleet";
import { SEMVER } from "../semver";

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
        // /min-version.json?terminalId= (Task S4, min-version.ts). O evento
        // SSE carrega a minVersion EFETIVA (max entre global e forçada) —
        // se já houver uma emergência global maior que o valor forçado,
        // mandar só o forçado deixaria o modal obrigatório do PDV mostrar
        // uma versão menor que a que ele já é de fato obrigado a ter. A
        // resposta HTTP continua ecoando o valor forçado que foi pedido.
        const eff = effectiveMinVersion(store, terminalId)!;
        const delivered = broker.sendTo(terminalId, "emergency", { minVersion: eff, version: eff });
        return { status: "ok", terminalId, minVersion, online: delivered > 0 };
      },
      { body: t.Object({ minVersion: t.String({ maxLength: 32 }) }) },
    )
    .post("/:terminalId/logout", ({ params, set }) => {
      const { terminalId } = params;
      if (!store.get().fleet[terminalId]) {
        set.status = 404;
        return { error: "Terminal not found" };
      }
      // Nada é persistido: logout só faz sentido contra uma sessão viva. Se o
      // terminal estiver offline, não há sessão para encerrar (no próximo boot
      // o PDV já sobe deslogado), então não guardamos "logout pendente".
      const delivered = broker.sendTo(terminalId, "logout", { reason: "admin" });
      return { status: "ok", terminalId, online: delivered > 0 };
    })
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
