import { Elysia } from "elysia";

/**
 * Guard de baixo nível usado num hook `onRequest` no app TOP-LEVEL, ANTES do
 * Elysia rotear/parsear o body. Existe porque `authGuard()` (via
 * `onBeforeHandle`) só roda depois que o body já foi parseado — em
 * `POST /api/upload` (multipart) isso significa que uma request sem token
 * ainda paga o custo de escrever o arquivo em disco e falha com 422 (SHA512
 * mismatch) antes de qualquer checagem de auth chegar a rodar, em vez de
 * 401 imediato. `requestAuthGate` intercepta antes disso, só para
 * `/api/*` e `/refresh` (as únicas rotas admin), e não substitui o
 * `authGuard()` scoped — ele continua como fallback (cobre `/refresh`,
 * que este gate também cobre, e serve de defesa em profundidade).
 */
export function requestAuthGate(secret: string | undefined) {
  return ({ request }: { request: Request }): Response | undefined => {
    if (!secret) return undefined;

    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/api/") && pathname !== "/refresh") return undefined;

    const token = request.headers.get("authorization")?.replace("Bearer ", "");
    if (token === secret) return undefined;

    return new Response(
      JSON.stringify({ error: "Unauthorized", message: "Invalid or missing API token" }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  };
}

export function authGuard() {
  const secret = Bun.env.API_SECRET;

  if (!secret) {
    console.warn(
      "[auth] WARNING: API_SECRET not set. Admin endpoints are unprotected!",
    );
  }

  return new Elysia({ name: "auth-guard" })
    .onBeforeHandle(({ headers, set }) => {
      if (!secret) return;

      const token = headers.authorization?.replace("Bearer ", "");
      if (token !== secret) {
        set.status = 401;
        return { error: "Unauthorized", message: "Invalid or missing API token" };
      }
    })
    // `onBeforeHandle` por padrão só se aplica à própria instância do plugin
    // e seus descendentes — não ao app pai que faz `.use(authGuard())`.
    // `.as("scoped")` propaga o guard para o pai (mas não além dele), então
    // rotas montadas via `.use(authGuard()).get(...)` no mesmo `Elysia()`
    // ficam protegidas de verdade.
    .as("scoped");
}
