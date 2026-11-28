import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./db";
import { asMember, freshDb, makeUser } from "./test-helpers";
import {
  acceptInvite,
  changeRole,
  createInvite,
  createWorkspace,
  listMembers,
  listWorkspaces,
  previewInvite,
  removeMember,
  requireMembership,
} from "./workspaces";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(() => db.close());

let seq = 0;
const slug = () => `team-${++seq}`;

async function setup() {
  const owner = await makeUser(db, "Owner");
  const s = slug();
  await createWorkspace(db, owner.id, { name: "Team", slug: s });
  const om = await asMember(db, owner.id, s);
  return { owner, s, om };
}

async function join(s: string, role: "member" | "admin", inviterId: string) {
  const u = await makeUser(db, role === "admin" ? "Admin" : "Member");
  const m = await asMember(db, inviterId, s);
  const { token } = await createInvite(db, m, inviterId, { role });
  await acceptInvite(db, u.id, token);
  return u;
}

describe("createWorkspace", () => {
  it("makes the creator the owner", async () => {
    const { owner, s } = await setup();
    expect(await listWorkspaces(db, owner.id)).toEqual([expect.objectContaining({ slug: s, role: "owner" })]);
  });

  it("rejects taken, reserved and malformed slugs", async () => {
    const { owner, s } = await setup();
    await expect(createWorkspace(db, owner.id, { name: "Dup", slug: s.toUpperCase() })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(createWorkspace(db, owner.id, { name: "X", slug: "settings" })).rejects.toMatchObject({
      code: "validation",
    });
    for (const bad of ["a", "-abc", "abc-", "has space", "ünicode", "x".repeat(41)]) {
      await expect(createWorkspace(db, owner.id, { name: "Bad", slug: bad })).rejects.toMatchObject({
        code: "validation",
      });
    }
  });

  it("rolls back the workspace if adding the owner fails", async () => {
    const s = slug();
    await expect(
      createWorkspace(db, "00000000-0000-0000-0000-000000000000", { name: "Orphan", slug: s }),
    ).rejects.toThrow();
    const left = await db.query(`select 1 from workspaces where slug = $1`, [s]);
    expect(left.rows).toHaveLength(0);
  });
});

describe("requireMembership (tenant isolation)", () => {
  it("hides workspaces from non-members as not found", async () => {
    const { s } = await setup();
    const outsider = await makeUser(db, "Outsider");
    await expect(requireMembership(db, outsider.id, s)).rejects.toMatchObject({ code: "not_found" });
    await expect(requireMembership(db, outsider.id, "does-not-exist")).rejects.toMatchObject({ code: "not_found" });
  });

  it("enforces a minimum role", async () => {
    const { owner, s } = await setup();
    const member = await join(s, "member", owner.id);
    await expect(requireMembership(db, member.id, s, "admin")).rejects.toMatchObject({ code: "forbidden" });
    await expect(requireMembership(db, owner.id, s, "owner")).resolves.toMatchObject({ role: "owner" });
  });
});

describe("invites", () => {
  it("only admins and owners can invite", async () => {
    const { owner, s } = await setup();
    const member = await join(s, "member", owner.id);
    const mm = await asMember(db, member.id, s);
    await expect(createInvite(db, mm, member.id, { role: "member" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("cannot create owner invites", async () => {
    const { owner, om } = await setup();
    await expect(createInvite(db, om, owner.id, { role: "owner" })).rejects.toMatchObject({ code: "validation" });
  });

  it("is single use", async () => {
    const { owner, om, s } = await setup();
    const { token } = await createInvite(db, om, owner.id, { role: "member" });
    const a = await makeUser(db, "A");
    const b = await makeUser(db, "B");
    await acceptInvite(db, a.id, token);
    await expect(acceptInvite(db, b.id, token)).rejects.toMatchObject({ code: "not_found" });
    await expect(requireMembership(db, b.id, s)).rejects.toMatchObject({ code: "not_found" });
    expect((await previewInvite(db, token))?.status).toBe("used");
  });

  it("stays single use when two people accept at the same time", async () => {
    const { owner, om } = await setup();
    const { token } = await createInvite(db, om, owner.id, { role: "member" });
    const users = await Promise.all([makeUser(db, "R1"), makeUser(db, "R2"), makeUser(db, "R3")]);
    const results = await Promise.allSettled(users.map((u) => acceptInvite(db, u.id, token)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("expires", async () => {
    const { owner, om } = await setup();
    const t0 = new Date("2026-11-01T00:00:00Z");
    const { token } = await createInvite(db, om, owner.id, { role: "member" }, t0);
    const late = new Date("2026-11-09T00:00:00Z");
    expect((await previewInvite(db, token, late))?.status).toBe("expired");
    const u = await makeUser(db, "Late");
    await expect(acceptInvite(db, u.id, token, late)).rejects.toMatchObject({ code: "not_found" });
  });

  it("never downgrades an existing member", async () => {
    const { owner, om, s } = await setup();
    const admin = await join(s, "admin", owner.id);
    const { token } = await createInvite(db, om, owner.id, { role: "member" });
    await acceptInvite(db, admin.id, token);
    expect((await asMember(db, admin.id, s)).role).toBe("admin");
  });

  it("stores only a hash of the token", async () => {
    const { owner, om } = await setup();
    const { token } = await createInvite(db, om, owner.id, { role: "member" });
    const all = await db.query(`select token_hash from invites`);
    expect(JSON.stringify(all.rows)).not.toContain(token);
  });

  it("unknown tokens preview as null", async () => {
    expect(await previewInvite(db, "nope")).toBeNull();
  });
});

describe("roles", () => {
  it("admins can promote members to admin but cannot touch owners", async () => {
    const { owner, s } = await setup();
    const admin = await join(s, "admin", owner.id);
    const member = await join(s, "member", owner.id);
    const am = await asMember(db, admin.id, s);
    await changeRole(db, am, { userId: member.id, role: "admin" });
    expect((await asMember(db, member.id, s)).role).toBe("admin");
    await expect(changeRole(db, am, { userId: owner.id, role: "member" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(changeRole(db, am, { userId: admin.id, role: "owner" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("members cannot change roles", async () => {
    const { owner, s } = await setup();
    const member = await join(s, "member", owner.id);
    const mm = await asMember(db, member.id, s);
    await expect(changeRole(db, mm, { userId: member.id, role: "admin" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("the last owner cannot be demoted, removed or leave", async () => {
    const { owner, om, s } = await setup();
    await expect(changeRole(db, om, { userId: owner.id, role: "admin" })).rejects.toMatchObject({ code: "conflict" });
    await expect(removeMember(db, om, owner.id, owner.id)).rejects.toMatchObject({ code: "conflict" });
    const other = await join(s, "admin", owner.id);
    await changeRole(db, om, { userId: other.id, role: "owner" });
    await removeMember(db, om, owner.id, owner.id);
    await expect(requireMembership(db, owner.id, s)).rejects.toMatchObject({ code: "not_found" });
  });

  it("members can leave but cannot remove others", async () => {
    const { owner, s } = await setup();
    const a = await join(s, "member", owner.id);
    const b = await join(s, "member", owner.id);
    const am = await asMember(db, a.id, s);
    await expect(removeMember(db, am, a.id, b.id)).rejects.toMatchObject({ code: "forbidden" });
    await removeMember(db, am, a.id, a.id);
    expect((await listMembers(db, am.workspace.id)).map((m) => m.userId)).not.toContain(a.id);
  });

  it("role changes cannot target people in another workspace", async () => {
    const one = await setup();
    const two = await setup();
    await expect(changeRole(db, one.om, { userId: two.owner.id, role: "member" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("lists owners first", async () => {
    const { owner, om, s } = await setup();
    await join(s, "member", owner.id);
    await join(s, "admin", owner.id);
    expect((await listMembers(db, om.workspace.id)).map((m) => m.role)).toEqual(["owner", "admin", "member"]);
  });
});
