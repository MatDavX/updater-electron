import { Elysia, t } from "elysia";
import { sseBroker } from "../sse";
import type { StateStore } from "../state-store";
import { touchSeen } from "../fleet";

export function eventRoutes(store: StateStore) {
  return new Elysia().get(
    "/events/updates",
    ({ query }) => {
      const encoder = new TextEncoder();
      const terminalId = query.terminalId?.trim() || undefined;
      if (terminalId) touchSeen(store, terminalId, query.version?.trim() || undefined);

      let unsubscribe: (() => void) | null = null;
      let keepAlive: ReturnType<typeof setInterval> | null = null;

      // Libera inscrição + keepAlive na hora (disconnect do client, erro de envio ou
      // substituição por uma reconexão do mesmo terminal). Idempotente: pode rodar N vezes.
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
              throw new Error("sse closed"); // faz o broker descartar a inscrição
            }
          };

          // onReplaced: se outra conexão do mesmo terminalId assumir, ninguém mais chamaria
          // nosso cleanup (o stream zumbi não dispara cancel()) e o keepAlive ficaria
          // pingando pra sempre num stream morto.
          unsubscribe = sseBroker.subscribe(send, { terminalId, onReplaced: () => cleanup() });

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
    },
    {
      query: t.Object({
        terminalId: t.Optional(t.String({ maxLength: 64 })),
        version: t.Optional(t.String({ maxLength: 32 })),
      }),
    },
  );
}
