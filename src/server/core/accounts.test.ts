import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSession,
  MAX_FAILURES,
  revokeAllSessions,
  revokeSession,
  sha256,
  signIn,
  signUp,
  validateSession,
} from "./accounts";
import type { Db } from "./db";
import { hashPassword, verifyPassword } from "./passwords";
import { freshDb } from "./test-helpers";
import { safeNext } from "./validation";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(() => db.close());

const DAY = 86_400_000;

describe("passwords", () => {
  it("verifies the right password and rejects a wrong one", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h.startsWith("scrypt$1024$8$1$")).toBe(true);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("correct horse batterY", h)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same password")).not.toBe(await hashPassword("same password"));
  });

  it("treats malformed stored hashes as a mismatch, not a crash", async () => {
    expect(await verifyPassword("x", "plaintext")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$a$b$c$d$e")).toBe(false);
  });

  it("normalizes unicode so the same visible password matches", async () => {
    const h = await hashPassword("café-password");
    expect(await verifyPassword("café-password", h)).toBe(true);
  });
});

describe("signUp", () => {
  it("lowercases and trims the email and never returns the hash", async () => {
    const u = await signUp(db, { email: "  Ada@Example.TEST ", name: "Ada", password: "0123456789" });
    expect(u).toEqual({ id: expect.any(String), email: "ada@example.test", name: "Ada" });
    expect(Object.keys(u)).not.toContain("password_hash");
  });

  it("rejects duplicates regardless of case", async () => {
    await expect(signUp(db, { email: "ADA@example.test", name: "Ada 2", password: "0123456789" })).rejects.toMatchObject({
      code: "conflict",
      fieldErrors: { email: "Already registered." },
    });
  });

  it("returns field errors for bad input", async () => {
    await expect(signUp(db, { email: "nope", name: "", password: "short" })).rejects.toMatchObject({
      code: "validation",
      fieldErrors: {
        email: "Enter a valid email address.",
        name: "Enter your name.",
        password: "Use at least 10 characters.",
      },
    });
  });
});

describe("signIn", () => {
  it("accepts the right password with any email casing", async () => {
    await signUp(db, { email: "grace@example.test", name: "Grace", password: "0123456789" });
    const u = await signIn(db, { email: "GRACE@example.test", password: "0123456789" });
    expect(u.name).toBe("Grace");
  });

  it("uses the same message for unknown email and wrong password", async () => {
    const a = signIn(db, { email: "grace@example.test", password: "wrong-password" }).catch((e) => e.message);
    const b = signIn(db, { email: "nobody@example.test", password: "wrong-password" }).catch((e) => e.message);
    expect(await a).toBe(await b);
  });

  it("locks an email after repeated failures, then unlocks after the window", async () => {
    await signUp(db, { email: "lin@example.test", name: "Lin", password: "0123456789" });
    const t0 = new Date("2026-11-27T10:00:00Z");
    for (let i = 0; i < MAX_FAILURES; i++) {
      await expect(signIn(db, { email: "lin@example.test", password: "bad" }, t0)).rejects.toMatchObject({
        code: "unauthenticated",
      });
    }
    // Even the right password is refused while locked.
    await expect(signIn(db, { email: "lin@example.test", password: "0123456789" }, t0)).rejects.toMatchObject({
      code: "rate_limited",
    });
    const later = new Date(t0.getTime() + 16 * 60_000);
    await expect(signIn(db, { email: "lin@example.test", password: "0123456789" }, later)).resolves.toMatchObject({
      name: "Lin",
    });
  });

  it("clears the failure count after a successful sign-in", async () => {
    await signUp(db, { email: "mo@example.test", name: "Mo", password: "0123456789" });
    const t = new Date("2026-11-27T12:00:00Z");
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      await signIn(db, { email: "mo@example.test", password: "bad" }, t).catch(() => {});
    }
    await signIn(db, { email: "mo@example.test", password: "0123456789" }, t);
    await signIn(db, { email: "mo@example.test", password: "bad" }, t).catch(() => {});
    await expect(signIn(db, { email: "mo@example.test", password: "0123456789" }, t)).resolves.toBeTruthy();
  });
});

describe("sessions", () => {
  it("stores only a hash of the token", async () => {
    const u = await signUp(db, { email: "s1@example.test", name: "S1", password: "0123456789" });
    const { token } = await createSession(db, u.id);
    const rows = await db.query<{ token_hash: string }>(`select token_hash from sessions where user_id = $1`, [u.id]);
    expect(rows.rows).toEqual([{ token_hash: sha256(token) }]);
    expect(JSON.stringify(rows.rows)).not.toContain(token);
  });

  it("validates, slides near expiry, expires, and revokes", async () => {
    const u = await signUp(db, { email: "s2@example.test", name: "S2", password: "0123456789" });
    const t0 = new Date("2026-11-01T00:00:00Z");
    const { token } = await createSession(db, u.id, t0);

    const fresh = await validateSession(db, token, new Date(t0.getTime() + 1 * DAY));
    expect(fresh).toMatchObject({ user: { id: u.id }, renewedUntil: null });

    const day20 = new Date(t0.getTime() + 20 * DAY);
    const renewed = await validateSession(db, token, day20);
    expect(renewed?.renewedUntil?.toISOString()).toBe(new Date(day20.getTime() + 30 * DAY).toISOString());

    // Would have expired at day 30 without the renewal.
    expect(await validateSession(db, token, new Date(t0.getTime() + 35 * DAY))).not.toBeNull();
    expect(await validateSession(db, token, new Date(t0.getTime() + 51 * DAY))).toBeNull();
    // An expired session is deleted, so it stays dead.
    expect(await validateSession(db, token, t0)).toBeNull();

    const s2 = await createSession(db, u.id);
    await revokeSession(db, s2.token);
    expect(await validateSession(db, s2.token)).toBeNull();
  });

  it("rejects missing, unknown and oversized tokens", async () => {
    expect(await validateSession(db, undefined)).toBeNull();
    expect(await validateSession(db, "not-a-token")).toBeNull();
    expect(await validateSession(db, "x".repeat(5000))).toBeNull();
  });

  it("can sign a user out everywhere", async () => {
    const u = await signUp(db, { email: "s3@example.test", name: "S3", password: "0123456789" });
    const a = await createSession(db, u.id);
    const b = await createSession(db, u.id);
    expect(await revokeAllSessions(db, u.id)).toBe(2);
    expect(await validateSession(db, a.token)).toBeNull();
    expect(await validateSession(db, b.token)).toBeNull();
  });
});

describe("safeNext (open redirect guard)", () => {
  it.each([
    ["/w/acme", "/w/acme"],
    ["/invite/abc?x=1", "/invite/abc?x=1"],
    ["https://evil.test", "/workspaces"],
    ["//evil.test", "/workspaces"],
    ["/\\evil.test", "/workspaces"],
    ["javascript:alert(1)", "/workspaces"],
    ["/ok\r\nSet-Cookie: x", "/workspaces"],
    [undefined, "/workspaces"],
  ])("%s -> %s", (input, out) => {
    expect(safeNext(input)).toBe(out);
  });
});
