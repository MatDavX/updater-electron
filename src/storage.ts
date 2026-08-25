import { readdir, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

export interface FileMetadata {
  filename: string;
  path: string;
  size: number;
  sha512: string;
  platform: string | null;
}

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

  resolveSafe(filename: string): string | null {
    if (filename.includes("..") || filename.includes("\\")) return null;
    const resolved = resolve(this.dir, filename);
    if (!resolved.startsWith(this.dir)) return null;
    return resolved;
  }

  async getFileMetadata(filename: string): Promise<FileMetadata | null> {
    const cached = this.metadataCache.get(filename);
    if (cached) return cached;

    const filePath = this.resolveSafe(filename);
    if (!filePath) return null;

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

    // Versão exata: precedida por separador (-, _, espaço) e seguida por
    // separador ou ponto de extensão — "1.2.1" não pode casar "1.2.10".
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const versionRe = new RegExp(`[-_ ]${escaped}(?=[-_ .])`);

    try {
      const files = await readdir(this.dir);
      const match = files.find((f) => {
        if (/\.blockmap$/i.test(f)) return false;
        return versionRe.test(f) && patterns.some((p) => p.test(f));
      });

      if (!match) return null;
      return this.getFileMetadata(match);
    } catch {
      return null;
    }
  }

  async getBlockmapSize(binaryFilename: string): Promise<number | null> {
    const blockmapFilename = `${binaryFilename}.blockmap`;
    const filePath = this.resolveSafe(blockmapFilename);
    if (!filePath) return null;

    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return null;
      return fileStat.size;
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
    const filePath = this.resolveSafe(filename);
    if (!filePath) return false;

    try {
      await unlink(filePath);
      this.metadataCache.delete(filename);
      return true;
    } catch {
      return false;
    }
  }

  async validateUpload(filePath: string, expectedSha512?: string): Promise<{ valid: boolean; sha512: string }> {
    const sha512 = await this.computeSha512(filePath);
    if (expectedSha512 && sha512 !== expectedSha512) {
      return { valid: false, sha512 };
    }
    return { valid: true, sha512 };
  }

  getPlatform(filename: string): string | null {
    for (const [platform, patterns] of Object.entries(PLATFORM_PATTERNS)) {
      if (patterns.some((p) => p.test(filename))) return platform;
    }
    return null;
  }

  clearCache(): void {
    this.metadataCache.clear();
  }

  private async computeSha512(filePath: string): Promise<string> {
    // Stream: instaladores têm ~100 MB; carregar em arrayBuffer() dobrava a
    // RAM por arquivo e bloqueava o event loop.
    const hash = createHash("sha512");
    const stream = Bun.file(filePath).stream();
    for await (const chunk of stream) {
      hash.update(chunk);
    }
    return hash.digest("base64");
  }
}
