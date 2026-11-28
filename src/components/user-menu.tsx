import Link from "next/link";
import { signOutAction } from "@/app/actions";
import { getCurrentUser } from "@/server/session";

export async function UserMenu() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <nav className="flex items-center gap-2 text-sm">
        <Link href="/login" className="btn">
          Sign in
        </Link>
        <Link href="/signup" className="btn btn-primary">
          Sign up
        </Link>
      </nav>
    );
  }
  return (
    <nav className="flex min-w-0 items-center gap-2 text-sm">
      <Link href="/workspaces" className="truncate text-muted hover:text-text" title={user.email}>
        {user.name}
      </Link>
      <form action={signOutAction}>
        <button className="btn">Sign out</button>
      </form>
    </nav>
  );
}
