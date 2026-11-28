"use server";

// Every Server Action is a public POST endpoint. Each one below re-reads the
// session, re-checks membership and role through the core layer, and
// validates input there; nothing relies on what the UI chose to render.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { signIn, signUp } from "@/server/core/accounts";
import { AppError } from "@/server/core/errors";
import { createRequest, deleteRequest, setStatus, setVote } from "@/server/core/requests";
import { safeNext } from "@/server/core/validation";
import {
  acceptInvite,
  changeRole,
  createInvite,
  createWorkspace,
  removeMember,
  requireMembership,
  type Membership,
} from "@/server/core/workspaces";
import { getDb } from "@/server/db-instance";
import { errorState, text, type FormState } from "@/server/form-state";
import { endSession, getCurrentUser, startSession } from "@/server/session";

async function member(slug: unknown, min: "member" | "admin" = "member"): Promise<{ userId: string; m: Membership }> {
  const user = await getCurrentUser();
  if (!user) throw new AppError("unauthenticated", "Your session has ended. Sign in again.");
  if (typeof slug !== "string") throw new AppError("not_found", "Workspace not found.");
  return { userId: user.id, m: await requireMembership(await getDb(), user.id, slug, min) };
}

// ---------- auth ----------

export async function signUpAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = text(fd, "email", "name");
  try {
    const user = await signUp(await getDb(), { ...values, password: fd.get("password") });
    await startSession(user.id);
  } catch (e) {
    return errorState(e, values);
  }
  redirect(safeNext(fd.get("next")));
}

export async function signInAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = text(fd, "email");
  try {
    const user = await signIn(await getDb(), { email: values.email, password: fd.get("password") });
    await startSession(user.id);
  } catch (e) {
    return errorState(e, values);
  }
  redirect(safeNext(fd.get("next")));
}

export async function signOutAction(): Promise<void> {
  await endSession();
  redirect("/");
}

// ---------- workspaces ----------

export async function createWorkspaceAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = text(fd, "name", "slug");
  let slug: string;
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("unauthenticated", "Your session has ended. Sign in again.");
    slug = (await createWorkspace(await getDb(), user.id, values)).slug;
  } catch (e) {
    return errorState(e, values);
  }
  redirect(`/w/${slug}`);
}

export async function createInviteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { userId, m } = await member(fd.get("slug"), "admin");
    const { token, expiresAt } = await createInvite(await getDb(), m, userId, { role: fd.get("role") });
    return {
      status: "ok",
      nonce: Date.now(),
      // Only a path: the client builds the absolute URL from its own origin,
      // so a spoofed Host header cannot poison the link.
      data: { path: `/invite/${token}`, expires: expiresAt.toISOString() },
    };
  } catch (e) {
    return errorState(e);
  }
}

export async function acceptInviteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  let slug: string;
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("unauthenticated", "Sign in to accept this invite.");
    slug = (await acceptInvite(await getDb(), user.id, String(fd.get("token") ?? ""))).slug;
  } catch (e) {
    return errorState(e);
  }
  redirect(`/w/${slug}`);
}

export async function changeRoleAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { m } = await member(fd.get("slug"), "admin");
    await changeRole(await getDb(), m, { userId: fd.get("userId"), role: fd.get("role") });
    revalidatePath(`/w/${m.workspace.slug}/members`);
    return { status: "ok", message: "Role updated.", nonce: Date.now() };
  } catch (e) {
    return errorState(e);
  }
}

export async function removeMemberAction(_prev: FormState, fd: FormData): Promise<FormState> {
  let left = false;
  let slug = "";
  try {
    const { userId, m } = await member(fd.get("slug"));
    const target = String(fd.get("userId") ?? "");
    await removeMember(await getDb(), m, userId, target);
    left = target === userId;
    slug = m.workspace.slug;
  } catch (e) {
    return errorState(e);
  }
  if (left) redirect("/workspaces");
  revalidatePath(`/w/${slug}/members`);
  return { status: "ok", message: "Removed.", nonce: Date.now() };
}

// ---------- requests ----------

export async function createRequestAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = text(fd, "title", "body");
  try {
    const { userId, m } = await member(fd.get("slug"));
    await createRequest(await getDb(), m, userId, values);
    revalidatePath(`/w/${m.workspace.slug}`);
    return { status: "ok", message: "Request posted.", nonce: Date.now() };
  } catch (e) {
    return errorState(e, values);
  }
}

export type VoteResult = { ok: true; votes: number; viewerVoted: boolean } | { ok: false; message: string };

/** Called from the optimistic vote button. `wanted` is the target state, so retries are safe. */
export async function voteAction(slug: string, requestId: string, wanted: boolean): Promise<VoteResult> {
  try {
    const { userId, m } = await member(slug);
    const res = await setVote(await getDb(), m, userId, requestId, wanted === true);
    revalidatePath(`/w/${m.workspace.slug}`);
    return { ok: true, ...res };
  } catch (e) {
    return { ok: false, message: errorState(e).message ?? "Vote failed." };
  }
}

export async function setStatusAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { m } = await member(fd.get("slug"), "admin");
    await setStatus(await getDb(), m, fd.get("requestId"), fd.get("status"));
    revalidatePath(`/w/${m.workspace.slug}`);
    return { status: "ok", message: "Status updated.", nonce: Date.now() };
  } catch (e) {
    return errorState(e);
  }
}

export async function deleteRequestAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { userId, m } = await member(fd.get("slug"));
    await deleteRequest(await getDb(), m, userId, fd.get("requestId"));
    revalidatePath(`/w/${m.workspace.slug}`);
    return { status: "ok", message: "Deleted.", nonce: Date.now() };
  } catch (e) {
    return errorState(e);
  }
}
