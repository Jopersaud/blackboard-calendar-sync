/**
 * Failure kinds that change what the menu bar shows. Auth failures are the
 * ones that silently stop syncing forever if nobody notices, so they get a
 * red menu bar state and one OS notification per new occurrence.
 */
export type ErrorKind = 'blackboard_auth' | 'google_auth' | 'config' | 'other';

export class SyncError extends Error {
  readonly kind: ErrorKind;

  constructor(kind: ErrorKind, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'SyncError';
    this.kind = kind;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** blackboard-mcp error codes that mean "the student must sign in again". */
const BLACKBOARD_AUTH_CODES = ['BLACKBOARD_SESSION_EXPIRED', 'NOT_LOGGED_IN'];

export function isBlackboardAuthText(text: string): boolean {
  return (
    BLACKBOARD_AUTH_CODES.some((code) => text.startsWith(code)) ||
    /blackboard (session|sign-in) (has )?expired/i.test(text)
  );
}

/**
 * Whether an error from googleapis means the stored refresh token no longer
 * works (revoked, expired, or the OAuth client was deleted).
 */
export function isGoogleAuthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    message?: unknown;
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown; data?: { error?: unknown } };
  };
  const status = e.response?.status ?? e.status ?? e.code;
  const oauthError = e.response?.data?.error;
  const message = typeof e.message === 'string' ? e.message : '';
  if (oauthError === 'invalid_grant' || oauthError === 'invalid_client' || oauthError === 'unauthorized_client') return true;
  if (/invalid_grant|invalid_client|No refresh token|Token has been expired or revoked/i.test(message)) return true;
  return status === 401 || status === '401';
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Google API errors carry the HTTP status in a few different places. */
export function httpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  for (const v of [e.response?.status, e.status, e.code]) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^\d{3}$/.test(v)) return Number(v);
  }
  return undefined;
}
