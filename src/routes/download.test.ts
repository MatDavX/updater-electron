import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "dl-")); process.env.RELEASES_DIR = dir; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); delete process.env.RELEASES_DIR; });

async function appWithLocalFile() {
  await Bun.write(join(dir, "Papaya-PDV-1.0.0-Setup.exe"), "0123456789");
  const { Storage } = await import("../storage");
  const { downloadRoutes } = await import("./download");
  const github = { findAsset: () => null, getLatest: async () => null, getRelease: async () => null, fetchAsset: async () => { throw new Error("no"); }, findPlatformAsset: () => null } as never;
  return new Elysia().use(downloadRoutes(github, new Storage()));
}

describe("GET /download/:filename Range", () => {
  it("serves 206 with the requested slice for local files", async () => {
    const app = await appWithLocalFile();
    const res = await app.handle(new Request("http://localhost/download/Papaya-PDV-1.0.0-Setup.exe", { headers: { range: "bytes=2-5" } }));
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await res.text()).toBe("2345");
  });

  it("serves open-ended ranges (bytes=7-)", async () => {
    const app = await appWithLocalFile();
    const res = await app.handle(new Request("http://localhost/download/Papaya-PDV-1.0.0-Setup.exe", { headers: { range: "bytes=7-" } }));
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("789");
  });

  it("returns 416 for unsatisfiable ranges", async () => {
    const app = await appWithLocalFile();
    const res = await app.handle(new Request("http://localhost/download/Papaya-PDV-1.0.0-Setup.exe", { headers: { range: "bytes=50-60" } }));
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */10");
  });

  it("serves 200 full file without Range (with accept-ranges advertised)", async () => {
    const app = await appWithLocalFile();
    const res = await app.handle(new Request("http://localhost/download/Papaya-PDV-1.0.0-Setup.exe"));
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("10");
  });
});
