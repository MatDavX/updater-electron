import { Elysia } from "elysia";
import { parse, stringify } from "yaml";
import type { GitHubCache, CachedRelease } from "../github";
import type { Storage } from "../storage";
import { getActiveVersion } from "../version-control";

const PLATFORM_MANIFESTS: Record<string, string> = {
  win32: "latest.yml",
  darwin: "latest-mac.yml",
  linux: "latest-linux.yml",
};

function buildYaml(
  version: string,
  releaseDate: string,
  filename: string,
  sha512: string,
  size: number,
  notes?: string,
  blockMapSize?: number,
) {
  const fileEntry: Record<string, unknown> = {
    url: `download/${filename}`,
    sha512,
    size,
  };
  if (blockMapSize) {
    fileEntry.blockMapSize = blockMapSize;
  }

  const data: Record<string, unknown> = {
    version,
    files: [fileEntry],
    path: `download/${filename}`,
    sha512,
    releaseDate,
  };
  if (notes) {
    data.releaseNotes = notes;
  }
  return stringify(data);
}

export function updateRoutes(github: GitHubCache, storage: Storage) {
  return new Elysia()
    .get("/latest.yml", async ({ set }) => {
      return handleYaml("win32", github, storage, set);
    })
    .get("/latest-mac.yml", async ({ set }) => {
      return handleYaml("darwin", github, storage, set);
    })
    .get("/latest-linux.yml", async ({ set }) => {
      return handleYaml("linux", github, storage, set);
    });
}

async function handleYaml(
  platform: string,
  github: GitHubCache,
  storage: Storage,
  set: { status?: number | string; headers: Record<string, string | number> },
) {
  const pinnedVersion = getActiveVersion();
  let release: CachedRelease | null;

  if (pinnedVersion) {
    release = await github.getRelease(pinnedVersion);
  } else {
    release = await github.getLatest();
  }

  if (!release) {
    set.status = 404;
    return "No release found";
  }

  const file = await storage.findPlatformFile(platform, release.version);
  if (file) {
    const blockMapSize = await storage.getBlockmapSize(file.filename);

    const yaml = buildYaml(
      release.version,
      release.releaseDate,
      file.filename,
      file.sha512,
      file.size,
      release.notes,
      blockMapSize ?? undefined,
    );

    set.headers["content-type"] = "text/yaml";
    set.headers["cache-control"] = "no-cache";
    return yaml;
  }

  const manifestName = PLATFORM_MANIFESTS[platform];
  const manifestAsset = manifestName ? github.findAsset(release, manifestName) : null;

  if (!manifestAsset) {
    set.status = 404;
    return `No ${platform} binary or ${manifestName} asset found for v${release.version}`;
  }

  try {
    const yaml = rewriteManifestDownloadPaths(await github.fetchAssetText(manifestAsset));

    set.headers["content-type"] = "text/yaml";
    set.headers["cache-control"] = "no-cache";
    return yaml;
  } catch (err: unknown) {
    set.status = 502;
    const message = err instanceof Error ? err.message : "Unknown GitHub asset error";
    return `Failed to load ${manifestName} from GitHub release v${release.version}: ${message}`;
  }
}

function rewriteManifestDownloadPaths(yaml: string): string {
  const data = parse(yaml) as Record<string, unknown>;

  if (Array.isArray(data.files)) {
    data.files = data.files.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const file = entry as Record<string, unknown>;
      if (typeof file.url === "string") {
        file.url = `download/${getAssetFilename(file.url)}`;
      }
      return file;
    });
  }

  if (typeof data.path === "string") {
    data.path = `download/${getAssetFilename(data.path)}`;
  }

  return stringify(data);
}

function getAssetFilename(value: string): string {
  const withoutQuery = value.split("?")[0];
  const decoded = decodeURIComponent(withoutQuery);
  const filename = decoded.split("/").pop();
  return filename || value;
}
