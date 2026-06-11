import { Elysia } from "elysia";
import type { GitHubCache } from "../github";
import type { Storage } from "../storage";
import { getActiveVersion } from "../version-control";

// Endpoint publico: retorna a versao mais recente + link de download do
// instalador Windows. Consumido pelo papaya-web (botao "Baixar app").
export function versionRoutes(github: GitHubCache, storage: Storage) {
  return new Elysia().get("/latest-version", async ({ request, set }) => {
    const pinnedVersion = getActiveVersion();
    const release = pinnedVersion
      ? await github.getRelease(pinnedVersion)
      : await github.getLatest();

    if (!release) {
      set.status = 404;
      return { error: "No release found" };
    }

    // Prefere binario armazenado localmente; senao usa o asset do GitHub.
    const localFile = await storage.findPlatformFile("win32", release.version);
    const asset = localFile ? null : github.findPlatformAsset(release, "win32");
    const filename = localFile?.filename ?? asset?.name ?? null;

    if (!filename) {
      set.status = 404;
      return { error: `No Windows installer found for v${release.version}` };
    }

    // O download passa pelo proprio servidor (/download/:filename), que ja
    // injeta o token do GitHub para repos privados.
    const origin = new URL(request.url).origin;
    const downloadUrl = `${origin}/download/${encodeURIComponent(filename)}`;

    set.headers["cache-control"] = "public, max-age=300";
    return {
      version: release.version,
      releaseDate: release.releaseDate,
      platform: "win32",
      filename,
      downloadUrl,
    };
  });
}
