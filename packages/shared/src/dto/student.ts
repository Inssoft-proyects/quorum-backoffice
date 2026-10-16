/**
 * Zod DTOs for the backoffice-internal students_cache projection.
 *
 * Distinct from the upstream `CanvasStudent` schema in
 * `packages/shared/src/dto/canvas.ts` (which mirrors portal-api
 * and always carries a non-null `full_name` + `email`). This
 * DTO mirrors the backoffice cache directly:
 *
 *   - `sisId` is the SIS matrícula added in migration 0020.
 *     Nullable so legacy rows (inserted before 0020) keep working
 *     without a backfill.
 *   - `fullName` and `email` are nullable since migration 0020
 *     dropped the NOT NULL constraints to host synthetic
 *     high-privacy students (rows identified by matrícula + canvas
 *     id only). The wire surface therefore exposes them as
 *     `string | null` so an operator-facing UI can render a
 *     "synthetic / not populated" placeholder instead of crashing
 *     or echoing a literal null.
 *
 * Wire compatibility: existing consumers (operator dashboard,
 * marbete detail page, MFA flow) read the JSON as `string` for
 * the name/email fields. Zod's `string().nullable()` accepts the
 * non-null case, so old responses validate unchanged. New
 * responses carry `null` where the cache row is a synthetic one.
 */
import { z } from 'zod';

export const StudentResponse = z.object({
  /** Internal `students_cache.id` (FK target from marbetes / dispositivos). */
  id: z.number().int().positive(),
  /** External Canvas user id; the wire key the route accepts. */
  canvasUserId: z.number().int().positive(),
  /** SIS matrícula (6-char uppercase alnum). NULL for legacy rows. */
  sisId: z.string().nullable(),
  /** Canvas-side display name. NULL for synthetic high-privacy rows. */
  fullName: z.string().nullable(),
  /** Canvas-side email. NULL for synthetic high-privacy rows. */
  email: z.string().email().nullable(),
  /** Mirrors Canvas enrollment status (graduated/withdrawn = false). */
  isActive: z.boolean(),
});
export type StudentResponse = z.infer<typeof StudentResponse>;
