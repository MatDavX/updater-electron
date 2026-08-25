import { Elysia } from "elysia";

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
