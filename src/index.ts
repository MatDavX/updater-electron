import { Elysia } from "elysia";
import { GitHubCache } from "./github";
import { Storage } from "./storage";
import { updateRoutes } from "./routes/update";
import { downloadRoutes } from "./routes/download";

const github = new GitHubCache();
const storage = new Storage();

// Fetch initial release on startup
await github.refresh().catch((err) => {
  console.error("Warning: Initial GitHub fetch failed:", err.message);
});

const port = Number(Bun.env.PORT) || 3000;

const app = new Elysia()
  .use(updateRoutes(github, storage))
  .use(downloadRoutes(github, storage))
  .get("/health", async () => {
    const release = await github.getLatest();
    const files = await storage.listFiles();
    return {
      status: "ok",
      latestVersion: release?.version ?? null,
      releaseDate: release?.releaseDate ?? null,
      localFiles: files.length,
    };
  })
  .post("/refresh", async ({ set }) => {
    try {
      storage.clearCache();
      await github.refresh();
      const release = await github.getLatest();
      return { status: "refreshed", version: release?.version };
    } catch (err: unknown) {
      set.status = 500;
      const message = err instanceof Error ? err.message : "Unknown error";
      return { status: "error", message };
    }
  })
  .listen(port);

console.log(`🚀 Update server running at http://${app.server?.hostname}:${app.server?.port}`);
