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

async function appWithGithubProxy(fetchAssetImpl: (extraHeaders: Record<string, string>) => Response) {
  const { Storage } = await import("../storage");
  const { downloadRoutes } = await import("./download");
  const asset = { name: "Papaya-PDV-1.0.0-Setup.exe", url: "https://github.example/asset", size: 10 };
  const release = { version: "1.0.0", assets: [asset] };
  const calls: Record<string, string>[] = [];
  const github = {
    findAsset: () => asset,
    getLatest: async () => release,
    getRelease: async () => release,
    fetchAsset: async (_asset: unknown, extraHeaders: Record<string, string> = {}) => {
      calls.push(extraHeaders);
      return fetchAssetImpl(extraHeaders);
    },
    findPlatformAsset: () => null,
  } as never;
  const app = new Elysia().use(downloadRoutes(github, new Storage()));
  return { app, calls };
}

describe("GET /download/:filename GitHub proxy Range", () => {
  it("forwards the Range header to fetchAsset and echoes upstream 206", async () => {
    const { app, calls } = await appWithGithubProxy(() =>
      new Response("2345", {
        status: 206,
        headers: { "content-range": "bytes 2-5/10", "content-length": "4" },
      })
    );
    const res = await app.handle(
      new Request("http://localhost/download/Papaya-PDV-1.0.0-Setup.exe", { headers: { range: "bytes=2-5" } })
    );
    expect(calls).toEqual([{ Range: "bytes=2-5" }]);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(res.headers.get("content-length")).toBe("4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  it("forwards no extra headers and echoes upstream 200 without Range", async () => {
    const { app, calls } = await appWithGithubProxy(() =>
      new Response("0123456789", { status: 200, headers: { "content-length": "10" } })
    );
    const res = await app.handle(new Request("http://localhost/download/Papaya-PDV-1.0.0-Setup.exe"));
    expect(calls).toEqual([{}]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("10");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  it("passes through an upstream 416", async () => {
    const { app } = await appWithGithubProxy(() =>
      new Response(null, { status: 416, headers: { "content-range": "bytes */10" } })
    );
    const res = await app.handle(
      new Request("http://localhost/download/Papaya-PDV-1.0.0-Setup.exe", { headers: { range: "bytes=50-60" } })
    );
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */10");
  });
});
