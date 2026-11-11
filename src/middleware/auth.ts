import { Elysia } from "elysia";
import { createHash, timingSafeEqual } from "node:crypto";

export type TokenRole = "admin" | "web";

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

export function resolveTokenRole(
  header: string | null | undefined,
  secret: string | undefined,
  webSecret: string | undefined,
): TokenRole | null {
  const token = bearerToken(header);
  if (!token) return null;
  if (secret && safeEqual(token, secret)) return "admin";
  if (webSecret && safeEqual(token, webSecret)) return "web";
  return null;
}

const SEG = "[^/]+";
const WEB_ALLOWED: Array<{ methods: string[]; path: RegExp }> = [
  { methods: ["GET"], path: /^\/api\/status\/?$/ },
  { methods: ["GET"], path: /^\/api\/fleet\/?$/ },
  { methods: ["POST", "DELETE"], path: new RegExp(`^/api/fleet/${SEG}/force/?$`) },
  { methods: ["POST"], path: new RegExp(`^/api/fleet/${SEG}/logout/?$`) },
  { methods: ["DELETE"], path: new RegExp(`^/api/fleet/${SEG}/?$`) },
  { methods: ["GET"], path: /^\/api\/companies\/forced\/?$/ },
  { methods: ["POST", "DELETE"], path: new RegExp(`^/api/companies/${SEG}/force/?$`) },
  { methods: ["GET"], path: /^\/api\/releases\/history\/?$/ },
  { methods: ["POST", "DELETE"], path: /^\/api\/active-version\/?$/ },
  { methods: ["GET", "POST", "DELETE"], path: /^\/api\/emergency\/?$/ },
];

export function isAllowedForRole(role: TokenRole, method: string, pathname: string): boolean {
  if (role === "admin") return true;
  return WEB_ALLOWED.some((r) => r.methods.includes(method.toUpperCase()) && r.path.test(pathname));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** undefined = segue; Response = barra (401/403). Único ponto de decisão. */
export function checkAdminRequest(
  request: Request,
  secret: string | undefined,
  webSecret: string | undefined,
): Response | undefined {
  if (!secret) return undefined; // modo aberto
  const role = resolveTokenRole(request.headers.get("authorization"), secret, webSecret);
  if (!role) {
    return jsonResponse(401, { error: "Unauthorized", message: "Invalid or missing API token" });
  }
  const { pathname } = new URL(request.url);
  if (!isAllowedForRole(role, request.method, pathname)) {
    return jsonResponse(403, { error: "Forbidden", message: "Token not allowed for this route" });
  }
  return undefined;
}

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
export function requestAuthGate(secret: string | undefined, webSecret?: string) {
  return ({ request }: { request: Request }): Response | undefined => {
    if (!secret) return undefined;

    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/api/") && pathname !== "/refresh") return undefined;

    return checkAdminRequest(request, secret, webSecret);
  };
}

export function authGuard() {
  const secret = Bun.env.API_SECRET;
  const webSecret = Bun.env.WEB_API_SECRET;

  if (!secret) {
    console.warn(
      "[auth] WARNING: API_SECRET not set. Admin endpoints are unprotected!",
    );
  } else if (webSecret && webSecret === secret) {
    console.warn(
      "[auth] WARNING: WEB_API_SECRET igual a API_SECRET; o token da web terá acesso total. Use um valor diferente.",
    );
  }

  return new Elysia({ name: "auth-guard" })
    .onBeforeHandle(({ request }) => checkAdminRequest(request, secret, webSecret))
    // `onBeforeHandle` por padrão só se aplica à própria instância do plugin
    // e seus descendentes — não ao app pai que faz `.use(authGuard())`.
    // `.as("scoped")` propaga o guard para o pai (mas não além dele), então
    // rotas montadas via `.use(authGuard()).get(...)` no mesmo `Elysia()`
    // ficam protegidas de verdade.
    .as("scoped");
}
