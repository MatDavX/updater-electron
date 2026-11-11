import { Elysia, t } from "elysia";
import type { GitHubCache } from "../github";
import type { Storage } from "../storage";
import { authGuard } from "../middleware/auth";
import { sseBroker } from "../sse";
import { getActiveVersion, setActiveVersion } from "../version-control";
import { getMinVersion, setMinVersion } from "../emergency";
import { stateStore } from "../state-store";
import { effectiveMinVersion, hasScopedForce } from "../fleet";
import { SEMVER } from "../semver";

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
    .get(
      "/releases/history",
      async ({ query }) => {
        const releases = await github.getAllReleases();
        const activeVersion = getActiveVersion();

        // Formato legado (dashboard HTML): notas cortadas em 200 caracteres.
        if (query.full !== "1") {
          return {
            activeVersion,
            releases: releases.map((r) => ({
              version: r.version,
              releaseDate: r.releaseDate,
              notes: r.notes.substring(0, 200),
              isActive: activeVersion ? r.version === activeVersion : false,
            })),
          };
        }

        const latestVersion = (await github.getLatest())?.version ?? null;
        const full = await Promise.all(
          releases.map(async (r) => {
            const local = await storage.listFilesForVersion(r.version);
            const hasWindowsInstaller =
              local.some((f) => f.platform === "win32") || github.findPlatformAsset(r, "win32") !== null;
            return {
              version: r.version,
              releaseDate: r.releaseDate,
              notes: r.notes,
              isActive: activeVersion ? r.version === activeVersion : false,
              isLatest: r.version === latestVersion,
              hasWindowsInstaller,
              files: local.map((f) => ({ filename: f.filename, size: f.size, platform: f.platform })),
            };
          }),
        );
        return { activeVersion, latestVersion, releases: full };
      },
      { query: t.Object({ full: t.Optional(t.String({ maxLength: 8 })) }) },
    )
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
      if (!SEMVER.test(minVersion)) {
        set.status = 400;
        return { error: "minVersion must be x.y.z" };
      }
      setMinVersion(minVersion);
      // Avisa os apps abertos na hora (apps fechados pegam via /min-version.json
      // no boot). Terminais com update forçado individual têm minVersion
      // EFETIVA própria (max entre global e forçada) — mandar o valor global
      // puro pra eles regrediria o que já é exigido deles (ver findings #2/#3).
      for (const id of sseBroker.connectedTerminalIds().filter((i) => hasScopedForce(stateStore, i))) {
        const eff = effectiveMinVersion(stateStore, id)!;
        sseBroker.sendTo(id, "emergency", { minVersion: eff, version: eff });
      }
      sseBroker.broadcast("emergency", { minVersion, version: version ?? minVersion }, {
        exclude: (id) => hasScopedForce(stateStore, id),
      });
      return { status: "ok", minVersion };
    })
    .delete("/emergency", () => {
      setMinVersion(null);
      // Avisa apps abertos para fechar o modal — exceto terminais com update
      // forçado próprio (terminal ou empresa), que continuam obrigados, mas à
      // exigência deles: o modal pode estar mostrando a global cancelada (que
      // era maior), então recebem o novo efetivo.
      for (const id of sseBroker.connectedTerminalIds().filter((i) => hasScopedForce(stateStore, i))) {
        const eff = effectiveMinVersion(stateStore, id);
        if (eff) sseBroker.sendTo(id, "emergency", { minVersion: eff, version: eff });
        else sseBroker.sendTo(id, "emergency-clear", {});
      }
      sseBroker.broadcast("emergency-clear", {}, { exclude: (id) => hasScopedForce(stateStore, id) });
      return { status: "ok", minVersion: null };
    });
}
