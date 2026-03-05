import { Elysia } from "elysia";
import { join } from "node:path";
import type { GitHubCache } from "../github";
import type { Storage } from "../storage";

export function downloadRoutes(github: GitHubCache, storage: Storage) {
  return new Elysia()
    .get("/download/:filename", async ({ params, set }) => {
      const { filename } = params;

      // Prevent path traversal
      if (filename.includes("..") || filename.includes("/")) {
        set.status = 400;
        return "Invalid filename";
      }

      const filePath = join(storage.getDir(), filename);
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

      // Redirect to the actual download route
      set.redirect = `/download/${file.filename}`;
    });
}
