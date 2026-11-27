import { z } from "zod";
import { many, one, type Q } from "./db";
import { AppError } from "./errors";
import { fieldErrors } from "./validation";
import { atLeast, type Membership } from "./workspaces";

export const STATUSES = ["open", "planned", "in_progress", "done", "declined"] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<Status, string> = {
  open: "Open",
  planned: "Planned",
  in_progress: "In progress",
  done: "Done",
  declined: "Declined",
};

export type RequestRow = {
  id: string;
  title: string;
  body: string;
  status: Status;
  authorName: string | null;
  authorId: string | null;
  votes: number;
  viewerVoted: boolean;
  createdAt: Date;
};

const createSchema = z.object({
  title: z.string().trim().min(3, "Use at least 3 characters.").max(120, "Keep the title under 120 characters."),
  body: z.string().trim().max(2000, "Keep the details under 2000 characters.").default(""),
});

export async function createRequest(q: Q, m: Membership, userId: string, input: unknown): Promise<{ id: string }> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new AppError("validation", "Check the highlighted fields.", fieldErrors(parsed.error));
  const row = await one<{ id: string }>(
    q,
    `insert into requests (workspace_id, author_id, title, body) values ($1, $2, $3, $4) returning id`,
    [m.workspace.id, userId, parsed.data.title, parsed.data.body],
  );
  // The author's vote is implied: you asked for it, so it counts.
  await q.query(`insert into votes (request_id, user_id) values ($1, $2)`, [row!.id, userId]);
  return row!;
}

export const listQuerySchema = z.object({
  sort: z.enum(["top", "new"]).catch("top"),
  status: z.enum([...STATUSES, "active", "all"]).catch("active"),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export async function listRequests(q: Q, m: Membership, viewerId: string, query: ListQuery): Promise<RequestRow[]> {
  const statusClause =
    query.status === "all"
      ? ""
      : query.status === "active"
        ? `and r.status in ('open', 'planned', 'in_progress')`
        : `and r.status = $3`;
  const order = query.sort === "new" ? "r.seq desc" : "votes desc, r.seq desc";
  const params: unknown[] = [m.workspace.id, viewerId];
  if (statusClause.includes("$3")) params.push(query.status);
  return many<RequestRow>(
    q,
    `select r.id, r.title, r.body, r.status, r.author_id as "authorId", u.name as "authorName",
            r.created_at as "createdAt",
            (select count(*)::int from votes v where v.request_id = r.id) as votes,
            exists(select 1 from votes v where v.request_id = r.id and v.user_id = $2) as "viewerVoted"
       from requests r left join users u on u.id = r.author_id
      where r.workspace_id = $1 ${statusClause}
      order by ${order}
      limit 200`,
    params,
  );
}

/** Loads a request only if it belongs to the caller's workspace (no cross-tenant IDs). */
async function requestInWorkspace(q: Q, m: Membership, requestId: unknown) {
  const id = z.uuid().safeParse(requestId);
  if (!id.success) throw new AppError("not_found", "Request not found.");
  const row = await one<{ id: string; author_id: string | null; status: Status }>(
    q,
    `select id, author_id, status from requests where id = $1 and workspace_id = $2`,
    [id.data, m.workspace.id],
  );
  if (!row) throw new AppError("not_found", "Request not found.");
  return row;
}

/**
 * Sets the vote to the wanted state rather than flipping it, so a retried or
 * double-submitted click is idempotent. Closed requests take no new votes.
 */
export async function setVote(
  q: Q,
  m: Membership,
  userId: string,
  requestId: unknown,
  wanted: boolean,
): Promise<{ votes: number; viewerVoted: boolean }> {
  const req = await requestInWorkspace(q, m, requestId);
  if (wanted) {
    if (req.status === "done" || req.status === "declined") {
      throw new AppError("conflict", "This request is closed.");
    }
    await q.query(`insert into votes (request_id, user_id) values ($1, $2) on conflict do nothing`, [req.id, userId]);
  } else {
    await q.query(`delete from votes where request_id = $1 and user_id = $2`, [req.id, userId]);
  }
  const c = await one<{ n: number }>(q, `select count(*)::int as n from votes where request_id = $1`, [req.id]);
  return { votes: c!.n, viewerVoted: wanted };
}

export async function setStatus(q: Q, m: Membership, requestId: unknown, status: unknown): Promise<void> {
  if (!atLeast(m.role, "admin")) throw new AppError("forbidden", "Only admins can change the status.");
  const s = z.enum(STATUSES).safeParse(status);
  if (!s.success) throw new AppError("validation", "Unknown status.");
  const req = await requestInWorkspace(q, m, requestId);
  await q.query(`update requests set status = $2 where id = $1`, [req.id, s.data]);
}

/** Authors may delete their own request while nobody else has voted; admins always can. */
export async function deleteRequest(q: Q, m: Membership, userId: string, requestId: unknown): Promise<void> {
  const req = await requestInWorkspace(q, m, requestId);
  if (!atLeast(m.role, "admin")) {
    if (req.author_id !== userId) throw new AppError("forbidden", "You can only delete your own requests.");
    const others = await one<{ n: number }>(
      q,
      `select count(*)::int as n from votes where request_id = $1 and user_id <> $2`,
      [req.id, userId],
    );
    if (others!.n > 0) throw new AppError("conflict", "Others have voted on this. Ask an admin to remove it.");
  }
  await q.query(`delete from requests where id = $1`, [req.id]);
}
