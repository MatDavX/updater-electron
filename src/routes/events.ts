import { Elysia } from "elysia";
import { sseBroker } from "../sse";

export function eventRoutes() {
  return new Elysia().get("/events/updates", () => {
    const encoder = new TextEncoder();

    let unsubscribe: (() => void) | null = null;
    let keepAlive: ReturnType<typeof setInterval> | null = null;

    // Limpa inscrição + keepAlive imediatamente (no disconnect ou erro de envio).
    const cleanup = () => {
      if (keepAlive) {
        clearInterval(keepAlive);
        keepAlive = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    };

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));

        const send = (message: string) => {
          try {
            controller.enqueue(encoder.encode(message));
          } catch {
            cleanup();
          }
        };

        unsubscribe = sseBroker.subscribe(send);

        keepAlive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            cleanup();
          }
        }, 30_000);
      },
      // Disparado quando o client desconecta (fecha app, reload, restart) — limpa na hora.
      cancel() {
        cleanup();
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
