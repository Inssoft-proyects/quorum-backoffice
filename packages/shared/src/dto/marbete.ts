/**
 * Zod DTOs for the Marbete entity.
 *
 * Used by both apps/api (request validation + response shapes) and apps/web
 * (form validation, API client typing). Keep this file dependency-free so
 * shared package stays lightweight.
 */
import { z } from 'zod';

// ---- Enums (mirror DB enum values) ----
export const MarbeteStatus = z.enum(['active', 'inactive', 'revoked']);
export type MarbeteStatus = z.infer<typeof MarbeteStatus>;

// ---- Path params ----
export const MarbeteIdParam = z.object({
  id: z.coerce.number().int().positive(),
});

// ---- Create ----
export const CreateMarbeteRequest = z.object({
  /**
   * Plain code as read by the mobile app's QR bicapa scanner. The API hashes
   * it (sha256) before persisting; the plain code is never stored.
   */
  code: z.string().min(8).max(128),
  /**
   * Optional: assign to a student at creation time by their external Canvas
   * user identifier. The API resolves this to the internal students_cache.id
   * and rejects the assignment if the student is not in cache or marked
   * inactive.
   */
  canvasUserId: z.number().int().positive().optional(),
  /** Optional: human-set note (not persisted in MVP; reserved for WU3b). */
  note: z.string().max(500).optional(),
});
export type CreateMarbeteRequest = z.infer<typeof CreateMarbeteRequest>;

// ---- Update / Assign ----
export const UpdateMarbeteRequest = z.object({
  /**
   * Canvas user identifier of the student to assign. Pass `null` explicitly
   * to unassign the marbete. Resolved server-side against students_cache;
   * unresolved or inactive students are rejected with 422.
   */
  canvasUserId: z.number().int().positive().nullable().optional(),
  status: MarbeteStatus.optional(),
});
export type UpdateMarbeteRequest = z.infer<typeof UpdateMarbeteRequest>;

// ---- Delete (with mandatory justification) ----
export const DeleteMarbeteRequest = z.object({
  reason: z.string().min(3).max(500),
  /** Required from WU3b; ignored in WU3a. */
  otpCode: z.string().length(6).optional(),
});
export type DeleteMarbeteRequest = z.infer<typeof DeleteMarbeteRequest>;

// ---- List filter ----
export const ListMarbetesFilter = z.object({
  status: MarbeteStatus.optional(),
  assigned: z
    .enum(['yes', 'no', 'any'])
    .optional()
    .default('any'),
  search: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListMarbetesFilter = z.infer<typeof ListMarbetesFilter>;

// ---- Response shapes ----
export interface MarbeteResponse {
  id: number;
  publicUid: string;
  status: MarbeteStatus;
  assignedStudentId: number | null;
  assignedAt: string | null;
  createdAt: string;
  createdBy: string;
  deletedAt: string | null;
  deletionReason: string | null;
}

export interface MarbeteDetailResponse extends MarbeteResponse {
  /**
   * Masked code for display: e.g. "3***24" (first 1 + *** + last 2 chars).
   * Never expose the full code or its hash via the public API.
   */
  maskedCode: string;
  /** Resolved student from students_cache, if assigned. */
  student: {
    id: number;
    canvasUserId: number;
    fullName: string;
    email: string;
  } | null;
}

export interface MarbeteCountersResponse {
  /** Marbetes that are active AND have an assigned student (fully paired). */
  ok: number;
  /** Marbetes that are active but NOT assigned, or deleted (not paired). */
  ko: number;
}

export interface ListMarbetesResponse {
  total: number;
  limit: number;
  offset: number;
  items: MarbeteDetailResponse[];
}

// ---- Reveal (WU #1) ----
// Audit-only read: returns the unmasked publicUid so admins can read out
// the full identifier to a student/auditor. The original scanned code is
// never recoverable (only code_hash is stored).
export const RevealMarbeteRequest = z.object({
  motivo: z.string().min(3).max(500),
  comentario: z.string().max(500).optional(),
});
export type RevealMarbeteRequest = z.infer<typeof RevealMarbeteRequest>;

export interface RevealMarbeteResponse {
  /** The full publicUid, e.g. "m-AB12CD". */
  code: string;
  /** ISO 8601 timestamp of the reveal. */
  revealedAt: string;
}
