// Structured tool failures. These codes are a connector contract so a caller can
// tell a hung connect from a dead session, a cancel, or an account that is
// already signed in. They are not a diagnosis of any host-side timeout.

export const CONNECT_TIMEOUT_MS = 20_000;

export type ToolCode =
  | "timeout"
  | "auth_invalid"
  | "cancelled"
  | "already_authorized"
  | "session_password_needed"
  | "not_authorized"
  | "auth_key_duplicated"
  | "error";

export class ToolFailure extends Error {
  readonly code: ToolCode;

  constructor(code: ToolCode, message: string) {
    super(message);
    this.name = "ToolFailure";
    this.code = code;
  }
}

const AUTH_INVALID_MARKERS = [
  "AUTH_KEY_UNREGISTERED",
  "AUTH_KEY_INVALID",
  "AUTH_KEY_PERM_EMPTY",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "USER_DEACTIVATED",
  "USER_DEACTIVATED_BAN",
];

function rawErrorText(err: unknown): string {
  const e = err as { errorMessage?: string; message?: string };
  return `${e?.errorMessage ?? ""} ${e?.message ?? ""}`;
}

export function toolCodeOf(err: unknown): ToolCode {
  if (err instanceof ToolFailure) return err.code;
  const raw = rawErrorText(err);
  if (raw.includes("SESSION_PASSWORD_NEEDED")) return "session_password_needed";
  if (raw.includes("AUTH_KEY_DUPLICATED")) return "auth_key_duplicated";
  if (AUTH_INVALID_MARKERS.some((marker) => raw.includes(marker))) return "auth_invalid";
  return "error";
}
