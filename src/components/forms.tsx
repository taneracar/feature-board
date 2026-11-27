"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import type { FormState } from "@/server/form-state";

type Action = (prev: FormState, fd: FormData) => Promise<FormState>;
const idle: FormState = { status: "idle" };

export function Submit({ children, className = "btn btn-primary" }: { children: React.ReactNode; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button className={className} disabled={pending} aria-disabled={pending}>
      {pending ? "Working…" : children}
    </button>
  );
}

export function Field({
  name,
  label,
  state,
  type = "text",
  multiline,
  hint,
  ...rest
}: {
  name: string;
  label: string;
  state: FormState;
  type?: string;
  multiline?: boolean;
  hint?: string;
  ref?: React.Ref<HTMLInputElement>;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "name" | "type">) {
  const id = useId();
  const error = state.fields?.[name];
  const describedBy = [error ? `${id}-err` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined;
  const common = {
    id,
    name,
    className: "input",
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    // Keep what the user typed after a failed submit (React resets forms after actions).
    defaultValue: type === "password" ? undefined : (state.values?.[name] ?? (rest.defaultValue as string)),
  };
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      {multiline ? (
        <textarea {...common} rows={3} maxLength={rest.maxLength} placeholder={rest.placeholder} />
      ) : (
        <input {...rest} {...common} type={type} />
      )}
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-sm text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function FormMessage({ state }: { state: FormState }) {
  if (state.status === "idle" || !state.message) return <div role="status" aria-live="polite" />;
  return (
    <div role={state.status === "error" ? "alert" : "status"} aria-live="polite"
      className={`text-sm ${state.status === "error" ? "text-danger" : "text-ok"}`}>
      {state.message}
    </div>
  );
}

export function AuthForm({ action, mode, next }: { action: Action; mode: "signin" | "signup"; next?: string }) {
  const [state, formAction] = useActionState(action, idle);
  return (
    <form action={formAction} className="card space-y-4" noValidate>
      {next && <input type="hidden" name="next" value={next} />}
      {mode === "signup" && <Field name="name" label="Name" state={state} autoComplete="name" required />}
      <Field name="email" label="Email" type="email" state={state} autoComplete="email" required />
      <Field
        name="password"
        label="Password"
        type="password"
        state={state}
        autoComplete={mode === "signup" ? "new-password" : "current-password"}
        hint={mode === "signup" ? "At least 10 characters." : undefined}
        required
      />
      <FormMessage state={state} />
      <Submit>{mode === "signup" ? "Create account" : "Sign in"}</Submit>
    </form>
  );
}

export function CreateWorkspaceForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState(action, idle);
  const [slugEdited, setSlugEdited] = useState(false);
  const slugRef = useRef<HTMLInputElement>(null);
  return (
    <form action={formAction} className="card space-y-4" noValidate>
      <h2 className="font-semibold">New workspace</h2>
      <Field
        name="name"
        label="Workspace name"
        state={state}
        required
        onChange={(e) => {
          if (!slugEdited && slugRef.current) {
            slugRef.current.value = e.currentTarget.value
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "")
              .slice(0, 40);
          }
        }}
      />
      <Field
        name="slug"
        label="URL"
        state={state}
        hint="Letters, numbers and dashes. Used in /w/your-url."
        ref={slugRef}
        onInput={() => setSlugEdited(true)}
        required
      />
      <FormMessage state={state} />
      <Submit>Create workspace</Submit>
    </form>
  );
}

export function NewRequestForm({ action, slug }: { action: Action; slug: string }) {
  const [state, formAction] = useActionState(action, idle);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.status === "ok") ref.current?.reset();
  }, [state.nonce, state.status]);
  return (
    <form ref={ref} action={formAction} className="card space-y-3" noValidate>
      <input type="hidden" name="slug" value={slug} />
      <Field name="title" label="What should we build?" state={state} maxLength={120} required />
      <Field name="body" label="Details (optional)" state={state} multiline maxLength={2000} />
      <div className="flex items-center justify-between gap-3">
        <FormMessage state={state} />
        <Submit>Post request</Submit>
      </div>
    </form>
  );
}

/** A one-button form for small mutations (status, role, delete) that shows its own error. */
export function MiniForm({
  action,
  hidden,
  children,
  className = "flex flex-wrap items-center gap-2",
  confirm,
}: {
  action: Action;
  hidden: Record<string, string>;
  children: React.ReactNode;
  className?: string;
  confirm?: string;
}) {
  const [state, formAction] = useActionState(action, idle);
  return (
    <form
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {children}
      {state.status === "error" && (
        <p role="alert" className="w-full text-sm text-danger">
          {state.message}
        </p>
      )}
    </form>
  );
}

export function InviteForm({ action, slug }: { action: Action; slug: string }) {
  const [state, formAction] = useActionState(action, idle);
  // Remember which invite was copied, so a new invite shows "Copy" again.
  const [copiedFor, setCopiedFor] = useState<number | undefined>();
  const copied = copiedFor !== undefined && copiedFor === state.nonce;
  const link = state.data?.path && typeof window !== "undefined" ? window.location.origin + state.data.path : "";
  return (
    <form action={formAction} className="card space-y-3">
      <h2 className="font-semibold">Invite someone</h2>
      <input type="hidden" name="slug" value={slug} />
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="invite-role" className="label">
            Role
          </label>
          <select id="invite-role" name="role" className="input" defaultValue="member">
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <Submit>Create invite link</Submit>
      </div>
      <FormMessage state={state} />
      {link && (
        <div className="space-y-2">
          <label htmlFor="invite-link" className="label">
            Single-use link, valid 7 days. It is shown only once.
          </label>
          <div className="flex gap-2">
            <input id="invite-link" readOnly value={link} className="input font-mono text-sm" />
            <button
              type="button"
              className="btn"
              onClick={async () => {
                await navigator.clipboard?.writeText(link);
                setCopiedFor(state.nonce);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
