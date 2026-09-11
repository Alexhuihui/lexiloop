/**
 * Per-request context and structured request logging at the outer boundary
 * (plan Task 11): request id (propagated from `X-Request-ID` when usable),
 * route template, status, duration, release id when known, D1 rows
 * read/written, R2 operation count, and a stable error code. Metrics are
 * derived from these events, never emitted ad hoc.
 *
 * Also hosts the shared JSON error response ({ code, message, request_id,
 * details? } — spec 8) and the D1/R2 usage instrumentation that feeds the
 * per-request counters from binding result metadata.
 */

import type { Context, MiddlewareHandler } from "hono";
import { randomBytes, toHex } from "../auth/password";
import { redact, writeLogLine, type LogWriter, type LogLevel, type RequestLogEntry } from "./logger";
import type { AppEnv } from "../app";

/** Mutable per-request log context; lives in Hono context variables. */
export interface RequestLogContext {
  requestId: string;
  releaseId?: string;
  d1RowsRead: number;
  d1RowsWritten: number;
  r2Operations: number;
  /** Stable error code (e.g. AUTH_INVALID_CREDENTIALS, INTERNAL). */
  errorCode?: string;
  /** Error class name for unexpected failures; never the raw message. */
  errorType?: string;
}

export interface ManagedRequestContext extends RequestLogContext {
  /** Feeds the counters from instrumented bindings. */
  usage: RequestUsageRecorder;
}

export interface RequestUsageRecorder {
  recordD1Read(rows: number): void;
  recordD1Write(rows: number): void;
  recordR2Operation(): void;
}

export const REQUEST_ID_HEADER = "x-request-id";

/** Printable URL-safe request ids only; anything else gets a fresh one. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function generateRequestId(): string {
  return toHex(randomBytes(16));
}

export function requestIdFrom(rawHeader: string | undefined): string {
  return rawHeader !== undefined && REQUEST_ID_PATTERN.test(rawHeader) ? rawHeader : generateRequestId();
}

function createUsageRecorder(context: RequestLogContext): RequestUsageRecorder {
  return {
    recordD1Read(rows: number) {
      context.d1RowsRead += rows;
    },
    recordD1Write(rows: number) {
      context.d1RowsWritten += rows;
    },
    recordR2Operation() {
      context.r2Operations += 1;
    },
  };
}

export function createRequestLogContext(requestId: string, releaseId?: string): ManagedRequestContext {
  const context: RequestLogContext = {
    requestId,
    d1RowsRead: 0,
    d1RowsWritten: 0,
    r2Operations: 0,
    ...(releaseId !== undefined ? { releaseId } : {}),
  };
  // The recorder mutates this exact object, so counters stay in one place.
  const managed = context as ManagedRequestContext;
  managed.usage = createUsageRecorder(context);
  return managed;
}

/** Route template for logs; falls back to the raw path when unmatched. */
function routeTemplateOf(c: Context<AppEnv>): string {
  try {
    const routePath = c.req.routePath;
    return routePath && routePath !== "*" ? routePath : c.req.path;
  } catch {
    return c.req.path;
  }
}

interface LoggingOptions {
  releaseId?: string;
  logWrite?: LogWriter;
  now?: () => number;
  /**
   * Pre-created per-request context from the production entry point, which
   * must instrument the D1/R2 bindings with the SAME context the request log
   * reports. When absent (tests, scripts) a fresh context is created here.
   */
  requestContext?: ManagedRequestContext;
}

/** Outer-boundary middleware: request id, usage counters, one JSON log line. */
export function requestContextMiddleware(options: LoggingOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = requestIdFrom(c.req.header(REQUEST_ID_HEADER));
    const context = options.requestContext ?? createRequestLogContext(requestId, options.releaseId);
    c.set("requestContext", context);
    c.header(REQUEST_ID_HEADER, context.requestId);

    const start = performance.now();
    await next();

    // Set on the finalized response so the id survives handler-returned
    // Responses (raw Response returns bypass c.header preparation).
    c.res.headers.set(REQUEST_ID_HEADER, context.requestId);

    const status = c.res.status;
    const level: LogLevel = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    const entry: RequestLogEntry = {
      time: options.now?.() ?? Date.now(),
      level,
      msg: "request",
      request_id: context.requestId,
      method: c.req.method,
      route: routeTemplateOf(c),
      status,
      duration_ms: Math.max(0, Math.round(performance.now() - start)),
      d1_rows_read: context.d1RowsRead,
      d1_rows_written: context.d1RowsWritten,
      r2_operations: context.r2Operations,
      ...(context.releaseId !== undefined ? { release_id: context.releaseId } : {}),
      ...(context.errorCode !== undefined ? { error_code: context.errorCode } : {}),
      ...(context.errorType !== undefined ? { error_type: context.errorType } : {}),
    };
    writeLogLine(options.logWrite, entry);
  };
}

/**
 * Uniform error response (spec 8): `{ code, message, request_id, details? }`.
 * Stamps the stable error code into the request context for the log line and
 * disables caching. Details pass through redaction.
 */
export function jsonError(
  c: Context<AppEnv>,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  const context = c.var.requestContext;
  if (context) {
    context.errorCode = code;
  }
  const body: Record<string, unknown> = {
    code,
    message,
    request_id: context?.requestId ?? "",
    ...(details !== undefined ? { details: redact(details) } : {}),
  };
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

// ---------------------------------------------------------------------------
// Binding instrumentation: forward everything, extract D1 result metadata and
// R2 call counts into the per-request usage counters. The Workers entry point
// wraps `env.DB` / `env.AUDIO` with these per request.
// ---------------------------------------------------------------------------

interface D1ResultMeta {
  meta?: { rows_read?: number; rows_written?: number };
}

/**
 * Wraps a D1 binding so every executed statement contributes to the request
 * usage. `run`/`all` extract `meta.rows_read` / `meta.rows_written` from the
 * D1 result; `raw` (the path drizzle's D1 driver uses for SELECTs) carries no
 * metadata, so the number of returned rows is recorded instead — a lower
 * bound on the true rows_read. `first()` is forwarded untouched.
 */
export function instrumentD1(db: D1Database, usage: RequestUsageRecorder): D1Database {
  const recordMeta = (result: unknown): void => {
    const meta = (result as D1ResultMeta | null | undefined)?.meta;
    if (meta) {
      usage.recordD1Read(meta.rows_read ?? 0);
      usage.recordD1Write(meta.rows_written ?? 0);
    }
  };
  const instrumentStatement = (statement: D1PreparedStatement): D1PreparedStatement => {
    const instrumented = {
      bind: (...values: Parameters<D1PreparedStatement["bind"]>) => instrumentStatement(statement.bind(...values)),
      run: async () => {
        const result = await statement.run();
        recordMeta(result);
        return result;
      },
      all: async () => {
        const result = await statement.all();
        recordMeta(result);
        return result;
      },
      raw: async () => {
        const result = await statement.raw();
        if (Array.isArray(result)) {
          usage.recordD1Read(result.length);
        }
        return result;
      },
      first: statement.first.bind(statement),
    };
    // Faithful forwarder for the statement shape drizzle's D1 driver uses.
    return instrumented as unknown as D1PreparedStatement;
  };
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => instrumentStatement(target.prepare(query));
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          for (const result of results) {
            recordMeta(result);
          }
          return results;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const COUNTED_R2_METHODS: ReadonlySet<string> = new Set(["get", "put", "head", "delete", "list"]);

/** Wraps an R2 bucket so every object operation counts toward r2_operations. */
export function instrumentR2(bucket: R2Bucket, usage: RequestUsageRecorder): R2Bucket {
  return new Proxy(bucket, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof property === "string" && COUNTED_R2_METHODS.has(property) && typeof value === "function") {
        return (...args: unknown[]) => {
          usage.recordR2Operation();
          return value.apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
