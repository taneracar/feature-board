import Link from "next/link";

export default function NotFound() {
  return (
    <div className="card space-y-2">
      <h1 className="text-xl font-semibold">Not found</h1>
      <p className="text-muted">This page does not exist, or you do not have access to it.</p>
      <Link className="link" href="/workspaces">
        Go to your workspaces
      </Link>
    </div>
  );
}
