import { Elysia } from "elysia";
import type { GitHubCache } from "../github";
import type { Storage } from "../storage";
import { authGuard } from "../middleware/auth";
import { sseBroker } from "../sse";
import { getActiveVersion, setActiveVersion } from "../version-control";

const ALLOWED_EXTENSIONS = [
  ".exe", ".msi", ".dmg", ".zip", ".AppImage",
  ".deb", ".rpm", ".snap", ".blockmap",
];

export function apiRoutes(github: GitHubCache, storage: Storage) {
  return new Elysia({ prefix: "/api" })
    .use(authGuard())
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
      const expectedSha512 = formData.sha512 as string | undefined;

      if (!file || !(file instanceof File)) {
        set.status = 400;
        return { error: "No file provided" };
      }

      const ext = file.name.substring(file.name.lastIndexOf("."));
      if (!ALLOWED_EXTENSIONS.includes(ext.toLowerCase())) {
        set.status = 400;
        return { error: `Extension ${ext} not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}` };
      }

      const filePath = storage.resolveSafe(file.name);
      if (!filePath) {
        set.status = 400;
        return { error: "Invalid filename" };
      }

      const buffer = await file.arrayBuffer();
      await Bun.write(filePath, buffer);

      const validation = await storage.validateUpload(filePath, expectedSha512);
      if (!validation.valid) {
        await Bun.file(filePath).exists() && (await import("node:fs/promises")).unlink(filePath);
        set.status = 422;
        return {
          error: "SHA512 mismatch",
          expected: expectedSha512,
          actual: validation.sha512,
        };
      }

      storage.clearCache();

      sseBroker.broadcast("upload", {
        filename: file.name,
        size: file.size,
        sha512: validation.sha512,
      });

      return { status: "uploaded", filename: file.name, size: file.size, sha512: validation.sha512 };
    })
    .delete("/files/:filename", async ({ params, set }) => {
      const { filename } = params;

      const deleted = await storage.deleteFile(filename);
      if (!deleted) {
        set.status = 404;
        return { error: "File not found or could not be deleted" };
      }

      sseBroker.broadcast("delete", { filename });
      return { status: "deleted", filename };
    })
    .post("/releases", async ({ body, set }) => {
      const { tag, name, notes } = body as { tag: string; name: string; notes: string };

      if (!tag) {
        set.status = 400;
        return { error: "Tag is required" };
      }

      try {
        const release = await github.createRelease(tag, name || tag, notes || "");
        await github.refresh().catch(() => {});

        const version = tag.replace(/^v/, "");
        sseBroker.broadcast("release", { version, url: release.html_url });

        return { status: "created", url: release.html_url };
      } catch (err: unknown) {
        set.status = 500;
        const message = err instanceof Error ? err.message : "Unknown error";
        return { error: message };
      }
    })
    .get("/releases/history", async () => {
      const releases = await github.getAllReleases();
      const activeVersion = getActiveVersion();
      return {
        activeVersion,
        releases: releases.map((r) => ({
          version: r.version,
          releaseDate: r.releaseDate,
          notes: r.notes.substring(0, 200),
          isActive: activeVersion ? r.version === activeVersion : false,
        })),
      };
    })
    .post("/active-version", async ({ body, set }) => {
      const { version } = body as { version: string };
      if (!version) {
        set.status = 400;
        return { error: "Version is required" };
      }

      const release = await github.getRelease(version);
      if (!release) {
        set.status = 404;
        return { error: `Version ${version} not found in GitHub releases` };
      }

      setActiveVersion(version);
      sseBroker.broadcast("version-change", { version });
      return { status: "ok", activeVersion: version };
    })
    .delete("/active-version", async () => {
      setActiveVersion(null);
      const latest = await github.getLatest();
      sseBroker.broadcast("version-change", { version: latest?.version ?? null, isLatest: true });
      return { status: "ok", activeVersion: null, latestVersion: latest?.version };
    });
}
