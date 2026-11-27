import Link from "next/link";

// Fully static: no session read, so it prerenders into the static shell.
export default function Home() {
  return (
    <div className="space-y-6 py-6">
      <h1 className="text-3xl font-semibold tracking-tight">Let your team vote on what to build next.</h1>
      <p className="max-w-prose text-muted">
        Feature Board is a small SaaS: each workspace has its own private board, members post requests and
        vote, and admins move them through planned, in progress and done. Invite people with a single-use
        link.
      </p>
      <div className="flex flex-wrap gap-3">
        <Link href="/signup" className="btn btn-primary">
          Create an account
        </Link>
        <Link href="/workspaces" className="btn">
          Go to my workspaces
        </Link>
      </div>
    </div>
  );
}
