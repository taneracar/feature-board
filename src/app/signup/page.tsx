import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { signUpAction } from "@/app/actions";
import { AuthForm } from "@/components/forms";
import { safeNext } from "@/server/core/validation";
import { getCurrentUser } from "@/server/session";

export const metadata: Metadata = { title: "Create account" };

export default function SignupPage({ searchParams }: PageProps<"/signup">) {
  return (
    <div className="mx-auto max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold">Create your account</h1>
      <Suspense fallback={<div className="card h-80" aria-busy="true" />}>
        <SignupBody searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function SignupBody({ searchParams }: Pick<PageProps<"/signup">, "searchParams">) {
  const next = safeNext((await searchParams).next);
  if (await getCurrentUser()) redirect(next);
  return (
    <>
      <AuthForm action={signUpAction} mode="signup" next={next} />
      <p className="text-sm text-muted">
        Already have an account?{" "}
        <Link className="link" href={`/login?next=${encodeURIComponent(next)}`}>
          Sign in
        </Link>
      </p>
    </>
  );
}
