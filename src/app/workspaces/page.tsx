import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { createWorkspaceAction } from "@/app/actions";
import { CreateWorkspaceForm } from "@/components/forms";
import { listWorkspaces } from "@/server/core/workspaces";
import { getDb } from "@/server/db-instance";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Workspaces" };

export default function WorkspacesPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Your workspaces</h1>
      <Suspense fallback={<div className="card h-24" aria-busy="true" />}>
        <WorkspaceList />
      </Suspense>
      <CreateWorkspaceForm action={createWorkspaceAction} />
    </div>
  );
}

async function WorkspaceList() {
  const user = await requireUser("/workspaces");
  const list = await listWorkspaces(await getDb(), user.id);
  if (list.length === 0) {
    return <p className="text-muted">You are not in any workspace yet. Create one below or open an invite link.</p>;
  }
  return (
    <ul className="space-y-2">
      {list.map((w) => (
        <li key={w.id}>
          <Link href={`/w/${w.slug}`} className="card flex items-center justify-between gap-3 hover:border-accent">
            <span className="font-medium">{w.name}</span>
            <span className="text-sm capitalize text-muted">{w.role}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
