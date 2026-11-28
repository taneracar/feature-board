import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./db";
import { createRequest, deleteRequest, listQuerySchema, listRequests, setStatus, setVote } from "./requests";
import { asMember, freshDb, makeUser } from "./test-helpers";
import { acceptInvite, createInvite, createWorkspace, type Membership } from "./workspaces";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(() => db.close());

let seq = 0;
async function team() {
  const owner = await makeUser(db, "Owner");
  const s = `board-${++seq}`;
  await createWorkspace(db, owner.id, { name: "Board", slug: s });
  const om = await asMember(db, owner.id, s);
  const member = await makeUser(db, "Member");
  const { token } = await createInvite(db, om, owner.id, { role: "member" });
  await acceptInvite(db, member.id, token);
  const mm = await asMember(db, member.id, s);
  return { owner, om, member, mm };
}

const q = (sort = "top", status = "active") => listQuerySchema.parse({ sort, status });
const list = (m: Membership, viewer: string, query = q()) => listRequests(db, m, viewer, query);

describe("createRequest", () => {
  it("creates with the author's vote counted", async () => {
    const { mm, member } = await team();
    await createRequest(db, mm, member.id, { title: "  Dark mode  ", body: "Please" });
    expect(await list(mm, member.id)).toEqual([
      expect.objectContaining({ title: "Dark mode", votes: 1, viewerVoted: true, status: "open", authorName: "Member" }),
    ]);
  });

  it("validates title and body length", async () => {
    const { mm, member } = await team();
    await expect(createRequest(db, mm, member.id, { title: "x" })).rejects.toMatchObject({
      code: "validation",
      fieldErrors: { title: "Use at least 3 characters." },
    });
    await expect(
      createRequest(db, mm, member.id, { title: "Long body", body: "x".repeat(2001) }),
    ).rejects.toMatchObject({ fieldErrors: { body: expect.any(String) } });
  });
});

describe("voting", () => {
  it("is idempotent: voting twice still counts once", async () => {
    const { om, owner, mm, member } = await team();
    const { id } = await createRequest(db, mm, member.id, { title: "Export CSV" });
    await setVote(db, om, owner.id, id, true);
    expect(await setVote(db, om, owner.id, id, true)).toEqual({ votes: 2, viewerVoted: true });
    expect(await setVote(db, om, owner.id, id, false)).toEqual({ votes: 1, viewerVoted: false });
    expect(await setVote(db, om, owner.id, id, false)).toEqual({ votes: 1, viewerVoted: false });
  });

  it("counts concurrent votes from the same user once", async () => {
    const { om, owner, mm, member } = await team();
    const { id } = await createRequest(db, mm, member.id, { title: "Race" });
    await Promise.all(Array.from({ length: 5 }, () => setVote(db, om, owner.id, id, true)));
    expect((await list(om, owner.id))[0].votes).toBe(2);
  });

  it("refuses new votes on closed requests but allows removing one", async () => {
    const { om, owner, mm, member } = await team();
    const { id } = await createRequest(db, mm, member.id, { title: "Closed soon" });
    await setStatus(db, om, id, "done");
    await expect(setVote(db, om, owner.id, id, true)).rejects.toMatchObject({ code: "conflict" });
    await expect(setVote(db, mm, member.id, id, false)).resolves.toEqual({ votes: 0, viewerVoted: false });
  });

  it("cannot vote on a request from another workspace even with its id", async () => {
    const a = await team();
    const b = await team();
    const { id } = await createRequest(db, a.mm, a.member.id, { title: "Private to A" });
    await expect(setVote(db, b.om, b.owner.id, id, true)).rejects.toMatchObject({ code: "not_found" });
    await expect(setStatus(db, b.om, id, "declined")).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteRequest(db, b.om, b.owner.id, id)).rejects.toMatchObject({ code: "not_found" });
    expect((await list(a.om, a.owner.id))[0]).toMatchObject({ votes: 1, status: "open" });
  });

  it("treats malformed ids as not found", async () => {
    const { om, owner } = await team();
    await expect(setVote(db, om, owner.id, "'; drop table votes; --", true)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("status", () => {
  it("only admins can change it", async () => {
    const { mm, member } = await team();
    const { id } = await createRequest(db, mm, member.id, { title: "Mine" });
    await expect(setStatus(db, mm, id, "planned")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects unknown statuses", async () => {
    const { om, mm, member } = await team();
    const { id } = await createRequest(db, mm, member.id, { title: "Mine" });
    await expect(setStatus(db, om, id, "shipped")).rejects.toMatchObject({ code: "validation" });
  });
});

describe("listing", () => {
  it("sorts by votes or by date and filters by status", async () => {
    const { om, owner, mm, member } = await team();
    const a = await createRequest(db, mm, member.id, { title: "Alpha" });
    const b = await createRequest(db, mm, member.id, { title: "Bravo" });
    const c = await createRequest(db, mm, member.id, { title: "Charlie" });
    await setVote(db, om, owner.id, b.id, true);
    await setStatus(db, om, c.id, "declined");

    expect((await list(om, owner.id, q("top"))).map((r) => r.title)).toEqual(["Bravo", "Alpha"]);
    expect((await list(om, owner.id, q("new", "all"))).map((r) => r.title)).toEqual(["Charlie", "Bravo", "Alpha"]);
    expect((await list(om, owner.id, q("top", "declined"))).map((r) => r.title)).toEqual(["Charlie"]);
    const rows = await list(om, owner.id, q("top", "all"));
    expect(rows.find((r) => r.id === b.id)?.viewerVoted).toBe(true);
    expect(rows.find((r) => r.id === a.id)?.viewerVoted).toBe(false);
  });

  it("falls back to defaults for junk query params", () => {
    expect(listQuerySchema.parse({ sort: "drop", status: 42 })).toEqual({ sort: "top", status: "active" });
  });
});

describe("deleteRequest", () => {
  it("authors can delete their own request until someone else votes", async () => {
    const { om, owner, mm, member } = await team();
    const first = await createRequest(db, mm, member.id, { title: "Oops" });
    await deleteRequest(db, mm, member.id, first.id);
    const second = await createRequest(db, mm, member.id, { title: "Popular" });
    await setVote(db, om, owner.id, second.id, true);
    await expect(deleteRequest(db, mm, member.id, second.id)).rejects.toMatchObject({ code: "conflict" });
    await deleteRequest(db, om, owner.id, second.id);
    expect(await list(om, owner.id, q("top", "all"))).toEqual([]);
  });

  it("members cannot delete other people's requests", async () => {
    const { om, owner, mm, member } = await team();
    const { id } = await createRequest(db, om, owner.id, { title: "Owner's" });
    await expect(deleteRequest(db, mm, member.id, id)).rejects.toMatchObject({ code: "forbidden" });
  });
});
