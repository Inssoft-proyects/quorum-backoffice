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

// ---- Bulk create (WU #3 / Polish WU v4) ----
//
// Admin-only endpoint that accepts up to 200 marbete codes in a single
// transactional call. Per-row outcomes are returned in `successes` /
// `failures` so partial successes are observable to the operator; the
// underlying SQL is still all-or-nothing (any unexpected DB error
// rolls the entire batch back), but pre-validation duplicates
// (intra-batch or already in DB) are reported as `failures` and do not
// abort the rest of the insert.
export const BulkCreateMarbetesItem = z.object({
  code: z.string().min(8).max(128),
  canvasUserId: z.number().int().positive().optional(),
  note: z.string().max(500).optional(),
});
export type BulkCreateMarbetesItem = z.infer<typeof BulkCreateMarbetesItem>;

export const BulkCreateMarbetesRequest = z.object({
  items: z.array(BulkCreateMarbetesItem).min(1).max(200),
  reason: z.string().max(500).optional(),
});
export type BulkCreateMarbetesRequest = z.infer<typeof BulkCreateMarbetesRequest>;

export interface BulkCreateMarbeteSuccess {
  id: number;
  publicUid: string;
  status: MarbeteStatus;
}

/**
 * Machine-readable failure category. The .xlsx bulk endpoint
 * (/api/v1/marbetes/bulk-xlsx) populates this for every per-row
 * failure, while the JSON /bulk and /bulk-csv endpoints populate it
 * only for the reasons the service itself can attribute (duplicates).
 * Any reason that does not map to a known category lands in 'other'.
 *
 * The category is additive on the shared `BulkCreateMarbeteFailure`
 * shape; callers that ignore unknown fields are unaffected.
 */
export const BulkFailureCategory = z.enum([
  'length_out_of_range',
  'invalid_chars',
  'duplicate_in_file',
  'already_exists',
  'other',
]);
export type BulkFailureCategory = z.infer<typeof BulkFailureCategory>;

export interface BulkCreateMarbeteFailure {
  index: number;
  line: number | null;
  code: string;
  reason: string;
  category: BulkFailureCategory;
}

export interface BulkCreateMarbetesResponse {
  total: number;
  created: number;
  failed: number;
  successes: BulkCreateMarbeteSuccess[];
  failures: BulkCreateMarbeteFailure[];
  auditId: number | null;
}

// ---- Bulk create via .xlsx upload (T4) ----
//
// Admin-only endpoint that accepts a base64-encoded .xlsx workbook
// with a single "Número de marbete" column. Per-row outcomes share the
// JSON /bulk shape (successes/failures, code) plus xlsx-specific
// metadata: the number of template example rows skipped, a category
// histogram for the UI's result card, and a downloadable errors file
// (only when there were failures). The 20-minute OTP grant window
// applies exactly like the JSON /bulk endpoint.
export const BulkXlsxCreateRequest = z.object({
  /** Original file name (used in audit metadata + the errors-file name). */
  fileName: z.string().min(1).max(255),
  /** Canonical RFC 4648 base64 of the .xlsx workbook bytes. */
  contentBase64: z.string().min(1).max(/* 5 MB worth of base64 */ (5 * 1024 * 1024 * 4) / 3 + 64),
  /** Optional human-set reason for the upload (persisted on the audit row). */
  reason: z.string().max(500).optional(),
});
export type BulkXlsxCreateRequest = z.infer<typeof BulkXlsxCreateRequest>;

export interface BulkXlsxErrorsFile {
  /** Suggested file name for the downloadable errors workbook. */
  fileName: string;
  /** Canonical base64 of the errors workbook (decoded by the client). */
  contentBase64: string;
}

export interface BulkXlsxCreateSuccess extends BulkCreateMarbeteSuccess {
  /** 1-based row number in the original .xlsx (always populated for this endpoint). */
  xlsxRow: number;
}

export interface BulkXlsxCreateFailure extends BulkCreateMarbeteFailure {
  /** 1-based row number in the original .xlsx (always populated for this endpoint). */
  xlsxRow: number;
}

export interface BulkXlsxCreateResponse {
  total: number;
  created: number;
  failed: number;
  /** successes in submission order (which is xlsx row order). */
  successes: BulkXlsxCreateSuccess[];
  /** failures sorted by xlsx row number. */
  failures: BulkXlsxCreateFailure[];
  auditId: number | null;
  /** Rows that matched the template example (literal "123456789") and were skipped. */
  skippedExampleRows: number;
  /** Histogram of per-category failure counts (always includes every key, zero where absent). */
  categoryCounts: Record<BulkFailureCategory, number>;
  /** Downloadable errors workbook (null when every row succeeded). */
  errorsFile: BulkXlsxErrorsFile | null;
}

// ---- OTP grant status (20-minute destructive-marbetel window) ----
//
// After an actor verifies a fresh single-use OTP against quorum-otp for
// a grant-eligible scope (`marbete.create`, `marbete.update`,
// `marbete.delete`, `marbete.bulk_create`), the BackOffice records a
// per-actor grant row with a TTL window (default 20 minutes,
// configurable via `OTP_GRANT_TTL_MINUTES`). Further destructive ops
// within the window proceed WITHOUT re-entering an OTP. `marbete.reveal`
// is intentionally NOT grant-eligible: every reveal still requires a
// fresh per-op OTP.
//
// The UI calls `GET /api/v1/marbetes/otp-grant` once on dialog open and
// uses the result to decide whether to hide the OTP input field.
export interface OtpGrantStatusResponse {
  /** True when the actor has an unexpired grant for the marbete scope. */
  active: boolean;
  /**
   * ISO 8601 timestamp of the grant's expiry. `null` when `active` is
   * false (the UI treats that case as "OTP required").
   */
  expiresAt: string | null;
}
