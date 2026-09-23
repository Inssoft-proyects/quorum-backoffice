/**
 * DTOs for the quorum-otp service integration.
 *
 * The backoffice calls `POST /v1/otps/verify` with (subject, scope, code).
 * The scope is the action being authorized (e.g. "marbete.delete") so that
 * each OTP can be single-purpose and short-lived.
 */
import { z } from 'zod';

export const VerifyOtpRequest = z.object({
  subject: z.string().min(1).max(128),
  scope: z.string().min(1).max(64),
  code: z.string().length(6),
});
export type VerifyOtpRequest = z.infer<typeof VerifyOtpRequest>;

export interface VerifyOtpSuccess {
  ok: true;
  otpId: string;
}

export interface VerifyOtpFailure {
  ok: false;
  reason: 'invalid' | 'expired' | 'locked' | 'rate_limited' | 'unknown';
}

export type VerifyOtpResult = VerifyOtpSuccess | VerifyOtpFailure;
