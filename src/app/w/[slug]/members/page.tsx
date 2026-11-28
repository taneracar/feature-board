import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { changeRoleAction, createInviteAction, removeMemberAction } from "@/app/actions";
import { InviteForm, MiniForm, Submit } from "@/components/forms";
import { atLeast, listMembers, ROLES } from "@/server/core/workspaces";
import { getDb } from "@/server/db-instance";
import { requireWorkspacePage } from "@/server/session";

export const metadata: Metadata = { title: "Members" };

export default function MembersPage({ params }: PageProps<"/w/[slug]/members">) {
  return (
    <Suspense fallback={<div className="card h-40" aria-busy="true" />}>
      <Members params={params} />
    </Suspense>
  );
}

async function Members({ params }: Pick<PageProps<"/w/[slug]/members">, "params">) {
  const { slug } = await params;
  const { user, m } = await requireWorkspacePage(slug);
  const members = await listMembers(await getDb(), m.workspace.id);
  const isAdmin = atLeast(m.role, "admin");
  const isOwner = m.role === "owner";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{m.workspace.name}: members</h1>
        <Link className="link text-sm" href={`/w/${slug}`}>
          Back to board
        </Link>
      </div>

      {isAdmin && <InviteForm action={createInviteAction} slug={slug} />}

      <ul className="space-y-2">
        {members.map((p) => {
          const self = p.userId === user.id;
          // Mirrors the server rules for display only; the actions re-check.
          const canEditRole = isAdmin && !self && (isOwner || p.role !== "owner");
          const canRemove = self || (isAdmin && (isOwner || p.role !== "owner"));
          return (
            <li key={p.userId} className="card flex flex-wrap items-center justify-between gap-3" data-testid="member">
              <div className="min-w-0">
                <p className="font-medium">
                  {p.name} {self && <span className="text-sm text-muted">(you)</span>}
                </p>
                <p className="truncate text-sm text-muted">{p.email}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {canEditRole ? (
                  <MiniForm action={changeRoleAction} hidden={{ slug, userId: p.userId }}>
                    <label className="sr-only" htmlFor={`role-${p.userId}`}>
                      Role for {p.name}
                    </label>
                    <select id={`role-${p.userId}`} name="role" defaultValue={p.role} className="input w-auto py-1 text-sm">
                      {ROLES.filter((r) => isOwner || r !== "owner").map((r) => (
                        <option key={r} value={r} className="capitalize">
                          {r}
                        </option>
                      ))}
                    </select>
                    <Submit className="btn">Save role</Submit>
                  </MiniForm>
                ) : (
                  <span className="text-sm capitalize text-muted">{p.role}</span>
                )}
                {canRemove && (
                  <MiniForm action={removeMemberAction} hidden={{ slug, userId: p.userId }}
                    confirm={self ? "Leave this workspace?" : `Remove ${p.name}?`}>
                    <Submit className="btn btn-danger">{self ? "Leave" : "Remove"}</Submit>
                  </MiniForm>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
