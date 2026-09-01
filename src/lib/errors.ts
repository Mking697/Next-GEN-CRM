/**
 * Errors that server actions are allowed to show to a user verbatim.
 *
 * Anything that is NOT an AppError is treated as a bug: it gets logged with a
 * reference id and the user is shown a generic message, so a stack trace or a
 * database detail never leaks into the UI.
 */

export class AppError extends Error {
  readonly code: string;
  /** Optional per-field messages for form rendering. */
  readonly fieldErrors?: Record<string, string>;

  constructor(
    message: string,
    code = "APP_ERROR",
    fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

/** Bad input from a form. */
export class ValidationError extends AppError {
  constructor(message: string, fieldErrors?: Record<string, string>) {
    super(message, "VALIDATION", fieldErrors);
    this.name = "ValidationError";
  }
}

/** Somebody else got there first, or the state moved under us. */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, "CONFLICT");
    this.name = "ConflictError";
  }
}

/** The row does not exist, or is outside this user's scope. Same message for
 *  both on purpose: a salesman must not be able to probe for lead ids. */
export class NotFoundError extends AppError {
  constructor(what = "That record") {
    super(`${what} was not found, or you do not have access to it.`, "NOT_FOUND");
    this.name = "NotFoundError";
  }
}

/** Not signed in. */
export class UnauthenticatedError extends AppError {
  constructor() {
    super("You are not signed in.", "UNAUTHENTICATED");
    this.name = "UnauthenticatedError";
  }
}

/** Rate limited. */
export class TooManyRequestsError extends AppError {
  readonly retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number) {
    super(message, "RATE_LIMITED");
    this.name = "TooManyRequestsError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// ---------------------------------------------------------------------------
// Action results
// ---------------------------------------------------------------------------

export type ActionResult<T = undefined> =
  | { ok: true; data: T; message?: string }
  | { ok: false; error: string; code: string; fieldErrors?: Record<string, string> };

export function ok<T>(data: T, message?: string): ActionResult<T> {
  return { ok: true, data, message };
}

export function fail(
  error: string,
  code = "APP_ERROR",
  fieldErrors?: Record<string, string>,
): ActionResult<never> {
  return { ok: false, error, code, fieldErrors };
}

/**
 * Wrap a server action body. Known AppErrors reach the user with their real
 * message; anything else is logged and replaced with a reference id.
 */
export async function actionGuard<T>(
  run: () => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  try {
    return await run();
  } catch (error) {
    // A redirect() or notFound() inside an action throws a control-flow error
    // that Next must be allowed to handle. Never swallow it.
    if (isNextControlFlow(error)) throw error;

    if (error instanceof AppError) {
      return { ok: false, error: error.message, code: error.code, fieldErrors: error.fieldErrors };
    }
    if (error instanceof Error && error.name === "AuthorizationError") {
      return { ok: false, error: error.message, code: "FORBIDDEN" };
    }

    const ref = Math.random().toString(36).slice(2, 10);
    console.error(`[action:${ref}]`, error);
    return {
      ok: false,
      error: `Something went wrong. Reference ${ref}.`,
      code: "INTERNAL",
    };
  }
}

function isNextControlFlow(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const digest = (error as { digest?: unknown }).digest;
  return (
    typeof digest === "string" &&
    (digest.startsWith("NEXT_REDIRECT") || digest === "NEXT_NOT_FOUND")
  );
}
