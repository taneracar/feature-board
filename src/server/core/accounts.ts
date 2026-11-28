import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { many, one, type Db, type Q } from "./db";
import { AppError } from "./errors";
import { dummyHash, hashPassword, verifyPassword } from "./passwords";
import { fieldErrors } from "./validation";

export type User = { id: string; email: string; name: string };

export const SESSION_DAYS = 30;
/** A session with less than this left is extended on use (sliding expiry). */
export const RENEW_WITHIN_DAYS = 15;
export const MAX_FAILURES = 5;
export const FAILURE_WINDOW_MIN = 15;

const DAY = 86_400_000;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter a valid email address.").max(254));

const signUpSchema = z.object({
  email,
  name: z.string().trim().min(1, "Enter your name.").max(80, "Name is too long."),
  // NIST 800-63B: length over composition rules; cap to bound hashing cost.
  password: z.string().min(10, "Use at least 10 characters.").max(200, "Password is too long."),
});

export async function signUp(db: Db, input: unknown): Promise<User> {
  const parsed = signUpSchema.safeParse(input);
  if (!parsed.success) throw new AppError("validation", "Check the highlighted fields.", fieldErrors(parsed.error));
  const { email, name, password } = parsed.data;
  const hash = await hashPassword(password);
  const user = await one<User>(
    db,
    `insert into users (email, name, password_hash) values ($1, $2, $3)
     on conflict (email) do nothing
     returning id, email, name`,
    [email, name, hash],
  );
  if (!user) {
    throw new AppError("conflict", "An account with this email already exists.", { email: "Already registered." });
  }
  return user;
}

const signInSchema = z.object({ email, password: z.string().min(1).max(200) });

/**
 * Checks credentials. The same message is used for unknown email and wrong
 * password, an unknown email still pays for a hash, and repeated failures for
 * one email are throttled.
 */
export async function signIn(db: Db, input: unknown, now = new Date()): Promise<User> {
  const parsed = signInSchema.safeParse(input);
  if (!parsed.success) throw new AppError("validation", "Enter your email and password.");
  const { email, password } = parsed.data;

  const since = new Date(now.getTime() - FAILURE_WINDOW_MIN * 60_000);
  const failures = await one<{ n: number }>(
    db,
    `select count(*)::int as n from login_failures where email = $1 and failed_at > $2`,
    [email, since],
  );
  if ((failures?.n ?? 0) >= MAX_FAILURES) {
    throw new AppError("rate_limited", `Too many attempts. Try again in ${FAILURE_WINDOW_MIN} minutes.`);
  }

  const row = await one<User & { password_hash: string }>(
    db,
    `select id, email, name, password_hash from users where email = $1`,
    [email],
  );
  const ok = await verifyPassword(password, row?.password_hash ?? (await dummyHash()));
  if (!row || !ok) {
    await db.query(`insert into login_failures (email, failed_at) values ($1, $2)`, [email, now]);
    throw new AppError("unauthenticated", "Email or password is incorrect.");
  }
  await db.query(`delete from login_failures where email = $1`, [email]);
  return { id: row.id, email: row.email, name: row.name };
}

export type NewSession = { token: string; expiresAt: Date };

export async function createSession(q: Q, userId: string, now = new Date()): Promise<NewSession> {
  const token = newToken();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * DAY);
  await q.query(`insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3)`, [
    sha256(token),
    userId,
    expiresAt,
  ]);
  return { token, expiresAt };
}

export type SessionCheck = { user: User; renewedUntil: Date | null };

/** Returns the user for a raw cookie token, extending the session when it is in its second half. */
export async function validateSession(q: Q, token: string | undefined, now = new Date()): Promise<SessionCheck | null> {
  if (!token || token.length > 100) return null;
  const hash = sha256(token);
  const row = await one<User & { expires_at: Date }>(
    q,
    `select u.id, u.email, u.name, s.expires_at
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1`,
    [hash],
  );
  if (!row) return null;
  if (row.expires_at.getTime() <= now.getTime()) {
    await q.query(`delete from sessions where token_hash = $1`, [hash]);
    return null;
  }
  let renewedUntil: Date | null = null;
  if (row.expires_at.getTime() - now.getTime() < RENEW_WITHIN_DAYS * DAY) {
    renewedUntil = new Date(now.getTime() + SESSION_DAYS * DAY);
    await q.query(`update sessions set expires_at = $2 where token_hash = $1`, [hash, renewedUntil]);
  }
  return { user: { id: row.id, email: row.email, name: row.name }, renewedUntil };
}

export async function revokeSession(q: Q, token: string): Promise<void> {
  await q.query(`delete from sessions where token_hash = $1`, [sha256(token)]);
}

export async function revokeAllSessions(q: Q, userId: string): Promise<number> {
  const rows = await many(q, `delete from sessions where user_id = $1 returning 1`, [userId]);
  return rows.length;
}
