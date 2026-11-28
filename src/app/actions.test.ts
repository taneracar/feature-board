// Calls the Server Actions directly, the way a forged POST would reach them,
// with Next's request APIs replaced by small fakes. Proves each action does
// its own authentication and authorization instead of trusting the UI.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/server/core/db";
import { openDb } from "@/server/core/db";

const jar = new Map<string, string>();
const revalidated: string[] = [];
let db: Db;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => void revalidated.push(p) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`REDIRECT ${url}`), { url });
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/server/db-instance", () => ({ getDb: async () => db }));

const actions = await import("./actions");
const idle = { status: "idle" as const };
const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};
const redirectOf = (p: Promise<unknown>) => p.then(() => null, (e: { url?: string }) => e.url ?? String(e));

beforeAll(async () => {
  db = await openDb();
});
afterAll(() => db.close());
beforeEach(() => {
  jar.clear();
  revalidated.length = 0;
});

let n = 0;
async function signedUp(name: string) {
  jar.clear();
  const email = `${name.toLowerCase()}${++n}@example.test`;
  const to = await redirectOf(
    actions.signUpAction(idle, form({ email, name, password: "0123456789", next: "/workspaces" })),
  );
  expect(to).toBe("/workspaces");
  return { email, cookie: jar.get("fb_session")! };
}
const useCookie = (c: string) => {
  jar.clear();
  jar.set("fb_session", c);
};

describe("auth actions", () => {
  it("sign up sets an opaque session cookie and redirects to a safe next", async () => {
    const { cookie } = await signedUp("Ada");
    expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("refuses an open redirect after sign in", async () => {
    const { email } = await signedUp("Bea");
    jar.clear();
    const to = await redirectOf(
      actions.signInAction(idle, form({ email, password: "0123456789", next: "https://evil.test/phish" })),
    );
    expect(to).toBe("/workspaces");
  });

  it("returns a form error, keeps the email, never echoes the password", async () => {
    const { email } = await signedUp("Cy");
    jar.clear();
    const state = await actions.signInAction(idle, form({ email, password: "wrong-password" }));
    expect(state).toMatchObject({ status: "error", message: "Email or password is incorrect.", values: { email } });
    expect(JSON.stringify(state)).not.toContain("wrong-password");
    expect(jar.has("fb_session")).toBe(false);
  });

  it("sign out revokes the session server-side, not just the cookie", async () => {
    const { cookie } = await signedUp("Dee");
    await redirectOf(actions.signOutAction());
    useCookie(cookie); // a stolen copy of the old cookie
    const state = await actions.createWorkspaceAction(idle, form({ name: "Nope", slug: "nope-ws" }));
    expect(state).toMatchObject({ status: "error", message: expect.stringMatching(/session has ended/) });
  });
});

describe("workspace + request actions", () => {
  it("rejects every mutation without a session", async () => {
    const r = await Promise.all([
      actions.createWorkspaceAction(idle, form({ name: "X", slug: "x-ws" })),
      actions.createRequestAction(idle, form({ slug: "x-ws", title: "Hello" })),
      actions.setStatusAction(idle, form({ slug: "x-ws", requestId: crypto.randomUUID(), status: "done" })),
      actions.createInviteAction(idle, form({ slug: "x-ws", role: "admin" })),
      actions.voteAction("x-ws", crypto.randomUUID(), true),
    ]);
    for (const s of r) expect(s).toMatchObject({ message: expect.stringMatching(/session has ended/) });
  });

  it("full flow: owner invites, member joins, member cannot do admin things", async () => {
    const owner = await signedUp("Owner");
    expect(await redirectOf(actions.createWorkspaceAction(idle, form({ name: "Acme", slug: "acme" })))).toBe("/w/acme");

    const posted = await actions.createRequestAction(idle, form({ slug: "acme", title: "Dark mode", body: "" }));
    expect(posted.status).toBe("ok");
    expect(revalidated).toContain("/w/acme");
    const [{ id }] = (await db.query<{ id: string }>(`select id from requests where title = 'Dark mode'`)).rows;

    const invite = await actions.createInviteAction(idle, form({ slug: "acme", role: "member" }));
    expect(invite.data?.path).toMatch(/^\/invite\/[A-Za-z0-9_-]{43}$/);
    const token = invite.data!.path.split("/").pop()!;

    await signedUp("Member");
    expect(await redirectOf(actions.acceptInviteAction(idle, form({ token })))).toBe("/w/acme");

    // Admin-only actions, called directly as a forged POST would.
    expect(await actions.setStatusAction(idle, form({ slug: "acme", requestId: id, status: "declined" }))).toMatchObject({
      status: "error",
      message: "Only a workspace admin can do that.",
    });
    expect(await actions.createInviteAction(idle, form({ slug: "acme", role: "admin" }))).toMatchObject({
      status: "error",
    });
    expect(await actions.deleteRequestAction(idle, form({ slug: "acme", requestId: id }))).toMatchObject({
      status: "error",
      message: "You can only delete your own requests.",
    });

    // What a member may do.
    expect(await actions.voteAction("acme", id, true)).toEqual({ ok: true, votes: 2, viewerVoted: true });
    expect(await actions.voteAction("acme", id, true)).toEqual({ ok: true, votes: 2, viewerVoted: true });

    useCookie(owner.cookie);
    expect(await actions.setStatusAction(idle, form({ slug: "acme", requestId: id, status: "planned" }))).toMatchObject({
      status: "ok",
    });
  });

  it("a member of one workspace cannot act on another by changing the slug", async () => {
    await signedUp("Alice");
    await redirectOf(actions.createWorkspaceAction(idle, form({ name: "Alpha", slug: "alpha" })));
    await actions.createRequestAction(idle, form({ slug: "alpha", title: "Alpha secret" }));
    const [{ id }] = (await db.query<{ id: string }>(`select id from requests where title = 'Alpha secret'`)).rows;

    await signedUp("Mallory");
    await redirectOf(actions.createWorkspaceAction(idle, form({ name: "Mal", slug: "mal" })));
    expect(await actions.createRequestAction(idle, form({ slug: "alpha", title: "Injected" }))).toMatchObject({
      message: "Workspace not found.",
    });
    // Mallory is admin of "mal" but the request belongs to "alpha".
    expect(await actions.setStatusAction(idle, form({ slug: "mal", requestId: id, status: "declined" }))).toMatchObject({
      message: "Request not found.",
    });
    expect(await actions.voteAction("mal", id, true)).toEqual({ ok: false, message: "Request not found." });
  });

  it("hides unexpected errors from the user", async () => {
    await signedUp("Err");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = db.query.bind(db);
    db.query = (async () => {
      throw new Error("connection reset: internal detail");
    }) as typeof db.query;
    try {
      const s = await actions.createRequestAction(idle, form({ slug: "acme", title: "Boom" }));
      expect(s).toMatchObject({ status: "error", message: "Something went wrong. Please try again." });
      expect(JSON.stringify(s)).not.toContain("internal detail");
    } finally {
      db.query = original;
      spy.mockRestore();
    }
  });
});
