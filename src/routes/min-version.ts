import { Elysia } from "elysia";
import { getMinVersion } from "../emergency";

// Rota pública consumida pelo app no boot (fallback de emergência):
// GET /min-version.json -> { minVersion: "1.3.0" | null }
export function minVersionRoutes() {
  return new Elysia().get("/min-version.json", () => {
    return new Response(JSON.stringify({ minVersion: getMinVersion() }), {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-cache",
      },
    });
  });
}
