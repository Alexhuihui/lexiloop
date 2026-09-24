/**
 * Structured Compiler JSON logging (spec 13.2).
 *
 * Every line is a single JSON object. Field names are allowlisted: anything
 * outside the list (error messages, raw OCR text, arbitrary payloads) is
 * dropped before serialization, so full source text can never leak. In
 * addition, configured secret values are scrubbed from the final line as a
 * backstop.
 */

export const LOG_FIELDS = [
  "compile_run_id",
  "release_id",
  "unit_key",
  "stage",
  "duration_ms",
  "attempt",
  "retry_count",
  "error_code",
  "input_hash",
  "output_hash",
  "source_hash",
] as const;

export type LogField = (typeof LOG_FIELDS)[number];
export type LogFields = { [K in LogField]?: string | number };

export type LogSink = (line: string) => void;
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const REDACTED = "[REDACTED]";
const JSON_SIGNIFICANT_CHARS = '"\\{}[],:';

/**
 * Secrets containing JSON-significant characters (quotes, backslashes,
 * structural punctuation, control chars) either only appear escaped in the
 * serialized line (quotes/backslashes, so a raw-substring splice would never
 * match anyway) or would corrupt the line's JSON structure when replaced.
 * Scrubbing skips them instead of splice-replacing.
 */
function containsJsonSignificantChars(value: string): boolean {
  for (const ch of value) {
    if (JSON_SIGNIFICANT_CHARS.includes(ch)) return true;
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20) return true; // control characters
  }
  return false;
}

export interface CompilerLogger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface CompilerLoggerOptions {
  sink: LogSink;
  /** Secret values scrubbed from every emitted line. */
  secrets?: readonly string[];
  level?: LogLevel;
}

export function createCompilerLogger(options: CompilerLoggerOptions): CompilerLogger {
  const sink = options.sink;
  const secrets = (options.secrets ?? []).filter(
    (secret) => secret.length > 0 && !containsJsonSignificantChars(secret),
  );
  const minRank = LEVEL_RANK[options.level ?? "debug"];
  const allowlisted = new Set<string>(LOG_FIELDS);

  const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
    if (LEVEL_RANK[level] < minRank) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      event,
    };
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (value === undefined) continue;
      if (allowlisted.has(key)) record[key] = value;
    }
    let line = JSON.stringify(record);
    for (const secret of secrets) {
      if (line.includes(secret)) line = line.split(secret).join(REDACTED);
    }
    sink(line);
  };

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}

/**
 * Default secret source: values of environment variables whose key names look
 * secret-bearing (API keys, tokens, passwords). Only the values are used for
 * scrubbing; keys are never logged.
 */
export function collectEnvSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([key, value]) => value !== undefined && /SECRET|TOKEN|PASSWORD|API_KEY|_KEY|KEY$/i.test(key))
    .map(([, value]) => value as string);
}

/** Logger that discards everything; used when no sink is configured. */
export const silentLogger: CompilerLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
