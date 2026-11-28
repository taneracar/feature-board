import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { createRequestAction, deleteRequestAction, setStatusAction } from "@/app/actions";
import { MiniForm, NewRequestForm, Submit } from "@/components/forms";
import { VoteButton } from "@/components/vote-button";
import { listQuerySchema, listRequests, STATUS_LABEL, STATUSES, type ListQuery } from "@/server/core/requests";
import { atLeast } from "@/server/core/workspaces";
import { getDb } from "@/server/db-instance";
import { requireWorkspacePage } from "@/server/session";

export const metadata: Metadata = { title: "Board" };

export default function BoardPage({ params, searchParams }: PageProps<"/w/[slug]">) {
  return (
    <Suspense fallback={<BoardSkeleton />}>
      <Board params={params} searchParams={searchParams} />
    </Suspense>
  );
}

function BoardSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="h-8 w-48 rounded bg-line" />
      <div className="card h-40" />
      <div className="card h-24" />
    </div>
  );
}

const FILTERS: { value: ListQuery["status"]; label: string }[] = [
  { value: "active", label: "Active" },
  ...STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
  { value: "all", label: "All" },
];

async function Board({ params, searchParams }: PageProps<"/w/[slug]">) {
  const { slug } = await params;
  const query = listQuerySchema.parse(await searchParams);
  const { user, m } = await requireWorkspacePage(slug);
  const rows = await listRequests(await getDb(), m, user.id, query);
  const isAdmin = atLeast(m.role, "admin");
  const href = (q: Partial<ListQuery>) => `/w/${slug}?${new URLSearchParams({ ...query, ...q })}`;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{m.workspace.name}</h1>
        <nav className="flex gap-3 text-sm">
          <Link className="link" href={`/w/${slug}/members`}>
            Members
          </Link>
          <Link className="link" href="/workspaces">
            All workspaces
          </Link>
        </nav>
      </div>

      <NewRequestForm action={createRequestAction} slug={slug} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm" aria-label="Filters">
        <span className="text-muted">Sort:</span>
        {(["top", "new"] as const).map((s) => (
          <Link key={s} href={href({ sort: s })} aria-current={query.sort === s ? "page" : undefined}
            className={query.sort === s ? "font-semibold" : "link"}>
            {s === "top" ? "Most votes" : "Newest"}
          </Link>
        ))}
        <label className="flex items-center gap-2">
          <span className="text-muted">Show:</span>
          <StatusFilter slug={slug} current={query.status} sort={query.sort} />
        </label>
      </div>

      {rows.length === 0 ? (
        <p className="card text-muted">No requests here yet.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => {
            const closed = r.status === "done" || r.status === "declined";
            const canDelete = isAdmin || r.authorId === user.id;
            return (
              <li key={r.id} className="card flex gap-3" data-testid="request">
                <VoteButton slug={slug} requestId={r.id} votes={r.votes} voted={r.viewerVoted} closed={closed} title={r.title} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-medium break-words">{r.title}</h2>
                    <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">
                      {STATUS_LABEL[r.status]}
                    </span>
                  </div>
                  {r.body && <p className="whitespace-pre-line break-words text-sm text-muted">{r.body}</p>}
                  <p className="text-xs text-muted">by {r.authorName ?? "a former member"}</p>
                  {(isAdmin || canDelete) && (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {isAdmin && (
                        <MiniForm action={setStatusAction} hidden={{ slug, requestId: r.id }}>
                          <label className="sr-only" htmlFor={`status-${r.id}`}>
                            Status for {r.title}
                          </label>
                          <select id={`status-${r.id}`} name="status" defaultValue={r.status} className="input w-auto py-1 text-sm">
                            {STATUSES.map((s) => (
                              <option key={s} value={s}>
                                {STATUS_LABEL[s]}
                              </option>
                            ))}
                          </select>
                          <Submit className="btn">Set status</Submit>
                        </MiniForm>
                      )}
                      {canDelete && (
                        <MiniForm action={deleteRequestAction} hidden={{ slug, requestId: r.id }}
                          confirm={`Delete "${r.title}"?`}>
                          <Submit className="btn btn-danger">Delete</Submit>
                        </MiniForm>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** A plain GET form, so filtering works without JavaScript and is shareable as a URL. */
function StatusFilter({ slug, current, sort }: { slug: string; current: string; sort: string }) {
  return (
    <form action={`/w/${slug}`} className="flex items-center gap-2">
      <input type="hidden" name="sort" value={sort} />
      <select name="status" defaultValue={current} className="input w-auto py-1 text-sm" aria-label="Status filter">
        {FILTERS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      <button className="btn py-1">Apply</button>
    </form>
  );
}
