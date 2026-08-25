import { describe, it, expect } from "bun:test";
import { Elysia } from "elysia";
import { StateStore } from "../state-store";
import { sseBroker } from "../sse";
import { eventRoutes } from "./events";

function app() {
  const store = new StateStore("/dev/null/never.json", { debounceMs: 1e9 });
  return { store, app: new Elysia().use(eventRoutes(store)) };
}

describe("GET /events/updates", () => {
  it("connects with terminalId, marks fleet as seen, registers on the broker", async () => {
    const { store, app: a } = app();
    const res = await a.handle(new Request("http://localhost/events/updates?terminalId=t1&version=1.2.0"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(store.get().fleet.t1).toBeDefined();
    expect(store.get().fleet.t1?.version).toBe("1.2.0");
    expect(sseBroker.isConnected("t1")).toBe(true);

    await res.body?.cancel();
    // Cancel triggers the stream's cancel() callback, which unsubscribes.
    // Give it a tick in case cleanup isn't synchronous under Bun.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sseBroker.isConnected("t1")).toBe(false);
  });

  it("connects anonymously with no query, no fleet record, still counted by the broker", async () => {
    const { store, app: a } = app();
    const idsBefore = sseBroker.connectedTerminalIds();
    const countBefore = sseBroker.count;

    const res = await a.handle(new Request("http://localhost/events/updates"));

    expect(res.status).toBe(200);
    expect(Object.keys(store.get().fleet)).toEqual([]);
    expect(sseBroker.count).toBe(countBefore + 1);
    expect(sseBroker.connectedTerminalIds()).toEqual(idsBefore);

    await res.body?.cancel();
  });

  it("treats a whitespace-only terminalId as absent (no fleet record)", async () => {
    const { store, app: a } = app();
    const res = await a.handle(new Request("http://localhost/events/updates?terminalId=%20%20"));

    expect(res.status).toBe(200);
    expect(Object.keys(store.get().fleet)).toEqual([]);

    await res.body?.cancel();
  });
});
