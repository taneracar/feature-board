"use client";

import { useOptimistic, useState, useTransition } from "react";
import { voteAction } from "@/app/actions";

/**
 * Optimistic vote. The UI flips at once; the server action sends the wanted
 * state (not "toggle"), so a retry or double click cannot double count, and
 * the optimistic value falls back to the server's answer when the transition
 * ends, including on failure.
 */
export function VoteButton({
  slug,
  requestId,
  votes,
  voted,
  closed,
  title,
}: {
  slug: string;
  requestId: string;
  votes: number;
  voted: boolean;
  closed: boolean;
  title: string;
}) {
  const [optimistic, setOptimistic] = useOptimistic({ votes, voted });
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const disabled = pending || (closed && !optimistic.voted);

  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        className={`btn h-16 w-14 flex-col gap-0 px-0 ${optimistic.voted ? "btn-primary" : ""}`}
        aria-pressed={optimistic.voted}
        aria-label={`${optimistic.voted ? "Remove vote from" : "Vote for"} ${title}. ${optimistic.votes} votes.`}
        disabled={disabled}
        onClick={() => {
          const wanted = !optimistic.voted;
          setError(null);
          startTransition(async () => {
            setOptimistic({ votes: optimistic.votes + (wanted ? 1 : -1), voted: wanted });
            const res = await voteAction(slug, requestId, wanted);
            if (!res.ok) setError(res.message);
          });
        }}
      >
        <span aria-hidden="true">▲</span>
        <span className="text-base font-semibold tabular-nums">{optimistic.votes}</span>
      </button>
      {error && (
        <p role="alert" className="mt-1 max-w-28 text-center text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
