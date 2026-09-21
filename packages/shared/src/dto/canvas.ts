/**
 * DTOs for the Canvas LMS read-through via portal-api.
 *
 * The backoffice never speaks to Canvas directly — it reads through the
 * existing portal-api which already owns the LTI 1.3 / OAuth contract.
 */
import { z } from 'zod';

export const CanvasStudent = z.object({
  id: z.number().int().positive(),
  canvas_user_id: z.number().int().positive(),
  full_name: z.string().min(1),
  email: z.string().email(),
});
export type CanvasStudent = z.infer<typeof CanvasStudent>;

export interface CanvasStudentListResponse {
  total: number;
  items: CanvasStudent[];
}
