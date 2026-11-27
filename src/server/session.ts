import "server-only";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { createSession, revokeSession, SESSION_DAYS, validateSession, type User } from "./core/accounts";
import { isAppError } from "./core/errors";
import { requireMembership, type Membership, type Role } from "./core/workspaces";
import { getDb } from "./db-instance";

export const SESSION_COOKIE = "fb_session";

export const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "1",
  path: "/",
  maxAge: SESSION_DAYS * 86_400,
};

/**
 * The Data Access Layer entry point: reads the cookie and checks it against
 * the sessions table. Wrapped in React `cache` so a page that asks several
 * times per request hits the database once. The database is the authority on
 * expiry; proxy.ts only refreshes the cookie's max-age on navigation.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  // Expiry is checked against the clock. connection() pins this to request
  // time, so Next never tries to prerender (and freeze) a session check.
  await connection();
  const result = await validateSession(await getDb(), token);
  return result?.user ?? null;
});

export async function requireUser(next?: string): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  return user;
}

/** For pages: signed-in member of the workspace, or a 404 (never a hint the slug exists). */
export async function requireWorkspacePage(slug: string, min: Role = "member"): Promise<{ user: User; m: Membership }> {
  const user = await requireUser(`/w/${slug}`);
  try {
    return { user, m: await requireMembership(await getDb(), user.id, slug, min) };
  } catch (e) {
    if (isAppError(e)) notFound();
    throw e;
  }
}

export async function startSession(userId: string) {
  const { token } = await createSession(await getDb(), userId);
  (await cookies()).set(SESSION_COOKIE, token, cookieOptions);
}

export async function endSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(await getDb(), token);
  jar.delete(SESSION_COOKIE);
}
