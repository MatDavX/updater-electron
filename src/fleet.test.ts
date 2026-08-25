import { describe, it, expect } from "bun:test";
import { StateStore } from "./state-store";
import {
  upsertHeartbeat, touchSeen, removeTerminal, listFleet,
  setForced, clearForced, effectiveMinVersion, compareVersions,
} from "./fleet";

function mem(): StateStore {
  // Store sem disco: debounce enorme e nunca chamamos flush.
  return new StateStore("/dev/null/never.json", { debounceMs: 1e9 });
}

const hb = {
  terminalId: "t1", terminalName: "CAIXA-01", version: "1.2.0", platform: "win32", arch: "x64",
  userId: "u1", userName: "Ana", userEmail: "ana@loja.com", companyId: "c1",
};

describe("upsertHeartbeat", () => {
  it("creates a record with firstSeen=lastSeen on first heartbeat", () => {
    const s = mem();
    const now = new Date("2026-08-25T10:00:00.000Z");
    const rec = upsertHeartbeat(s, hb, now);
    expect(rec.firstSeen).toBe(now.toISOString());
    expect(rec.lastSeen).toBe(now.toISOString());
    expect(s.get().fleet.t1.userEmail).toBe("ana@loja.com");
  });

  it("updates version/user/lastSeen but keeps firstSeen", () => {
    const s = mem();
    upsertHeartbeat(s, hb, new Date("2026-08-25T10:00:00.000Z"));
    const later = new Date("2026-08-25T11:00:00.000Z");
    const rec = upsertHeartbeat(s, { ...hb, version: "1.3.0", userEmail: "bia@loja.com" }, later);
    expect(rec.firstSeen).toBe("2026-08-25T10:00:00.000Z");
    expect(rec.lastSeen).toBe(later.toISOString());
    expect(rec.version).toBe("1.3.0");
    expect(rec.userEmail).toBe("bia@loja.com");
  });

  it("logged-out heartbeat clears user fields", () => {
    const s = mem();
    upsertHeartbeat(s, hb);
    const rec = upsertHeartbeat(s, { terminalId: "t1", terminalName: "CAIXA-01", version: "1.2.0", platform: "win32", arch: "x64" });
    expect(rec.userEmail).toBeUndefined();
    expect(rec.userId).toBeUndefined();
  });
});

describe("touchSeen / removeTerminal", () => {
  it("touchSeen creates a minimal record for unknown terminals (SSE before heartbeat)", () => {
    const s = mem();
    touchSeen(s, "t9", "1.0.0", new Date("2026-08-25T10:00:00.000Z"));
    expect(s.get().fleet.t9).toMatchObject({ terminalId: "t9", terminalName: "t9", version: "1.0.0", platform: "unknown", arch: "unknown" });
  });

  it("touchSeen only bumps lastSeen/version on known terminals", () => {
    const s = mem();
    upsertHeartbeat(s, hb, new Date("2026-08-25T10:00:00.000Z"));
    touchSeen(s, "t1", undefined, new Date("2026-08-25T12:00:00.000Z"));
    expect(s.get().fleet.t1.lastSeen).toBe("2026-08-25T12:00:00.000Z");
    expect(s.get().fleet.t1.userEmail).toBe("ana@loja.com");
  });

  it("removeTerminal drops record and forced entry", () => {
    const s = mem();
    upsertHeartbeat(s, hb);
    setForced(s, "t1", "1.9.0");
    expect(removeTerminal(s, "t1")).toBe(true);
    expect(s.get().fleet.t1).toBeUndefined();
    expect(s.get().forced.t1).toBeUndefined();
    expect(removeTerminal(s, "t1")).toBe(false);
  });
});

describe("forced / effectiveMinVersion", () => {
  it("effectiveMinVersion is max(global, forced)", () => {
    const s = mem();
    expect(effectiveMinVersion(s, "t1")).toBeNull();
    s.update((x) => { x.minVersion = "1.3.0"; });
    expect(effectiveMinVersion(s, "t1")).toBe("1.3.0");
    setForced(s, "t1", "1.5.0");
    expect(effectiveMinVersion(s, "t1")).toBe("1.5.0");
    expect(effectiveMinVersion(s, "t2")).toBe("1.3.0");
    expect(effectiveMinVersion(s, null)).toBe("1.3.0");
    s.update((x) => { x.minVersion = "2.0.0"; });
    expect(effectiveMinVersion(s, "t1")).toBe("2.0.0");
  });

  it("clearForced returns whether something was removed", () => {
    const s = mem();
    setForced(s, "t1", "1.5.0");
    expect(clearForced(s, "t1")).toBe(true);
    expect(clearForced(s, "t1")).toBe(false);
  });

  it("compareVersions handles 1.2.10 > 1.2.9", () => {
    expect(compareVersions("1.2.10", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.9", "1.2.10")).toBeLessThan(0);
    expect(compareVersions("1.2.0", "1.2")).toBe(0);
  });
});

describe("listFleet", () => {
  it("returns records sorted by lastSeen desc with online + forcedMinVersion", () => {
    const s = mem();
    upsertHeartbeat(s, hb, new Date("2026-08-25T10:00:00.000Z"));
    upsertHeartbeat(s, { ...hb, terminalId: "t2", terminalName: "CAIXA-02" }, new Date("2026-08-25T11:00:00.000Z"));
    setForced(s, "t1", "1.5.0");
    const list = listFleet(s, (id) => id === "t2");
    expect(list.map((r) => r.terminalId)).toEqual(["t2", "t1"]);
    expect(list[0].online).toBe(true);
    expect(list[0].forcedMinVersion).toBeNull();
    expect(list[1].online).toBe(false);
    expect(list[1].forcedMinVersion).toBe("1.5.0");
  });
});
