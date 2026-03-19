import { Elysia } from "elysia";
import { sseBroker } from "../sse";

export function eventRoutes() {
  return new Elysia().get("/events/updates", () => {
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));

        const send = (message: string) => {
          try {
            controller.enqueue(encoder.encode(message));
          } catch {
            unsubscribe();
            clearInterval(keepAlive);
          }
        };

        const unsubscribe = sseBroker.subscribe(send);

        const keepAlive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            clearInterval(keepAlive);
            unsubscribe();
          }
        }, 30_000);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  });
}
