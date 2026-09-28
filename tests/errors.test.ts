import { describe, expect, it } from 'vitest';
import { httpStatus, isBlackboardAuthText, isGoogleAuthError } from '../src/errors.js';

describe('error classification', () => {
  it('recognizes blackboard-mcp auth errors', () => {
    expect(isBlackboardAuthText('BLACKBOARD_SESSION_EXPIRED: The Blackboard sign-in has expired.')).toBe(true);
    expect(isBlackboardAuthText('NOT_LOGGED_IN: Not signed in to Blackboard yet.')).toBe(true);
    expect(isBlackboardAuthText('BLACKBOARD_REQUEST_FAILED: timeout')).toBe(false);
  });

  it('recognizes Google auth errors in their various shapes', () => {
    expect(isGoogleAuthError({ response: { status: 400, data: { error: 'invalid_grant' } } })).toBe(true);
    expect(isGoogleAuthError(new Error('invalid_grant: Token has been expired or revoked.'))).toBe(true);
    expect(isGoogleAuthError({ code: 401, message: 'Invalid Credentials' })).toBe(true);
    expect(isGoogleAuthError({ code: 409, message: 'The requested identifier already exists.' })).toBe(false);
  });

  it('extracts HTTP status', () => {
    expect(httpStatus({ code: 409 })).toBe(409);
    expect(httpStatus({ response: { status: 404 } })).toBe(404);
    expect(httpStatus({ code: '410' })).toBe(410);
    expect(httpStatus(new Error('x'))).toBeUndefined();
  });
});
