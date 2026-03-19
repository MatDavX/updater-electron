import { Elysia } from "elysia";
import { stringify } from "yaml";
import type { GitHubCache, CachedRelease } from "../github";
import type { Storage } from "../storage";
import { getActiveVersion } from "../version-control";

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
  set: { status?: number; headers: Record<string, string> },
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
  if (!file) {
    set.status = 404;
    return `No ${platform} binary found for v${release.version}`;
  }

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
