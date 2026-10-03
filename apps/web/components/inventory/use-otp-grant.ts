'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, getMarbeteOtpGrant } from '@/lib/api-client';
import type { OtpGrantStatusResponse } from '@quorum-backoffice/shared';

export interface UseOtpGrantResult {
  /** Last fetched grant status. `null` until the first fetch resolves. */
  status: OtpGrantStatusResponse | null;
  /** `true` while the initial fetch is in flight (only). */
  loading: boolean;
  /** Error from the most recent fetch, if any. */
  error: ApiError | Error | null;
  /**
   * Force a fresh fetch. The dialogs call this on open (after onClose
   * resets local state) and again after each successful destructive op
   * so a newly-minted grant is reflected immediately.
   */
  refresh: () => Promise<void>;
}

/**
 * React hook for the session actor's current OTP grant window.
 *
 * The destructive-marbetel dialogs (add / revoke) call this hook on
 * open and use the result to decide whether to render the OTP input.
 * When `status.active` is `true`, the dialog hides the OTP field,
 * surfaces a "OTP vigente hasta HH:MM" note, and submits without the
 * `x-otp-code` header. When `false` (or `null` until the first fetch
 * resolves), the dialog renders today's OTP-required flow.
 *
 * Refreshing the note: the dialogs should call `refresh()` after a
 * successful op — a fresh grant may have just been minted and the
 * cached `status` is now stale.
 *
 * Transport failures (network error, non-2xx) surface as `error` but
 * the hook still resolves to `{ active: false, expiresAt: null }` in
 * `status` so the dialog always degrades to the OTP-required path.
 * That is the safe default: missing grant is treated as "needs OTP".
 */
export function useOtpGrant(): UseOtpGrantResult {
  const [status, setStatus] = useState<OtpGrantStatusResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const next = await getMarbeteOtpGrant();
      setStatus(next);
    } catch (err) {
      const wrapped =
        err instanceof ApiError
          ? err
          : err instanceof Error
            ? err
            : new Error('otp_grant_fetch_failed');
      setError(wrapped);
      // Fail closed: missing grant means OTP required.
      setStatus({ active: false, expiresAt: null });
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch on mount. We do NOT poll: the dialog calls refresh()
  // explicitly after each successful op so a fresh grant is surfaced
  // immediately. The hook's lifecycle is bound to its consumer
  // component (the dialog), which unmounts on close.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, loading, error, refresh };
}