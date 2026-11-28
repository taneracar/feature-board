import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { signInAction } from "@/app/actions";
import { AuthForm } from "@/components/forms";
import { safeNext } from "@/server/core/validation";
import { getCurrentUser } from "@/server/session";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <div className="mx-auto max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <Suspense fallback={<div className="card h-64" aria-busy="true" />}>
        <LoginBody searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function LoginBody({ searchParams }: Pick<PageProps<"/login">, "searchParams">) {
  const next = safeNext((await searchParams).next);
  if (await getCurrentUser()) redirect(next);
  return (
    <>
      <AuthForm action={signInAction} mode="signin" next={next} />
      <p className="text-sm text-muted">
        New here?{" "}
        <Link className="link" href={`/signup?next=${encodeURIComponent(next)}`}>
          Create an account
        </Link>
      </p>
    </>
  );
}
