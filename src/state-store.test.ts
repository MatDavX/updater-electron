import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, defaultState } from "./state-store";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "state-store-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("StateStore", () => {
  it("starts with default state when file does not exist", async () => {
    const store = new StateStore(join(dir, "state.json"));
    await store.load();
    expect(store.get()).toEqual(defaultState());
  });

  it("persists updates and reloads them", async () => {
    const path = join(dir, "state.json");
    const store = new StateStore(path, { debounceMs: 0 });
    await store.load();
    store.update((s) => { s.minVersion = "1.3.0"; s.forced["t1"] = { minVersion: "1.4.0", createdAt: "2026-01-01T00:00:00.000Z" }; });
    await store.flush();

    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.minVersion).toBe("1.3.0");

    const again = new StateStore(path);
    await again.load();
    expect(again.get().minVersion).toBe("1.3.0");
    expect(again.get().forced.t1.minVersion).toBe("1.4.0");
  });

  it("tolerates a corrupt file (falls back to defaults, keeps a .corrupt backup)", async () => {
    const path = join(dir, "state.json");
    await Bun.write(path, "{ not json");
    const store = new StateStore(path);
    await store.load();
    expect(store.get()).toEqual(defaultState());
    expect(await Bun.file(path + ".corrupt").exists()).toBe(true);
  });

  it("fills missing keys from defaults (forward-compatible schema)", async () => {
    const path = join(dir, "state.json");
    await Bun.write(path, JSON.stringify({ minVersion: "1.0.0" }));
    const store = new StateStore(path);
    await store.load();
    expect(store.get().activeVersion).toBeNull();
    expect(store.get().forced).toEqual({});
    expect(store.get().fleet).toEqual({});
  });

  it("debounces writes: many updates → one flush", async () => {
    const path = join(dir, "state.json");
    const store = new StateStore(path, { debounceMs: 20 });
    await store.load();
    for (let i = 0; i < 10; i++) store.update((s) => { s.minVersion = `1.0.${i}`; });
    expect(await Bun.file(path).exists()).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(JSON.parse(await readFile(path, "utf8")).minVersion).toBe("1.0.9");
  });
});
