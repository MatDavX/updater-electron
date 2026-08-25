import { describe, it, expect } from "bun:test";
import { SSEBroker } from "./sse";

describe("SSEBroker", () => {
  it("sendTo reaches only that terminal's connections", () => {
    const b = new SSEBroker();
    const got: Record<string, string[]> = { a: [], b: [], anon: [] };
    b.subscribe((m) => got.a.push(m), { terminalId: "A" });
    b.subscribe((m) => got.b.push(m), { terminalId: "B" });
    b.subscribe((m) => got.anon.push(m));
    expect(b.sendTo("A", "emergency", { minVersion: "1.5.0" })).toBe(1);
    expect(got.a[0]).toBe('event: emergency\ndata: {"minVersion":"1.5.0"}\n\n');
    expect(got.b.length).toBe(0);
    expect(got.anon.length).toBe(0);
    expect(b.sendTo("Z", "x", {})).toBe(0);
  });

  it("keeps only the newest connection per terminalId (zumbi/reconexão)", () => {
    const b = new SSEBroker();
    const old: string[] = [];
    const fresh: string[] = [];
    let replacedCalls = 0;

    b.subscribe((m) => old.push(m), { terminalId: "A", onReplaced: () => replacedCalls++ });
    b.subscribe((m) => fresh.push(m), { terminalId: "A" });

    expect(b.count).toBe(1);
    expect(b.connectedTerminalIds()).toEqual(["A"]);
    expect(b.sendTo("A", "emergency", {})).toBe(1);
    expect(old.length).toBe(0);
    expect(fresh.length).toBe(1);
    expect(replacedCalls).toBe(1);
  });

  it("never replaces anonymous subscriptions", () => {
    const b = new SSEBroker();
    const got: string[] = [];
    b.subscribe((m) => got.push("1:" + m));
    b.subscribe((m) => got.push("2:" + m));
    b.subscribe((m) => got.push("3:" + m));
    expect(b.count).toBe(3);
    b.broadcast("ping", {});
    expect(got.map((g) => g.split(":")[0])).toEqual(["1", "2", "3"]);
  });

  it("unsubscribe of a replaced subscription is a no-op", () => {
    const b = new SSEBroker();
    const offOld = b.subscribe(() => {}, { terminalId: "A" });
    b.subscribe(() => {}, { terminalId: "A" });
    b.subscribe(() => {}, { terminalId: "B" });
    expect(b.count).toBe(2);

    offOld();
    expect(b.count).toBe(2);
    expect(b.isConnected("A")).toBe(true);

    offOld();
    expect(b.count).toBe(2);
  });

  it("isConnected / connectedTerminalIds reflect subscriptions and unsubscribes", () => {
    const b = new SSEBroker();
    const off = b.subscribe(() => {}, { terminalId: "A" });
    b.subscribe(() => {});
    expect(b.isConnected("A")).toBe(true);
    expect(b.connectedTerminalIds()).toEqual(["A"]);
    off();
    expect(b.isConnected("A")).toBe(false);
    expect(b.count).toBe(1);
  });

  it("broadcast with exclude skips matching terminals but still hits anonymous ones", () => {
    const b = new SSEBroker();
    const got: string[] = [];
    b.subscribe((m) => got.push("A:" + m), { terminalId: "A" });
    b.subscribe((m) => got.push("B:" + m), { terminalId: "B" });
    b.subscribe((m) => got.push("anon:" + m));
    b.broadcast("emergency-clear", {}, { exclude: (id) => id === "A" });
    expect(got.map((g) => g.split(":")[0]).sort()).toEqual(["B", "anon"]);
  });

  it("drops a client whose send throws", () => {
    const b = new SSEBroker();
    b.subscribe(() => { throw new Error("closed"); }, { terminalId: "A" });
    b.broadcast("ping", {});
    expect(b.count).toBe(0);
  });
});
