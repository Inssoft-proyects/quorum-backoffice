/**
 * DTOs for the Canvas LMS read-through via portal-api.
 *
 * The backoffice never speaks to Canvas directly — it reads through the
 * existing portal-api which already owns the LTI 1.3 / OAuth contract.
 *
 * G9 follow-up: the portal contract changed. `email` is now OPTIONAL
 * because the portal enforces PII minimisation (it may publish only
 * `email_hash`), and `is_active` is now OPTIONAL because legacy
 * portal builds do not publish per-user enrollment status. `email_hash`
 * itself is opaque to the backoffice — it is never persisted; the
 * cache stores the empty string in `email` when the portal omits it.
 */
import { z } from 'zod';

export const CanvasStudent = z.object({
  id: z.number().int().positive(),
  canvas_user_id: z.number().int().positive(),
  full_name: z.string().min(1),
  /**
   * Clear-text email. OPTIONAL since G9: the portal may omit it in
   * favour of `email_hash` (PII minimisation). When absent, the
   * service layer stores the empty string in the cache's NOT NULL
   * email column and never substitutes `email_hash` for it.
   */
  email: z.string().email().optional(),
  /**
   * Opaque hash the portal publishes in place of (or alongside) the
   * clear-text email. The backoffice treats it as wire-only: it is
   * validated for shape but never persisted to the cache.
   */
  email_hash: z.string().optional(),
  /**
   * Per-user enrollment status published by the new portal builds.
   * OPTIONAL so older portal builds (which do not publish the flag)
   * keep working. The service defaults a missing value to `true`
   * (today's "still enrolled" assumption) — the F4
   * `deactivateMissing` roster-walk still flips rows that dropped
   * out of the upstream total.
   */
  is_active: z.boolean().optional(),
  /**
   * Institutional SIS user id (NOT the internal Canvas
   * numeric id). PUBLISHED by the portal-api `/v1/students`
   * endpoint starting with the B5 cross-repo work
   * (`odd/tasks/canvas-sis-lookup-b5.md`, specs S1/S2 in the
   * portal-api repo). The field is OPTIONAL + nullable here
   * so legacy portal builds (which do not publish it) keep
   * parsing, and a portal that publishes `null` (i.e. the
   * student has no SIS matrícula yet) is also accepted: the
   * service layer forwards `null` to
   * `students_cache.sis_id` so the row can be back-filled on
   * a later sync when Canvas publishes the value.
   */
  sis_user_id: z.string().nullable().optional(),
});
export type CanvasStudent = z.infer<typeof CanvasStudent>;

export interface CanvasStudentListResponse {
  total: number;
  items: CanvasStudent[];
}
