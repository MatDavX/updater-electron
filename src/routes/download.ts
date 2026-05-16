import { Elysia } from "elysia";
import type { GitHubCache } from "../github";
import type { Storage } from "../storage";
import { getActiveVersion } from "../version-control";

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

      if (await file.exists()) {
        set.headers["content-type"] = "application/octet-stream";
        set.headers["content-disposition"] = `attachment; filename="${filename}"`;
        set.headers["content-length"] = String(file.size);

        return file;
      }

      const release = await getCurrentRelease(github);
      const asset = release ? github.findAsset(release, filename) : null;
      if (!asset) {
        set.status = 404;
        return "File not found";
      }

      try {
        const response = await github.fetchAsset(asset);
        return new Response(response.body, {
          headers: {
            "content-type": response.headers.get("content-type") ?? "application/octet-stream",
            "content-disposition": `attachment; filename="${filename}"`,
            "content-length": response.headers.get("content-length") ?? String(asset.size),
          },
        });
      } catch (err: unknown) {
        set.status = 502;
        const message = err instanceof Error ? err.message : "Unknown GitHub asset error";
        return `Failed to download ${filename} from GitHub release: ${message}`;
      }
    })
    .get("/download/latest/:platform", async ({ params, set }) => {
      const { platform } = params;
      const release = await getCurrentRelease(github);

      if (!release) {
        set.status = 404;
        return "No release found";
      }

      const file = await storage.findPlatformFile(platform, release.version);
      if (file) {
        return redirectToDownload(file.filename);
      }

      const asset = github.findPlatformAsset(release, platform);
      if (!asset) {
        set.status = 404;
        return `No ${platform} binary found for v${release.version}`;
      }

      return redirectToDownload(asset.name);
    });
}

function redirectToDownload(filename: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: `/download/${encodeURIComponent(filename)}`,
    },
  });
}

async function getCurrentRelease(github: GitHubCache) {
  const pinnedVersion = getActiveVersion();
  if (pinnedVersion) {
    return github.getRelease(pinnedVersion);
  }
  return github.getLatest();
}
