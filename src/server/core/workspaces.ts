import { z } from "zod";
import { newToken, sha256 } from "./accounts";
import { many, one, type Db, type Q } from "./db";
import { AppError } from "./errors";
import { fieldErrors } from "./validation";

export const ROLES = ["member", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];
const rank = (r: Role) => ROLES.indexOf(r);
export const atLeast = (role: Role, min: Role) => rank(role) >= rank(min);

export type Workspace = { id: string; slug: string; name: string };
export type Membership = { workspace: Workspace; role: Role };

export const INVITE_DAYS = 7;

const createSchema = z.object({
  name: z.string().trim().min(2, "Use at least 2 characters.").max(60, "Name is too long."),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, "3-40 characters: letters, numbers and dashes."),
});

const RESERVED = new Set(["new", "settings", "admin", "api"]);

export async function createWorkspace(db: Db, userId: string, input: unknown): Promise<Workspace> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new AppError("validation", "Check the highlighted fields.", fieldErrors(parsed.error));
  const { name, slug } = parsed.data;
  if (RESERVED.has(slug)) throw new AppError("validation", "That URL is reserved.", { slug: "Reserved." });
  return db.transaction(async (tx) => {
    const ws = await one<Workspace>(
      tx,
      `insert into workspaces (slug, name) values ($1, $2) on conflict (slug) do nothing returning id, slug, name`,
      [slug, name],
    );
    if (!ws) throw new AppError("conflict", "That URL is taken.", { slug: "Already taken." });
    await tx.query(`insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')`, [ws.id, userId]);
    return ws;
  });
}

export async function listWorkspaces(q: Q, userId: string): Promise<(Workspace & { role: Role })[]> {
  return many(
    q,
    `select w.id, w.slug, w.name, m.role
       from memberships m join workspaces w on w.id = m.workspace_id
      where m.user_id = $1 order by w.name`,
    [userId],
  );
}

/**
 * Resolves a workspace by slug for a user. Non-members get `not_found`, not
 * `forbidden`, so slugs of private workspaces cannot be probed.
 */
export async function requireMembership(q: Q, userId: string, slug: string, min: Role = "member"): Promise<Membership> {
  const row = await one<Workspace & { role: Role }>(
    q,
    `select w.id, w.slug, w.name, m.role
       from workspaces w join memberships m on m.workspace_id = w.id and m.user_id = $1
      where w.slug = $2`,
    [userId, slug],
  );
  if (!row) throw new AppError("not_found", "Workspace not found.");
  if (!atLeast(row.role, min)) throw new AppError("forbidden", `Only a workspace ${min} can do that.`);
  return { workspace: { id: row.id, slug: row.slug, name: row.name }, role: row.role };
}

export type Member = { userId: string; name: string; email: string; role: Role };

export async function listMembers(q: Q, workspaceId: string): Promise<Member[]> {
  return many(
    q,
    `select u.id as "userId", u.name, u.email, m.role
       from memberships m join users u on u.id = m.user_id
      where m.workspace_id = $1
      order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, u.name`,
    [workspaceId],
  );
}

const inviteSchema = z.object({ role: z.enum(["member", "admin"]) });

/** Creates a single-use invite. Only the hash is stored; the raw token is returned once. */
export async function createInvite(
  q: Q,
  actor: Membership,
  actorId: string,
  input: unknown,
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  if (!atLeast(actor.role, "admin")) throw new AppError("forbidden", "Only admins can invite people.");
  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success) throw new AppError("validation", "Pick a role.");
  // Admins may invite admins; only owners can create owners (via role change).
  const token = newToken();
  const expiresAt = new Date(now.getTime() + INVITE_DAYS * 86_400_000);
  await q.query(
    `insert into invites (token_hash, workspace_id, role, created_by, expires_at) values ($1, $2, $3, $4, $5)`,
    [sha256(token), actor.workspace.id, parsed.data.role, actorId, expiresAt],
  );
  return { token, expiresAt };
}

export type InvitePreview = { workspaceName: string; role: Role; status: "valid" | "used" | "expired" };

export async function previewInvite(q: Q, token: string, now = new Date()): Promise<InvitePreview | null> {
  const row = await one<{ name: string; role: Role; used_at: Date | null; expires_at: Date }>(
    q,
    `select w.name, i.role, i.used_at, i.expires_at
       from invites i join workspaces w on w.id = i.workspace_id where i.token_hash = $1`,
    [sha256(token)],
  );
  if (!row) return null;
  const status = row.used_at ? "used" : row.expires_at <= now ? "expired" : "valid";
  return { workspaceName: row.name, role: row.role, status };
}

/**
 * Accepts an invite in one transaction. The `used_at is null` guard on the
 * UPDATE makes the token single-use even if two requests race. Accepting an
 * invite never lowers an existing member's role.
 */
export async function acceptInvite(db: Db, userId: string, token: string, now = new Date()): Promise<Workspace> {
  return db.transaction(async (tx) => {
    const inv = await one<{ workspace_id: string; role: Role }>(
      tx,
      `update invites set used_by = $2, used_at = $3
        where token_hash = $1 and used_at is null and expires_at > $3
        returning workspace_id, role`,
      [sha256(token), userId, now],
    );
    if (!inv) throw new AppError("not_found", "This invite link is invalid, expired or already used.");
    await tx.query(
      `insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)
       on conflict (workspace_id, user_id) do update
         set role = case when array_position(array['member','admin','owner'], excluded.role)
                            > array_position(array['member','admin','owner'], memberships.role)
                         then excluded.role else memberships.role end`,
      [inv.workspace_id, userId, inv.role],
    );
    const ws = await one<Workspace>(tx, `select id, slug, name from workspaces where id = $1`, [inv.workspace_id]);
    return ws!;
  });
}

const roleSchema = z.object({ userId: z.uuid(), role: z.enum(ROLES) });

/**
 * Owners can set any role. Admins can only move people between member and
 * admin, and cannot touch owners. The last owner can never be demoted.
 */
export async function changeRole(db: Db, actor: Membership, input: unknown): Promise<void> {
  const parsed = roleSchema.safeParse(input);
  if (!parsed.success) throw new AppError("validation", "Invalid role change.");
  const { userId, role } = parsed.data;
  if (!atLeast(actor.role, "admin")) throw new AppError("forbidden", "Only admins can change roles.");
  await db.transaction(async (tx) => {
    const target = await one<{ role: Role }>(
      tx,
      `select role from memberships where workspace_id = $1 and user_id = $2 for update`,
      [actor.workspace.id, userId],
    );
    if (!target) throw new AppError("not_found", "That person is not in this workspace.");
    if (actor.role !== "owner" && (target.role === "owner" || role === "owner")) {
      throw new AppError("forbidden", "Only an owner can change owners.");
    }
    if (target.role === "owner" && role !== "owner") await assertAnotherOwner(tx, actor.workspace.id, userId);
    await tx.query(`update memberships set role = $3 where workspace_id = $1 and user_id = $2`, [
      actor.workspace.id,
      userId,
      role,
    ]);
  });
}

/** Removes a member (or lets a member leave). Same owner rules as changeRole. */
export async function removeMember(db: Db, actor: Membership, actorId: string, userId: string): Promise<void> {
  const self = userId === actorId;
  if (!self && !atLeast(actor.role, "admin")) throw new AppError("forbidden", "Only admins can remove people.");
  await db.transaction(async (tx) => {
    const target = await one<{ role: Role }>(
      tx,
      `select role from memberships where workspace_id = $1 and user_id = $2 for update`,
      [actor.workspace.id, userId],
    );
    if (!target) throw new AppError("not_found", "That person is not in this workspace.");
    if (!self && target.role === "owner" && actor.role !== "owner") {
      throw new AppError("forbidden", "Only an owner can remove an owner.");
    }
    if (target.role === "owner") await assertAnotherOwner(tx, actor.workspace.id, userId);
    await tx.query(`delete from memberships where workspace_id = $1 and user_id = $2`, [actor.workspace.id, userId]);
  });
}

async function assertAnotherOwner(tx: Q, workspaceId: string, exceptUserId: string) {
  const others = await one<{ n: number }>(
    tx,
    `select count(*)::int as n from memberships where workspace_id = $1 and role = 'owner' and user_id <> $2`,
    [workspaceId, exceptUserId],
  );
  if (!others?.n) throw new AppError("conflict", "A workspace needs at least one owner. Promote someone else first.");
}
