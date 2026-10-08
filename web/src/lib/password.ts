/**
 * Minimum length for a new password.
 *
 * Mirrors MIN_PASSWORD_LENGTH in server/src/auth/password.ts. The server is what
 * enforces it; this exists so the forms can word the hint and gate the button
 * without hardcoding the number in four places.
 */
export const MIN_PASSWORD_LENGTH = 8;

export const PASSWORD_HINT = `At least ${MIN_PASSWORD_LENGTH} characters.`;

/** Message shown when a new password is too short, before the request is sent. */
export const PASSWORD_TOO_SHORT = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
