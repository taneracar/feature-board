import { isAppError } from "./core/errors";

/** What every form action returns to `useActionState`. Shaped for the UI, never raw rows. */
export type FormState = {
  status: "idle" | "ok" | "error";
  message?: string;
  fields?: Record<string, string>;
  /** Echo of submitted text values so a failed form keeps what the user typed (never passwords). */
  values?: Record<string, string>;
  /** Changes on every success so client forms can reset themselves. */
  nonce?: number;
  data?: Record<string, string>;
};

export const idle: FormState = { status: "idle" };

export function errorState(e: unknown, values?: Record<string, string>): FormState {
  if (isAppError(e)) return { status: "error", message: e.message, fields: e.fieldErrors, values };
  // Unexpected: log on the server, show nothing internal to the user.
  console.error(e);
  return { status: "error", message: "Something went wrong. Please try again.", values };
}

export function text(fd: FormData, ...keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = fd.get(k);
    out[k] = typeof v === "string" ? v : "";
  }
  return out;
}
