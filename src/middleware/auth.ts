import { Elysia } from "elysia";

export function authGuard() {
  const secret = Bun.env.API_SECRET;

  if (!secret) {
    console.warn(
      "[auth] WARNING: API_SECRET not set. Admin endpoints are unprotected!",
    );
  }

  return new Elysia({ name: "auth-guard" }).onBeforeHandle(
    ({ headers, set }) => {
      if (!secret) return;

      const token = headers.authorization?.replace("Bearer ", "");
      if (token !== secret) {
        set.status = 401;
        return { error: "Unauthorized", message: "Invalid or missing API token" };
      }
    },
  );
}
