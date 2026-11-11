import { Elysia, t } from "elysia";
import type { StateStore } from "../state-store";
import type { SSEBroker } from "../sse";
import { authGuard } from "../middleware/auth";
import {
  MAX_FORCED_COMPANIES,
  setCompanyForced,
  clearCompanyForced,
  terminalsOfCompany,
  effectiveMinVersion,
} from "../fleet";
import { SEMVER } from "../semver";

// Rotas ADMIN (token) de update forçado POR EMPRESA. O forçado fica gravado
// mesmo sem terminal conhecido: vale quando o primeiro terminal da empresa
// aparecer. A exigência efetiva de cada terminal é sempre o maior valor entre
// global, individual e empresa (ver `effectiveMinVersion`).
export function companyAdminRoutes(store: StateStore, broker: SSEBroker) {
  const companyParams = t.Object({ companyId: t.String({ minLength: 1, maxLength: 200 }) });

  return new Elysia({ prefix: "/api/companies" })
    .use(authGuard())
    .get("/forced", () => {
      const s = store.get();
      return {
        companies: Object.entries(s.forcedCompanies).map(([companyId, entry]) => {
          const ids = terminalsOfCompany(store, companyId);
          return {
            companyId,
            minVersion: entry.minVersion,
            createdAt: entry.createdAt,
            terminals: ids.length,
            online: ids.filter((id) => broker.isConnected(id)).length,
          };
        }),
      };
    })
    .post(
      "/:companyId/force",
      ({ params, body, set }) => {
        const { companyId } = params;
        const { minVersion } = body;
        if (!SEMVER.test(minVersion)) {
          set.status = 400;
          return { error: "minVersion must be x.y.z" };
        }
        const forced = store.get().forcedCompanies;
        if (!Object.hasOwn(forced, companyId) && Object.keys(forced).length >= MAX_FORCED_COMPANIES) {
          set.status = 409;
          return { error: `limite de ${MAX_FORCED_COMPANIES} empresas com exigência atingido` };
        }
        setCompanyForced(store, companyId, minVersion);
        const ids = terminalsOfCompany(store, companyId);
        let online = 0;
        for (const id of ids) {
          const eff = effectiveMinVersion(store, id)!;
          if (broker.sendTo(id, "emergency", { minVersion: eff, version: eff }) > 0) online++;
        }
        return { status: "ok", companyId, minVersion, terminals: ids.length, online };
      },
      { params: companyParams, body: t.Object({ minVersion: t.String({ maxLength: 32 }) }) },
    )
    .delete(
      "/:companyId/force",
      ({ params }) => {
        const { companyId } = params;
        clearCompanyForced(store, companyId);
        for (const id of terminalsOfCompany(store, companyId)) {
          // Se ainda houver exigência global/individual, o terminal continua
          // obrigado: manda o efetivo em vez de dispensar o modal.
          const eff = effectiveMinVersion(store, id);
          if (eff === null) broker.sendTo(id, "emergency-clear", {});
          else broker.sendTo(id, "emergency", { minVersion: eff, version: eff });
        }
        return { status: "ok", companyId };
      },
      { params: companyParams },
    );
}
