/**
 * Structured JSON logging (spec 7.2/8): one JSON line per request with
 * request id, route template, status, duration, release id when known, D1
 * rows read/written, R2 operation count, and a stable error code. Metrics are
 * derived downstream from these events.
 *
 * Redaction (spec 7.2: logs never contain passwords, verifiers, cookies, CSRF
 * tokens, or full textbook content): the entry is deep-walked before
 * serialization; sensitive keys collapse to "[REDACTED]" and long strings
 * (textbook sentences, source text, keys) are truncated. Request log entries
 * are built from fixed safe fields only — redaction is defense in depth for
 * anything handlers attach as details.
 */

export type LogWriter = (line: string) => void;

/** Keys whose values must never appear in logs. */
const SENSITIVE_KEY_PATTERN =
  /pass(word|phrase)?|verifier|salt|secret|token|cookie|csrf|authorization|credential|api[-_]?key|mimo[-_]key|object[-_]?key|set[-_]cookie/i;

/** Strings longer than this are truncated (full textbook content stays out). */
export const MAX_LOGGED_STRING_LENGTH = 256;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function redactString(value: string): string {
  if (value.length <= MAX_LOGGED_STRING_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_LOGGED_STRING_LENGTH)}…[truncated ${value.length - MAX_LOGGED_STRING_LENGTH} chars]`;
}

/** Deep redaction: sensitive keys -> "[REDACTED]", long strings truncated. */
export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redact(item));
  }
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (entry === undefined || typeof entry === "function") {
      continue;
    }
    output[key] = isSensitiveKey(key) ? "[REDACTED]" : redact(entry);
  }
  return output;
}

export type LogLevel = "info" | "warn" | "error";

export interface RequestLogEntry {
  time: number;
  level: LogLevel;
  msg: string;
  request_id: string;
  method: string;
  route: string;
  status: number;
  duration_ms: number;
  release_id?: string;
  d1_rows_read: number;
  d1_rows_written: number;
  r2_operations: number;
  error_code?: string;
  error_type?: string;
}

/**
 * Serializes one entry as a single JSON line. `write` defaults to
 * `console.log` (the Workers-ingested channel); tests capture lines by
 * injecting a writer.
 */
export function writeLogLine(write: LogWriter | undefined, entry: RequestLogEntry): void {
  const line = JSON.stringify(redact(entry));
  if (write) {
    write(line);
  } else {
    console.log(line);
  }
}
