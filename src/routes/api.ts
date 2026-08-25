import { Elysia, t } from "elysia";
import type { GitHubCache } from "../github";
import type { Storage } from "../storage";
import { authGuard } from "../middleware/auth";
import { sseBroker } from "../sse";
import { getActiveVersion, setActiveVersion } from "../version-control";
import { getMinVersion, setMinVersion } from "../emergency";
import { stateStore } from "../state-store";

const ALLOWED_EXTENSIONS = [
  ".exe", ".msi", ".dmg", ".zip", ".AppImage",
  ".deb", ".rpm", ".snap", ".blockmap", ".nupkg",
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
      const file = body.file;
      const expectedSha512 = body.sha512;

      if (!file) {
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

      const validation = await storage.validateUpload(filePath, expectedSha512 || undefined);
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
    }, {
      body: t.Object({
        file: t.File({ maxSize: "500m" }),
        sha512: t.Optional(t.String()),
      }),
    })
    .put("/upload/:filename", async ({ params, body, set }) => {
      const { filename } = params;

      const ext = filename.substring(filename.lastIndexOf("."));
      if (!ALLOWED_EXTENSIONS.includes(ext.toLowerCase())) {
        set.status = 400;
        return { error: `Extension ${ext} not allowed` };
      }

      const filePath = storage.resolveSafe(filename);
      if (!filePath) {
        set.status = 400;
        return { error: "Invalid filename" };
      }

      const buffer = body as ArrayBuffer;
      await Bun.write(filePath, buffer);

      const validation = await storage.validateUpload(filePath);
      storage.clearCache();

      sseBroker.broadcast("upload", {
        filename,
        size: buffer.byteLength,
        sha512: validation.sha512,
      });

      return { status: "uploaded", filename, size: buffer.byteLength, sha512: validation.sha512 };
    }, {
      parse: "arrayBuffer",
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
        // `refresh()` só atualiza o cache do "latest" (usado por /latest-version
        // e /download/latest/*). O dropdown de versões (releases/history) lê
        // `allReleasesCache`, que tem TTL próprio — sem isto, o release novo só
        // aparece lá depois de até `CACHE_TTL` ms.
        github.invalidateAllReleases();
        await github.getAllReleases().catch(() => {});

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
    })
    // ── Emergency / atualização obrigatória ──────────────────────────────
    .get("/emergency", () => ({ minVersion: getMinVersion() }))
    .post("/emergency", async ({ body, set }) => {
      const { minVersion, version } = body as { minVersion: string; version?: string };
      if (!minVersion) {
        set.status = 400;
        return { error: "minVersion is required" };
      }
      setMinVersion(minVersion);
      // Avisa os apps abertos na hora (apps fechados pegam via /min-version.json no boot).
      sseBroker.broadcast("emergency", { minVersion, version: version ?? minVersion });
      return { status: "ok", minVersion };
    })
    .delete("/emergency", () => {
      setMinVersion(null);
      // Avisa apps abertos para fechar o modal — exceto terminais com update
      // forçado individual, que continuam obrigados.
      const forced = stateStore.get().forced;
      sseBroker.broadcast("emergency-clear", {}, { exclude: (id) => id !== null && !!forced[id] });
      return { status: "ok", minVersion: null };
    });
}
