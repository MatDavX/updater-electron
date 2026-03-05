import { Elysia } from "elysia";
import { stringify } from "yaml";
import type { GitHubCache } from "../github";
import type { Storage } from "../storage";

// electron-updater expects these exact file patterns per platform
const PLATFORM_CONFIG: Record<string, { yamlFile: string; extensions: string[] }> = {
  win32: { yamlFile: "latest.yml", extensions: [".exe"] },
  darwin: { yamlFile: "latest-mac.yml", extensions: [".zip", ".dmg"] },
  linux: { yamlFile: "latest-linux.yml", extensions: [".AppImage", ".deb", ".rpm"] },
};

function buildYaml(
  version: string,
  releaseDate: string,
  filename: string,
  sha512: string,
  size: number,
  notes?: string,
) {
  const data: Record<string, unknown> = {
    version,
    files: [{ url: filename, sha512, size }],
    path: filename,
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

  const yaml = buildYaml(
    release.version,
    release.releaseDate,
    file.filename,
    file.sha512,
    file.size,
    release.notes,
  );

  set.headers["content-type"] = "text/yaml";
  set.headers["cache-control"] = "no-cache";
  return yaml;
}
