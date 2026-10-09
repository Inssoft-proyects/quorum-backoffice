/**
 * Zod DTOs for the "Asignación de marbetes" screen (WU v3).
 *
 *   - MatriculaListItem / ListMatriculasResponse: paginated listing of
 *     students_cache rows joined with their currently-assigned active
 *     marbete (LEFT JOIN, 1:1 at most).
 *   - MatriculasCountersResponse: aggregate counters used by the
 *     screen header (total students, assigned / unassigned split,
 *     number of free marbetes ready to assign).
 *   - AssignMarbetesRequest / UnassignMarbeteRequest: write payloads.
 *   - SyncMatriculasResponse: result of POST /sync (Canvas → cache).
 *
 * A "matrícula" in this domain is the students_cache row keyed by
 * Canvas user id. The screen surfaces them in a single list with an
 * embedded marbete object so the operator can browse + assign in one
 * pass.
 */
import { z } from 'zod';
import { MarbeteStatus } from './marbete';

// ---- Filter ----
export const ListMatriculasStatus = z.enum(['assigned', 'unassigned', 'any']);
export type ListMatriculasStatus = z.infer<typeof ListMatriculasStatus>;

export const ListMatriculasIsActive = z.enum(['true', 'false', 'any']);
export type ListMatriculasIsActive = z.infer<typeof ListMatriculasIsActive>;

export const ListMatriculasFilter = z.object({
  status: ListMatriculasStatus.optional().default('any'),
  search: z.string().min(1).max(64).optional(),
  isActive: ListMatriculasIsActive.optional().default('true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListMatriculasFilter = z.infer<typeof ListMatriculasFilter>;

// ---- Response shapes ----
export interface MarbeteSummary {
  id: number;
  publicUid: string;
  maskedCode: string;
  status: MarbeteStatus;
  assignedAt: string | null;
  /** Operator username captured at assign time (NULL on legacy rows). */
  assignedBy: string | null;
}

export interface MatriculaListItem {
  /** External Canvas user identifier (students_cache.canvas_user_id). */
  canvasUserId: number;
  /**
   * Student full name as published by Canvas (`students_cache.full_name`).
   * Nullable on the wire: a Canvas-side enrolled student can be missing
   * `full_name` (the portal returns `null` for 997/999 rows in the live
   * production data), and this contract reflects that. Consumers MUST
   * handle `null` — never call `.toLowerCase()` or `.trim()` on it
   * without a guard. When null, fall back to `sisId` as the
   * human-readable label (see `apps/web` `asociar` screen).
   */
  fullName: string | null;
  /**
   * Student email as published by Canvas (`students_cache.email`).
   * Nullable on the wire for the same reason as `fullName`. The portal
   * may additionally suppress `email` (PII minimisation) and the
   * service layer stores the empty string in that case; this `null`
   * branch is the legacy/Canvas-missing-name case.
   */
  email: string | null;
  /**
   * SIS matrícula (students_cache.sis_id). Populated by the SIS sync
   * for students who exist in SIS but not yet in Canvas — it is the
   * only stable human identifier for those rows. Nullable on the wire
   * because the Canvas-only rows do not have a SIS counterpart.
   */
  sisId: string | null;
  isActive: boolean;
  /**
   * Best available "since when was this student known to the cache"
   * timestamp. Mirrors students_cache.last_synced_at; the portal-api
   * does not surface a per-student createdAt so this is the closest
   * stable value.
   */
  registeredAt: string | null;
  /**
   * The currently-assigned marbete for this student, or null when the
   * student has no active marbete. The join filters on
   * `marbetes.status = 'active' AND deleted_at IS NULL` so a
   * soft-deleted marbete never appears here.
   */
  marbete: MarbeteSummary | null;
}

export interface ListMatriculasResponse {
  total: number;
  limit: number;
  offset: number;
  items: MatriculaListItem[];
}

export interface MatriculasCountersResponse {
  /** Number of students_cache rows under the active filter. */
  total: number;
  /** Students with an active marbete (LEFT JOIN matched). */
  assigned: number;
  /** Students without an active marbete. */
  unassigned: number;
  /**
   * Marbetes that are active, not soft-deleted, and not assigned to
   * any student. Surfaced in the screen header so the operator sees
   * how many free marbetes are available before opening the bulk
   * assign dialog.
   */
  availableMarbetes: number;
}

// ---- Write payloads ----
export const AssignMarbetesPair = z.object({
  canvasUserId: z.number().int().positive(),
  marbeteId: z.number().int().positive(),
});
export type AssignMarbetesPair = z.infer<typeof AssignMarbetesPair>;

export const AssignMarbetesRequest = z.object({
  pairs: z.array(AssignMarbetesPair).min(1).max(200),
  reason: z.string().max(500).optional(),
});
export type AssignMarbetesRequest = z.infer<typeof AssignMarbetesRequest>;

export const UnassignMarbeteRequest = z.object({
  marbeteId: z.number().int().positive(),
  reason: z.string().min(3).max(500),
  comentario: z.string().max(500).optional(),
});
export type UnassignMarbeteRequest = z.infer<typeof UnassignMarbeteRequest>;

// ---- Sync response ----
export interface AssignMarbetesResponse {
  /** Echo of the requested pair count (1..200). */
  total: number;
  /**
   * Per-pair resolution: the canvasUserId + marbeteId from the
   * request, paired with the resolved marbete publicUid. Same order
   * as the request.
   */
  pairs: { canvasUserId: number; marbeteId: number; publicUid: string }[];
}

export interface SyncMatriculasResponse {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Rows skipped because they were inactive / invalid in the source. */
  skipped: number;
  durationMs: number;
}