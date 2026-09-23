/**
 * Zod DTOs for the Dispositivo entity.
 *
 * Used by both apps/api (request validation + response shapes) and apps/web
 * (form validation, API client typing). Keep this file dependency-free so
 * shared package stays lightweight.
 */
import { z } from 'zod';

// ---- Enums (mirror DB enum values) ----
export const DispositivoStatus = z.enum(['active', 'revoked']);
export type DispositivoStatus = z.infer<typeof DispositivoStatus>;

// ---- Path params ----
export const DispositivoIdParam = z.object({
  id: z.coerce.number().int().positive(),
});

// ---- Create ----
export const CreateDispositivoRequest = z.object({
  /**
   * Hardware serial number as printed on the device (used for QR pairing on
   * the mobile/tablet app). Unique across the table (DB enforces UNIQUE).
   */
  serialNumber: z.string().min(3).max(128),
  brand: z.string().max(64).optional(),
  model: z.string().max(128).optional(),
});
export type CreateDispositivoRequest = z.infer<typeof CreateDispositivoRequest>;

// ---- Update ----
export const UpdateDispositivoRequest = z.object({
  brand: z.string().max(64).optional(),
  model: z.string().max(128).optional(),
});
export type UpdateDispositivoRequest = z.infer<typeof UpdateDispositivoRequest>;

// ---- Revoke (soft delete with mandatory justification) ----
export const DeleteDispositivoRequest = z.object({
  reason: z.string().min(3).max(500),
  /** Required from WU3b; ignored in WU3a. */
  otpCode: z.string().length(6).optional(),
});
export type DeleteDispositivoRequest = z.infer<typeof DeleteDispositivoRequest>;

// ---- List filter ----
export const ListDispositivosFilter = z.object({
  status: DispositivoStatus.optional(),
  search: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListDispositivosFilter = z.infer<typeof ListDispositivosFilter>;

// ---- Response shapes ----
export interface DispositivoResponse {
  id: number;
  serialNumber: string;
  brand: string | null;
  model: string | null;
  status: DispositivoStatus;
  createdAt: string;
  createdBy: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

export type DispositivoDetailResponse = DispositivoResponse;

export interface ListDispositivosResponse {
  total: number;
  limit: number;
  offset: number;
  items: DispositivoDetailResponse[];
}