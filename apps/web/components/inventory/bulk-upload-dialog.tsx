'use client';

import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import type { BulkXlsxCreateResponse } from '@quorum-backoffice/shared';
import { ApiError, bulkCreateMarbetesXlsx } from '@/lib/api-client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { OtpInput } from '@/components/ui/otp-input';
import { useOtpGrant } from './use-otp-grant';
import {
  BulkUploadDropzone,
  formatFileSize,
  type SelectedFile,
} from './bulk-upload-dropzone';
import {
  BulkUploadProcessingOverlay,
  type BulkProcessingStage,
  type BulkProcessingStageStatus,
} from './bulk-upload-processing-overlay';
import { BulkUploadResult } from './bulk-upload-result';

export interface BulkUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the server confirms the batch was committed (full or
   * partial success). Parent should re-fetch the marbetes list. */
  onSaved: () => void;
}

/**
 * Per-stage progress and human-readable status string. Mirrors the
 * canon processing-steps ordering so the test plan can assert
 * stage-by-stage transitions.
 */
interface ProcessingStepDefinition {
  key: BulkProcessingStage;
  /** 0–100 progress when the stage reaches 'complete'. */
  progress: number;
  /** Status copy while the stage is 'active'. */
  message: string;
}

const PROCESSING_STEPS: ReadonlyArray<ProcessingStepDefinition> = [
  { key: 'read', progress: 14, message: 'Leyendo plantilla .xlsx...' },
  { key: 'rows', progress: 32, message: 'Preparando marbetes detectados...' },
  { key: 'format', progress: 52, message: 'Validando formato de los números...' },
  {
    key: 'duplicates',
    progress: 69,
    message: 'Buscando duplicados en el archivo...',
  },
  {
    key: 'existing',
    progress: 86,
    message: 'Comprobando registros existentes...',
  },
  {
    key: 'result',
    progress: 100,
    message: 'Asignando vigencia y estado Disponible...',
  },
];

/** Per-stage animation delay (ms). Tuned for snappy UX; tests extend
      // their own waitFor timeouts to accommodate the animation. */
const STAGE_INTERVAL_MS = 200;

/** Delay between the upload completing and the result view appearing. */
const RESULT_TRANSITION_MS = 120;

/** Error copy per server ApiError code (canon-aligned Spanish). */
function errorMessageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'otp_invalid') return 'Código OTP inválido o expirado.';
    if (err.code === 'otp_required')
      return 'Esta acción requiere un código OTP.';
    if (err.code === 'forbidden') return 'No tienes permisos para cargar marbetes.';
    if (err.code === 'validation_error')
      return 'El archivo no cumple con el formato requerido.';
    return err.message;
  }
  return 'Error de red. Intenta de nuevo.';
}

type DialogView = 'form' | 'processing' | 'result';

/**
 * Marbetes .xlsx bulk-upload modal (maquette v3, T5).
 *
 * Flow (per canon /planQuorum/dev/quorum-design/design/Inec/Inec/carga-masiva-marbetes.html):
 *  1. **Form view** — drag-and-drop or pick a .xlsx file. Selected
 *     file shows the canon "Datos generados automáticamente" explainer.
 *     Non-.xlsx picks surface the canon inline error block.
 *  2. **Submit** — when the user clicks "Subir archivo", we kick off
 *     POST /api/v1/marbetes/bulk-xlsx and animate the 6-stage
 *     checklist while the server works. The animation is optimistic;
 *     if the response arrives before the animation completes, we
 *     fast-forward the remaining stages. If the animation completes
 *     first we wait for the response.
 *  3. **Result view** — always shown after a 2xx response (full or
 *     partial). The metric cards summarise `categoryCounts`; an
 *     errors file is auto-downloaded when present. The dialog does
 *     NOT auto-close — the user dismisses via X, "Subir nuevo
 *     archivo" (reset), or the "Asignar marbetes" link to /asociar.
 *
 * OTP grant (T3): while the session actor has an unexpired grant for
 * the marbete scope family the OTP input is hidden and the request
 * is submitted without the `x-otp-code` header. When no grant is
 * active the OTP input is required (scope marbete.bulk_create).
 */
export function BulkUploadDialog({
  open,
  onOpenChange,
  onSaved,
}: BulkUploadDialogProps): React.ReactElement {
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [otp, setOtp] = useState<string>('');
  const [view, setView] = useState<DialogView>('form');
  const [response, setResponse] = useState<BulkXlsxCreateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [stageStatuses, setStageStatuses] = useState<
    Partial<Record<BulkProcessingStage, BulkProcessingStageStatus>>
  >({});
  const [statusMessage, setStatusMessage] = useState<string>('Preparando carga...');
  const fileInputResetRef = useRef<HTMLInputElement | null>(null);
  const stageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const grant = useOtpGrant();

  // Refresh grant status whenever the dialog opens. The hook fetches
  // on mount, but if a parent toggles `open` without unmounting (e.g.
  // because the destructive op closed-and-reopened the same dialog)
  // we still want a fresh value.
  useEffect(() => {
    if (open) void grant.refresh();
    // grant.refresh is stable per the hook contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset on close.
  const reset = useCallback(() => {
    setSelectedFile(null);
    setOtp('');
    setView('form');
    setResponse(null);
    setError(null);
    setSubmitting(false);
    setProgress(0);
    setStageStatuses({});
    setStatusMessage('Preparando carga...');
    if (fileInputResetRef.current) fileInputResetRef.current.value = '';
    if (stageTimerRef.current) {
      clearTimeout(stageTimerRef.current);
      stageTimerRef.current = null;
    }
  }, []);

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function handleFileSelected(file: File) {
    setSelectedFile({ file, sizeLabel: formatFileSize(file.size) });
    setError(null);
  }

  /**
   * Reset back to the empty form (used by the "Subir nuevo archivo"
   * button on the result view). Preserves the OTP grant — if a
   * destructive grant was active, it should still be valid.
   */
  async function handleUploadAnother() {
    reset();
    await grant.refresh();
  }

  /**
   * Animate the 6 stages while the upload request runs. Returns a
   * promise that resolves once the animation has reached the last
   * stage and the result is ready to show. The orchestrator decides
   * when to flip from `processing` to `result` based on the upload
   * response.
   */
  const runStageAnimation = useCallback((): Promise<void> => {
    return new Promise((resolve) => {
      let stepIndex = 0;

      function tick() {
        if (stepIndex >= PROCESSING_STEPS.length) {
          setStatusMessage('Carga de marbetes completada.');
          resolve();
          return;
        }
        const step = PROCESSING_STEPS[stepIndex]!;
        setStageStatuses((prev) => ({ ...prev, [step.key]: 'active' }));
        setStatusMessage(step.message);
        stageTimerRef.current = setTimeout(() => {
          setStageStatuses((prev) => ({ ...prev, [step.key]: 'complete' }));
          setProgress(step.progress);
          stepIndex += 1;
          tick();
        }, STAGE_INTERVAL_MS);
      }

      tick();
    });
  }, []);

  /**
   * Fast-forward the stage animation to all-complete when the upload
   * finishes. Used so the user does not stare at a half-done spinner
   * if the server is faster than the animation.
   */
  const fastForwardStages = useCallback(() => {
    if (stageTimerRef.current) {
      clearTimeout(stageTimerRef.current);
      stageTimerRef.current = null;
    }
    const allComplete: Partial<
      Record<BulkProcessingStage, BulkProcessingStageStatus>
    > = {};
    for (const step of PROCESSING_STEPS) allComplete[step.key] = 'complete';
    setStageStatuses(allComplete);
    setProgress(100);
    setStatusMessage('Carga de marbetes completada.');
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedFile) return;
    const grantActive = grant.status?.active === true;
    if (!grantActive && otp.length !== 6) return;

    setSubmitting(true);
    setError(null);
    setView('processing');
    setProgress(0);
    setStageStatuses({});
    setStatusMessage('Preparando carga...');

    const animationPromise = runStageAnimation();

    try {
      const otpCode: string | undefined = grantActive ? undefined : otp;
      const resp = await bulkCreateMarbetesXlsx({
        file: selectedFile.file,
        otpCode,
      });

      // Wait for the stage animation to reach its end (or fast-forward
      // if the server was faster than the animation).
      if (stageTimerRef.current !== null) {
        // Animation still in flight; let it finish naturally.
        await animationPromise;
      } else {
        // Animation already completed; ensure stages show 100%.
        fastForwardStages();
      }

      setResponse(resp);
      // Tiny beat so the user can see the "complete" state before the
      // result panel swaps in.
      await waitMs(RESULT_TRANSITION_MS);
      setView('result');
      onSaved();
      // Refresh the grant: a successful destructive op may have minted
      // a fresh grant that the next dialog open should see.
      void grant.refresh();
    } catch (err) {
      fastForwardStages();
      const msg = errorMessageFor(err);
      setError(msg);
      setView('form');
    } finally {
      setSubmitting(false);
    }
  }

  const grantActive = grant.status?.active === true;
  const grantExpiresAt: string | null = grant.status?.expiresAt ?? null;
  const grantExpiresLabel = useMemo(() => {
    if (!grantExpiresAt) return null;
    return new Date(grantExpiresAt).toLocaleTimeString('es-MX', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [grantExpiresAt]);
  const canSubmit =
    selectedFile !== null && (grantActive || otp.length === 6) && !submitting;

  const dialogClassName = `bulk-upload__dialog bulk-upload__dialog--${view}`;

  // During processing we ignore Escape and outside clicks per canon
  // (the upload cannot be cancelled). Outside clicks on the form /
  // result views use the default Radix behavior (close on outside
  // click).
  const handleEscapeOutside = useCallback(
    (e: Event) => {
      if (view === 'processing') e.preventDefault();
    },
    [view],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className={dialogClassName}
        data-testid="bulk-upload-dialog"
        onEscapeKeyDown={handleEscapeOutside}
        onPointerDownOutside={handleEscapeOutside}
        onInteractOutside={handleEscapeOutside}
      >
        {view !== 'processing' ? (
          <DialogHeader>
            <div className="modal-dialog__icon" aria-hidden>
              <Upload />
            </div>
            <DialogTitle
              className="modal-dialog__title"
              data-testid="bulk-upload-title"
            >
              Carga masiva de marbetes
            </DialogTitle>
            <DialogDescription
              className="modal-dialog__description"
              id="bulk-upload-description"
            >
              Agrega varios marbetes al inventario mediante un archivo .xlsx.
            </DialogDescription>
          </DialogHeader>
        ) : null}

        {view === 'processing' ? (
          <BulkUploadProcessingOverlay
            progress={progress}
            statusMessage={statusMessage}
            stages={stageStatuses}
          />
        ) : null}

        {view === 'result' && response ? (
          <BulkUploadResult
            response={response}
            onUploadAnother={() => {
              void handleUploadAnother();
            }}
          />
        ) : null}

        {view === 'form' ? (
          <form
            onSubmit={handleSubmit}
            className="modal-dialog__content"
            noValidate
            data-testid="bulk-upload-form"
          >
            {error ? (
              <p
                role="alert"
                className="bulk-upload__error"
                data-testid="bulk-upload-form-error"
              >
                <svg
                  className="bulk-upload__error-icon"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  focusable="false"
                >
                  <circle cx={12} cy={12} r={9} />
                  <path d="M5.64 5.64 18.36 18.36" />
                </svg>
                <span>{error}</span>
              </p>
            ) : null}

            <div className="bulk-upload">
              <div className="bulk-upload__heading">
                <h2>Carga tu archivo .xlsx</h2>
                <p>
                  Selecciona un archivo .xlsx con los números de marbete que
                  deseas agregar al inventario.
                </p>
              </div>

              <BulkUploadDropzone
                selectedFile={selectedFile}
                onFileSelected={handleFileSelected}
              />

              <a
                className="btn btn--secondary bulk-upload__template-link"
                href="/backoffice/assets/plantilla-carga-masiva-marbetes.xlsx"
                download
                data-testid="bulk-upload-template-link"
              >
                <svg
                  className="btn__icon btn__icon--xlsx"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M14 2H6.75A1.75 1.75 0 0 0 5 3.75v16.5C5 21.22 5.78 22 6.75 22h10.5c.97 0 1.75-.78 1.75-1.75V7.75L14 2Z" />
                  <path d="M14 2v5.75h5" />
                  <path d="M8.5 16.5 11 14m0 2.5L8.5 14m4.75 2.5v-5m0 5h2.25" />
                </svg>
                <span>Descargar plantilla</span>
              </a>
              <p className="form-field__hint" data-testid="bulk-upload-template-hint">
                Usa la plantilla oficial para evitar errores de formato.
              </p>

              {grantActive && grantExpiresLabel ? (
                <p
                  className="bulk-upload__grant-note"
                  role="status"
                  data-testid="bulk-upload-grant-note"
                >
                  OTP vigente hasta {grantExpiresLabel}. No necesitas capturar
                  un código nuevo.
                </p>
              ) : (
                <div className="form-field bulk-upload__otp">
                  <span className="form-field__label form-field__label--row">
                    <span>Código OTP</span>
                    <span className="form-field__required">Obligatorio</span>
                  </span>
                  <div data-testid="bulk-upload-otp">
                    <OtpInput
                      mode="alphanumeric"
                      value={otp}
                      onChange={(v) => {
                        setOtp(v);
                        if (error) setError(null);
                      }}
                      disabled={submitting}
                      aria-label="Código OTP"
                    />
                  </div>
                </div>
              )}

              <div className="modal-dialog__actions">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                  disabled={submitting}
                >
                  Cancelar
                </Button>
                <Button
                  type="submit"
                  variant="default"
                  disabled={!canSubmit}
                  data-testid="bulk-upload-submit"
                >
                  {submitting
                    ? 'Cargando…'
                    : selectedFile
                      ? 'Subir archivo'
                      : 'Subir archivo'}
                </Button>
              </div>
            </div>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Promise-friendly sleep. */
function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}