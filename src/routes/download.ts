import { Elysia } from "elysia";
import { resolve } from "node:path";
import type { GitHubCache } from "../github";
import type { Storage } from "../storage";

export function downloadRoutes(github: GitHubCache, storage: Storage) {
  return new Elysia()
    .get("/download/:filename", async ({ params, set }) => {
      const { filename } = params;

      const filePath = storage.resolveSafe(filename);
      if (!filePath) {
        set.status = 400;
        return "Invalid filename";
      }

      const file = Bun.file(filePath);

      if (!(await file.exists())) {
        set.status = 404;
        return "File not found";
      }

      set.headers["content-type"] = "application/octet-stream";
      set.headers["content-disposition"] = `attachment; filename="${filename}"`;
      set.headers["content-length"] = String(file.size);

      return file;
    })
    .get("/download/latest/:platform", async ({ params, set }) => {
      const { platform } = params;
      const release = await github.getLatest();

      if (!release) {
        set.status = 404;
        return "No release found";
      }

      const file = await storage.findPlatformFile(platform, release.version);
      if (!file) {
        set.status = 404;
        return `No ${platform} binary found for v${release.version}`;
      }

      set.redirect = `/download/${file.filename}`;
    });
}
