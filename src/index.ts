import { Elysia } from "elysia";
import { GitHubCache } from "./github";
import { Storage } from "./storage";
import { updateRoutes } from "./routes/update";
import { downloadRoutes } from "./routes/download";
import { dashboardRoutes } from "./routes/dashboard";
import { apiRoutes } from "./routes/api";
import { eventRoutes } from "./routes/events";
import { minVersionRoutes } from "./routes/min-version";
import { fleetPublicRoutes } from "./routes/fleet-public";
import { fleetAdminRoutes } from "./routes/fleet-admin";
import { versionRoutes } from "./routes/version";
import { rateLimiter } from "./middleware/rate-limit";
import { authGuard } from "./middleware/auth";
import { sseBroker } from "./sse";
import { stateStore } from "./state-store";

const github = new GitHubCache();
const storage = new Storage();

await stateStore.load();
console.log(`[state] carregado: minVersion=${stateStore.get().minVersion ?? "-"} activeVersion=${stateStore.get().activeVersion ?? "-"} fleet=${Object.keys(stateStore.get().fleet).length}`);

await github.refresh().catch((err) => {
  console.error("Warning: Initial GitHub fetch failed:", err.message);
});

const port = Number(Bun.env.PORT) || 3000;

const refreshRoutes = new Elysia()
  .use(authGuard())
  .post("/refresh", async ({ set }) => {
    try {
      storage.clearCache();
      await github.refresh();
      const release = await github.getLatest();
      sseBroker.broadcast("refresh", { version: release?.version });
      return { status: "refreshed", version: release?.version };
    } catch (err: unknown) {
      set.status = 500;
      const message = err instanceof Error ? err.message : "Unknown error";
      return { status: "error", message };
    }
  });

const app = new Elysia()
  .use(rateLimiter())
  .use(dashboardRoutes(github, storage))
  .use(eventRoutes(stateStore))
  .use(minVersionRoutes(stateStore))
  .use(fleetPublicRoutes(stateStore))
  .use(fleetAdminRoutes(stateStore, sseBroker))
  .use(versionRoutes(github, storage))
  .use(updateRoutes(github, storage))
  .use(downloadRoutes(github, storage))
  .use(apiRoutes(github, storage))
  .use(refreshRoutes)
  .get("/health", async () => {
    const release = await github.getLatest();
    const files = await storage.listFiles();
    return {
      status: "ok",
      latestVersion: release?.version ?? null,
      releaseDate: release?.releaseDate ?? null,
      localFiles: files.length,
      sseClients: sseBroker.count,
    };
  })
  .listen({ port, maxRequestBodySize: 1024 * 1024 * 512 });

console.log(`Update server running at http://${app.server?.hostname}:${app.server?.port}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await stateStore.flush();
    process.exit(0);
  });
}
