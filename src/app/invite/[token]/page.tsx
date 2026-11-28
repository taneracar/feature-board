import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { acceptInviteAction } from "@/app/actions";
import { MiniForm, Submit } from "@/components/forms";
import { previewInvite } from "@/server/core/workspaces";
import { getDb } from "@/server/db-instance";
import { getCurrentUser } from "@/server/session";

export const metadata: Metadata = { title: "Invite", referrer: "no-referrer" };

export default function InvitePage({ params }: PageProps<"/invite/[token]">) {
  return (
    <div className="mx-auto max-w-md">
      <Suspense fallback={<div className="card h-32" aria-busy="true" />}>
        <Invite params={params} />
      </Suspense>
    </div>
  );
}

async function Invite({ params }: Pick<PageProps<"/invite/[token]">, "params">) {
  const { token } = await params;
  await connection(); // expiry depends on the current time: never prerender it
  const invite = await previewInvite(await getDb(), token);
  if (!invite || invite.status !== "valid") {
    return (
      <div className="card space-y-2">
        <h1 className="text-xl font-semibold">This invite can’t be used</h1>
        <p className="text-muted">
          {invite?.status === "used"
            ? "It has already been used. Invite links work once."
            : invite?.status === "expired"
              ? "It has expired. Ask for a new link."
              : "The link is not valid."}
        </p>
      </div>
    );
  }
  const user = await getCurrentUser();
  const here = `/invite/${token}`;
  return (
    <div className="card space-y-4">
      <h1 className="text-xl font-semibold">Join {invite.workspaceName}</h1>
      <p className="text-muted">You have been invited as {invite.role === "admin" ? "an admin" : "a member"}.</p>
      {user ? (
        <MiniForm action={acceptInviteAction} hidden={{ token }}>
          <Submit>Join as {user.name}</Submit>
        </MiniForm>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Link className="btn btn-primary" href={`/signup?next=${encodeURIComponent(here)}`}>
            Create an account to join
          </Link>
          <Link className="btn" href={`/login?next=${encodeURIComponent(here)}`}>
            I have an account
          </Link>
        </div>
      )}
    </div>
  );
}
