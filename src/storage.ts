import { readdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

export interface FileMetadata {
  filename: string;
  path: string;
  size: number;
  sha512: string;
  platform: string | null;
}

// Platform-specific file patterns
const PLATFORM_PATTERNS: Record<string, RegExp[]> = {
  win32: [/\.exe$/i, /\.msi$/i, /\.nupkg$/i],
  darwin: [/\.dmg$/i, /\.zip$/i],
  linux: [/\.AppImage$/i, /\.deb$/i, /\.rpm$/i, /\.snap$/i],
};

export class Storage {
  private readonly dir: string;
  private metadataCache = new Map<string, FileMetadata>();

  constructor() {
    this.dir = resolve(Bun.env.RELEASES_DIR || "./releases");
  }

  getDir(): string {
    return this.dir;
  }

  async getFileMetadata(filename: string): Promise<FileMetadata | null> {
    const cached = this.metadataCache.get(filename);
    if (cached) return cached;

    const filePath = join(this.dir, filename);
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return null;

      const sha512 = await this.computeSha512(filePath);
      const metadata: FileMetadata = {
        filename,
        path: filePath,
        size: fileStat.size,
        sha512,
        platform: this.getPlatform(filename),
      };

      this.metadataCache.set(filename, metadata);
      return metadata;
    } catch {
      return null;
    }
  }

  async findPlatformFile(platform: string, version: string): Promise<FileMetadata | null> {
    const patterns = PLATFORM_PATTERNS[platform];
    if (!patterns) return null;

    try {
      const files = await readdir(this.dir);
      // Find files matching the version and platform pattern
      const match = files.find((f) => {
        const hasVersion = f.includes(version);
        const matchesPlatform = patterns.some((p) => p.test(f));
        return hasVersion && matchesPlatform;
      });

      if (!match) return null;
      return this.getFileMetadata(match);
    } catch {
      return null;
    }
  }

  async listFiles(): Promise<string[]> {
    try {
      return await readdir(this.dir);
    } catch {
      return [];
    }
  }

  async getDetailedList(): Promise<FileMetadata[]> {
    const files = await this.listFiles();
    const results: FileMetadata[] = [];
    for (const f of files) {
      const meta = await this.getFileMetadata(f);
      if (meta) results.push(meta);
    }
    return results;
  }

  async deleteFile(filename: string): Promise<boolean> {
    if (filename.includes("..") || filename.includes("/")) return false;
    const filePath = join(this.dir, filename);
    try {
      await unlink(filePath);
      this.metadataCache.delete(filename);
      return true;
    } catch {
      return false;
    }
  }

  getPlatform(filename: string): string | null {
    for (const [platform, patterns] of Object.entries(PLATFORM_PATTERNS)) {
      if (patterns.some((p) => p.test(filename))) return platform;
    }
    return null;
  }

  /** Clear metadata cache (call when new files are added) */
  clearCache(): void {
    this.metadataCache.clear();
  }

  private async computeSha512(filePath: string): Promise<string> {
    const file = Bun.file(filePath);
    const buffer = await file.arrayBuffer();
    const hash = createHash("sha512");
    hash.update(Buffer.from(buffer));
    return hash.digest("base64");
  }
}
