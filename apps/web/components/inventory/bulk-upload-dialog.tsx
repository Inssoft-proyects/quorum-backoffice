'use client';

import * as React from 'react';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Upload } from 'lucide-react';
import type { BulkCreateMarbetesResponse } from '@quorum-backoffice/shared';
import { ApiError, bulkCreateMarbetes } from '@/lib/api-client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Alert } from '@/components/ui/alert';
import { OtpInput } from '@/components/ui/otp-input';

export interface BulkUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the server confirms the batch was committed (full or
   * partial success). Parent should re-fetch the marbetes list. */
  onSaved: () => void;
}

/**
 * Marbete code format (mirrors apps/api/src/lib/marbete-id.ts):
 * `[A-Za-z0-9._\-:]{8,128}`. The dialog applies the same regex client-
 * side so users see immediate feedback before the round-trip.
 */
const CODE_FORMAT_REGEX = /^[A-Za-z0-9._\-:]{8,128}$/;

/**
 * Lightweight CSV-ish line parser used to power the live "N válidos,
 * M inválidos" stats. Accepts plain newlines and skips a header row
 * whose first field is exactly `code`. Mirrors `parseCsvCodes` from
 * apps/api/src/lib/marbete-id.ts without pulling the full RFC-4180
 * parser into the web bundle.
 */
function parseInputLines(
  text: string,
): { validCount: number; invalidCount: number } {
  const lines = text.split(/\r?\n/);
  let validCount = 0;
  let invalidCount = 0;
  let firstNonEmptySeen = false;
  for (const raw of lines) {
    const trimmed = readFirstField(raw).trim();
    if (trimmed === '') continue;
    if (!firstNonEmptySeen) {
      firstNonEmptySeen = true;
      // Header detection: only when the first field is exactly `code`,
      // not when a valid code happens to start with that substring.
      if (trimmed.toLowerCase() === 'code') continue;
    }
    if (CODE_FORMAT_REGEX.test(trimmed)) validCount += 1;
    else invalidCount += 1;
  }
  return { validCount, invalidCount };
}

/**
 * Extract the first field of a CSV line (handles simple `"foo,bar"`
 * quoting) — sufficient for our paste preview. Mirrors the spirit of
 * parseCsvCodes without pulling the full RFC-4180 parser into the web
 * bundle.
 */
function readFirstField(line: string): string {
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        const next = line[i + 1];
        if (next === '"') cur += '"';
        else inQuotes = false;
      } else if (ch !== undefined) cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      break;
    } else if (ch !== undefined) {
      cur += ch;
    }
  }
  return cur;
}

/**
 * Bulk upload dialog for marbetes (WU #3 / Polish WU v4).
 *
 * Flow:
 *  - User pastes a newline-delimited list of codes into the textarea,
 *    or picks a `.csv` file (read locally via FileReader and merged
 *    into the textarea). Live stats show valid / invalid counts.
 *  - User types a 6-digit OTP (admin + OTP enforcement is enforced by
 *    the server for `marbete.bulk_create`).
 *  - On submit we POST `{ items: [{ code }, ...] }` to
 *    `/api/v1/marbetes/bulk`. The response carries per-row outcomes:
 *    full success closes the dialog immediately, partial failure
 *    replaces the form with a summary screen until the user dismisses.
 *  - onSaved fires on every 2xx response (full or partial), so the
 *    parent re-fetches and shows the freshly-created rows.
 */
export function BulkUploadDialog({ open, onOpenChange, onSaved }: BulkUploadDialogProps) {
  const [text, setText] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkCreateMarbetesResponse | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const { validCount, invalidCount } = useMemo(
    () => parseInputLines(text),
    [text],
  );

  const otpReady = otp.length === 6;
  const canSubmit = validCount > 0 && otpReady && !loading;

  function reset() {
    setText('');
    setOtp('');
    setError(null);
    setLoading(false);
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? '');
      // Append (don't clobber) so users can stack multiple CSVs.
      setText((prev) => (prev.length === 0 ? content : `${prev}\n${content}`));
    };
    reader.onerror = () => {
      setError('No se pudo leer el archivo seleccionado.');
    };
    reader.readAsText(file);
  }

  function buildItems(): Array<{ code: string }> {
    const items: Array<{ code: string }> = [];
    const lines = text.split(/\r?\n/);
    let firstNonEmptySeen = false;
    for (const raw of lines) {
      const trimmed = readFirstField(raw).trim();
      if (trimmed === '') continue;
      if (!firstNonEmptySeen) {
        firstNonEmptySeen = true;
        if (trimmed.toLowerCase() === 'code') continue;
      }
      if (CODE_FORMAT_REGEX.test(trimmed)) items.push({ code: trimmed });
    }
    return items;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      const items = buildItems();
      const response = await bulkCreateMarbetes({ items }, otp);
      setResult(response);
      onSaved();
      if (response.failed === 0) {
        // Full success: close immediately, the parent already refetched.
        onOpenChange(false);
      }
      // Partial failure: keep the dialog open with the summary screen so
      // the user can see which codes were rejected. reset() runs when
      // the dialog closes via the Cancel button or the X.
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === 'otp_invalid'
            ? 'Código OTP inválido o expirado.'
            : err.code === 'otp_required'
              ? 'Código OTP requerido.'
              : err.code === 'forbidden'
                ? 'No tienes permisos para cargar marbetes.'
                : err.code === 'validation_error'
                  ? 'Los datos enviados no son válidos.'
                  : err.message
          : 'Error de red. Intenta de nuevo.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="bulk-upload-dialog">
        <DialogHeader>
          <div className="modal-dialog__icon" aria-hidden>
            <Upload />
          </div>
          <DialogTitle className="modal-dialog__title" data-testid="bulk-upload-title">
            Cargar marbetes
          </DialogTitle>
          <DialogDescription
            className="modal-dialog__description"
            id="bulk-upload-description"
          >
            Pega una lista de códigos (uno por línea) o selecciona un archivo CSV.
            Cada código debe tener entre 8 y 128 caracteres del alfabeto{' '}
            <code>A–Z a–z 0–9 . _ - :</code>.
          </DialogDescription>
        </DialogHeader>

        {result && result.failed > 0 ? (
          // Partial-failure summary. Replaces the form until the user
          // dismisses; onSaved already fired so the parent has refetched.
          <div className="modal-dialog__content" data-testid="bulk-upload-summary">
            <Alert variant="destructive" role="alert" data-testid="bulk-upload-partial-warning">
              {`${result.created} creados, ${result.failed} con error.`}
            </Alert>
            {result.failures.length > 0 ? (
              <ul
                className="modal-dialog__content"
                data-testid="bulk-upload-failures"
                aria-label="Códigos rechazados"
              >
                {result.failures.slice(0, 20).map((f) => (
                  <li key={`${f.index}-${f.line ?? 'x'}`}>
                    {f.line !== null ? `Línea ${f.line}: ` : ''}
                    <code>{f.code || '(vacío)'}</code> — {f.reason}
                  </li>
                ))}
                {result.failures.length > 20 ? (
                  <li>…y {result.failures.length - 20} más.</li>
                ) : null}
              </ul>
            ) : null}
            <p className="form-field__hint" data-testid="bulk-upload-audit">
              Auditoría: registro #{result.auditId ?? '—'}
            </p>
            <DialogFooter className="modal-dialog__actions">
              <Button
                type="button"
                variant="default"
                onClick={() => handleOpenChange(false)}
                data-testid="bulk-upload-close"
              >
                Cerrar
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="modal-dialog__content" noValidate>
            {error ? (
              <Alert
                variant="destructive"
                role="alert"
                data-testid="bulk-upload-error"
              >
                {error}
              </Alert>
            ) : null}

            <div className="form-field">
              <label htmlFor="bulk-upload-codes" className="form-field__label">
                Códigos
              </label>
              <Textarea
                id="bulk-upload-codes"
                name="bulk-upload-codes"
                rows={6}
                placeholder={'CODE12345678\nCODE23456789'}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  if (error) setError(null);
                }}
                disabled={loading}
                data-testid="bulk-upload-codes-input"
              />
              <div className="form-field__hint" data-testid="bulk-upload-stats">
                {validCount} válidos, {invalidCount} inválidos
              </div>
            </div>

            <div className="form-field">
              <label htmlFor="bulk-upload-file" className="form-field__label">
                Archivo CSV (opcional)
              </label>
              <input
                id="bulk-upload-file"
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv,text/plain"
                onChange={handleFileChange}
                disabled={loading}
                data-testid="bulk-upload-file-input"
                className="form-field__input"
              />
              <p className="form-field__hint">
                Se leerá localmente y se agregará al contenido del cuadro de texto.
              </p>
            </div>

            <div className="form-field">
              <span className="form-field__label form-field__label--row">
                <span>Código OTP</span>
                <span className="form-field__required">Obligatorio</span>
              </span>
              <div data-testid="bulk-upload-otp">
                <OtpInput
                  value={otp}
                  onChange={(v) => {
                    setOtp(v);
                    if (error) setError(null);
                  }}
                  disabled={loading}
                  aria-label="Código OTP"
                />
              </div>
            </div>

            <DialogFooter className="modal-dialog__actions">
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={loading}
              >
                Cancelar
              </Button>
              <Button
                type="submit"
                variant="default"
                disabled={!canSubmit}
                data-testid="bulk-upload-submit"
              >
                {loading
                  ? 'Cargando…'
                  : validCount > 0
                    ? `Cargar ${validCount} marbetes`
                    : 'Cargar marbetes'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}