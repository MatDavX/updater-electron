import { Elysia } from "elysia";
import { join } from "node:path";
import type { GitHubCache } from "../github";
import type { Storage } from "../storage";

const ALLOWED_EXTENSIONS = [".exe", ".msi", ".dmg", ".zip", ".AppImage", ".deb", ".rpm", ".snap"];

export function apiRoutes(github: GitHubCache, storage: Storage) {
  return new Elysia({ prefix: "/api" })
    .get("/files", async () => {
      const files = await storage.getDetailedList();
      return files.map((f) => ({
        filename: f.filename,
        size: f.size,
        platform: f.platform,
        sha512: f.sha512,
      }));
    })
    .post("/upload", async ({ body, set }) => {
      const formData = body as Record<string, unknown>;
      const file = formData.file;

      if (!file || !(file instanceof File)) {
        set.status = 400;
        return { error: "No file provided" };
      }

      const ext = file.name.substring(file.name.lastIndexOf("."));
      if (!ALLOWED_EXTENSIONS.includes(ext.toLowerCase())) {
        set.status = 400;
        return { error: `Extension ${ext} not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}` };
      }

      // Prevent path traversal
      if (file.name.includes("..") || file.name.includes("/")) {
        set.status = 400;
        return { error: "Invalid filename" };
      }

      const filePath = join(storage.getDir(), file.name);
      const buffer = await file.arrayBuffer();
      await Bun.write(filePath, buffer);
      storage.clearCache();

      return { status: "uploaded", filename: file.name, size: file.size };
    })
    .delete("/files/:filename", async ({ params, set }) => {
      const { filename } = params;

      const deleted = await storage.deleteFile(filename);
      if (!deleted) {
        set.status = 404;
        return { error: "File not found or could not be deleted" };
      }

      return { status: "deleted", filename };
    })
    .post("/releases", async ({ body, set }) => {
      const { tag, name, notes } = body as { tag: string; name: string; notes: string };

      if (!tag) {
        set.status = 400;
        return { error: "Tag is required" };
      }

      try {
        const release = await github.createRelease(
          tag,
          name || tag,
          notes || "",
        );
        // Refresh cache after creating release
        await github.refresh().catch(() => {});
        return { status: "created", url: release.html_url };
      } catch (err: unknown) {
        set.status = 500;
        const message = err instanceof Error ? err.message : "Unknown error";
        return { error: message };
      }
    });
}
