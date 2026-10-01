'use client';

import * as React from 'react';

export type BulkProcessingStage =
  | 'read'
  | 'rows'
  | 'format'
  | 'duplicates'
  | 'existing'
  | 'result';

export type BulkProcessingStageStatus = 'pending' | 'active' | 'complete';

export interface BulkUploadProcessingOverlayProps {
  /** Current overall progress percentage (0–100). */
  progress: number;
  /** Human-readable status line shown above the progress bar. */
  statusMessage: string;
  /** Per-stage status, keyed by stage name. Missing keys render as 'pending'. */
  stages: Partial<Record<BulkProcessingStage, BulkProcessingStageStatus>>;
}

interface StageDefinition {
  key: BulkProcessingStage;
  label: string;
}

const PROCESSING_STAGES: ReadonlyArray<StageDefinition> = [
  { key: 'read', label: 'Leer plantilla .xlsx' },
  { key: 'rows', label: 'Preparar marbetes detectados' },
  { key: 'format', label: 'Validar formato de los números' },
  { key: 'duplicates', label: 'Buscar duplicados en el archivo' },
  { key: 'existing', label: 'Comprobar registros existentes' },
  { key: 'result', label: 'Asignar fecha de vencimiento y estado Disponible' },
];

/**
 * 6-stage processing checklist + progress bar + status line.
 *
 * Per canon (.bulk-upload__processing-dialog in bulk-marbet-upload.css):
 * renders the spinner icon, title, description, progress bar with
 * percentage, the 6-stage checklist (with data-stage-status driving
 * the active/complete styling), and the trailing note. The dialog
 * layer above prevents close-on-Escape; the orchestrator is
 * responsible for that wiring.
 *
 * The component is pure presentation: the parent owns the stage /
 * progress state machine.
 */
export function BulkUploadProcessingOverlay({
  progress,
  statusMessage,
  stages,
}: BulkUploadProcessingOverlayProps): React.ReactElement {
  const clampedProgress = Math.max(0, Math.min(100, Math.round(progress)));
  return (
    <div className="bulk-upload__processing" data-testid="bulk-upload-processing">
      <div className="modal-dialog__icon bulk-upload__processing-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path
            d="M12 3a9 9 0 1 0 9 9"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth={2}
          />
          <path
            d="M12 7v5l3 2"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
          />
        </svg>
      </div>

      <h2 className="modal-dialog__title" data-testid="bulk-upload-processing-title">
        Estamos cargando tus marbetes
      </h2>
      <p className="modal-dialog__description" data-testid="bulk-upload-processing-description">
        Estamos leyendo el archivo .xlsx y preparando los marbetes para
        agregarlos al inventario. No cierres esta ventana.
      </p>

      <div className="bulk-upload__progress-block">
        <div className="bulk-upload__progress-label">
          <span data-testid="bulk-upload-processing-status" aria-live="polite">
            {statusMessage}
          </span>
          <strong data-testid="bulk-upload-processing-percentage">
            {clampedProgress}%
          </strong>
        </div>
        <div
          className="bulk-upload__progress-track"
          role="progressbar"
          aria-label="Progreso de carga de marbetes"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={clampedProgress}
        >
          <span
            className="bulk-upload__progress-value"
            style={{ width: `${clampedProgress}%` }}
          />
        </div>
      </div>

      <ol
        className="bulk-upload__checklist"
        aria-label="Etapas de carga"
        data-testid="bulk-upload-checklist"
      >
        {PROCESSING_STAGES.map((stage) => {
          const status = stages[stage.key] ?? 'pending';
          return (
            <li
              key={stage.key}
              className="bulk-upload__checklist-item"
              data-processing-stage={stage.key}
              data-stage-status={status}
              data-testid={`bulk-upload-stage-${stage.key}`}
            >
              <span className="bulk-upload__checklist-icon" aria-hidden="true" />
              <span>{stage.label}</span>
            </li>
          );
        })}
      </ol>

      <p className="bulk-upload__processing-note">
        Este proceso puede tardar unos segundos según el tamaño del archivo.
      </p>
    </div>
  );
}