import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "storage-"));
  process.env.RELEASES_DIR = dir;
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); delete process.env.RELEASES_DIR; });

async function load() {
  // Storage lê RELEASES_DIR no construtor via Bun.env — sincronizado com process.env.
  const { Storage } = await import("./storage");
  return new Storage();
}

describe("Storage.findPlatformFile", () => {
  it("matches the exact version, not a prefix (1.2.1 vs 1.2.10)", async () => {
    await Bun.write(join(dir, "Papaya-PDV-1.2.10-Setup.exe"), "ten");
    await Bun.write(join(dir, "Papaya-PDV-1.2.1-Setup.exe"), "one");
    const s = await load();
    expect((await s.findPlatformFile("win32", "1.2.1"))?.filename).toBe("Papaya-PDV-1.2.1-Setup.exe");
    expect((await s.findPlatformFile("win32", "1.2.10"))?.filename).toBe("Papaya-PDV-1.2.10-Setup.exe");
  });

  it("ignores blockmaps when looking for the binary", async () => {
    await Bun.write(join(dir, "Papaya-PDV-1.2.1-Setup.exe.blockmap"), "bm");
    await Bun.write(join(dir, "Papaya-PDV-1.2.1-Setup.exe"), "bin");
    const s = await load();
    expect((await s.findPlatformFile("win32", "1.2.1"))?.filename).toBe("Papaya-PDV-1.2.1-Setup.exe");
  });
});

describe("Storage sha512", () => {
  it("computes base64 sha512 equal to node crypto over the whole file", async () => {
    const content = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    await Bun.write(join(dir, "Papaya-PDV-9.9.9-Setup.exe"), content);
    const s = await load();
    const meta = await s.getFileMetadata("Papaya-PDV-9.9.9-Setup.exe");
    expect(meta?.sha512).toBe(createHash("sha512").update(content).digest("base64"));
    expect(meta?.size).toBe(content.length);
  });
});
