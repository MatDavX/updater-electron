import { Elysia } from "elysia";
import type { GitHubCache } from "../github";
import type { Storage } from "../storage";
import { getActiveVersion } from "../version-control";

/** Parse de "bytes=a-b" | "bytes=a-" | "bytes=-n". Retorna null se ausente/inválido; {start:-1} se insatisfazível. */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  let start: number;
  let end: number;
  if (a === "" && b === "") return null;
  if (a === "") {
    // sufixo: últimos n bytes
    const n = parseInt(b, 10);
    if (n === 0) return { start: -1, end: -1 };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(a, 10);
    end = b === "" ? size - 1 : Math.min(parseInt(b, 10), size - 1);
  }
  if (start > end || start >= size) return { start: -1, end: -1 };
  return { start, end };
}

export function downloadRoutes(github: GitHubCache, storage: Storage) {
  return new Elysia()
    .get("/download/:filename", async ({ params, set, request }) => {
      const { filename } = params;

      const filePath = storage.resolveSafe(filename);
      if (!filePath) {
        set.status = 400;
        return "Invalid filename";
      }

      const file = Bun.file(filePath);

      if (await file.exists()) {
        const size = file.size;
        const range = parseRange(request.headers.get("range"), size);

        if (range && range.start === -1) {
          return new Response(null, {
            status: 416,
            headers: { "content-range": `bytes */${size}`, "accept-ranges": "bytes" },
          });
        }

        if (range) {
          const { start, end } = range;
          return new Response(file.slice(start, end + 1), {
            status: 206,
            headers: {
              "content-type": "application/octet-stream",
              "content-disposition": `attachment; filename="${filename}"`,
              "content-length": String(end - start + 1),
              "content-range": `bytes ${start}-${end}/${size}`,
              "accept-ranges": "bytes",
            },
          });
        }

        set.headers["content-type"] = "application/octet-stream";
        set.headers["content-disposition"] = `attachment; filename="${filename}"`;
        set.headers["content-length"] = String(size);
        set.headers["accept-ranges"] = "bytes";
        return file;
      }

      const release = await getCurrentRelease(github);
      const asset = release ? github.findAsset(release, filename) : null;
      if (!asset) {
        set.status = 404;
        return "File not found";
      }

      try {
        const rangeHeader = request.headers.get("range");
        const response = await github.fetchAsset(asset, rangeHeader ? { Range: rangeHeader } : {});
        const headers: Record<string, string> = {
          "content-type": response.headers.get("content-type") ?? "application/octet-stream",
          "content-disposition": `attachment; filename="${filename}"`,
          "accept-ranges": "bytes",
        };
        const len = response.headers.get("content-length");
        if (len) headers["content-length"] = len;
        const cr = response.headers.get("content-range");
        if (cr) headers["content-range"] = cr;
        return new Response(response.body, { status: response.status, headers });
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
