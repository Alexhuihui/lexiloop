/**
 * Authenticated user context for every repository method that touches
 * personal data (spec 6.3: study queries resolve user_id from the session
 * and must filter on it explicitly). Methods scoped by this context can
 * never return another user's rows by construction.
 */
export interface UserContext {
  userId: string;
}
