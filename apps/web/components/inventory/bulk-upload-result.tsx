'use client';

import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { BulkXlsxCreateResponse, BulkFailureCategory } from '@quorum-backoffice/shared';

export interface BulkUploadResultProps {
  response: BulkXlsxCreateResponse;
  /** Reset the dialog back to the empty state. */
  onUploadAnother: () => void;
}

interface MetricDefinition {
  category: BulkFailureCategory;
  label: string;
  /** Inline SVG icon (24x24 viewBox) per canon. */
  icon: React.ReactNode;
}

const METRIC_DEFINITIONS: ReadonlyArray<MetricDefinition> = [
  {
    category: 'length_out_of_range',
    label: 'Dígitos faltantes o sobrantes',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="m12 4 9 16H3L12 4Z" />
        <path d="M12 10v4" />
        <path d="M12 17h.01" />
      </svg>
    ),
  },
  {
    category: 'invalid_chars',
    label: 'Caracteres inválidos',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx={12} cy={12} r={8} />
        <path d="m7.75 7.75 8.5 8.5" />
      </svg>
    ),
  },
  {
    category: 'duplicate_in_file',
    label: 'Duplicado',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x={7} y={7} width={12} height={12} rx={2} />
        <path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
      </svg>
    ),
  },
  {
    category: 'already_exists',
    label: 'Ya registrado',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x={5} y={3} width={14} height={18} rx={2} />
        <path d="M8 8h8M8 12h4m-3 4 1.5 1.5L14 14" />
      </svg>
    ),
  },
];

/**
 * Decode a base64 string into a `Uint8Array` (browser + jsdom).
 *
 * `atob` is available in both modern browsers and jsdom (which the
 * API client tests use). The caller wraps the result in a `Blob` so
 * the browser still drives the actual download dialog.
 */
function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Result view shown after the server resolves the bulk-xlsx call.
 *
 * Per canon (.bulk-upload__result in bulk-marbet-upload.css):
 * - Heading "Carga procesada" + summary "Se cargaron correctamente N
 *   marbetes. Los registros con errores no se agregaron al inventario."
 * - Summary line "M errores encontrados de N filas registradas en el
 *   .xlsx"
 * - 4 metric cards mapped from `categoryCounts` to the canon's
 *   "Dígitos faltantes o sobrantes" / "Caracteres inválidos" /
 *   "Duplicado" / "Ya registrado" labels
 * - Actions: "Subir nuevo archivo" (resets to empty state) + primary
 *   "Asignar marbetes" linking to /asociar
 * - Errors file auto-download: when `response.errorsFile` is present
 *   we decode the base64 workbook and trigger a hidden anchor click.
 *   The status block also surfaces "Archivo de errores generado" with
 *   a retry download link ("¿No se descargó el archivo? Descárgalo
 *   aquí.") in case the auto-download was blocked.
 *
 * The audit id line is shown when space allows.
 */
export function BulkUploadResult({
  response,
  onUploadAnother,
}: BulkUploadResultProps): React.ReactElement {
  const { total, created, failed, categoryCounts, errorsFile, auditId } = response;
  const hasErrors = errorsFile !== null;
  const downloadTriggeredRef = useRef<boolean>(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  const triggerDownload = useCallback((file: NonNullable<typeof errorsFile>) => {
    const bytes = decodeBase64(file.contentBase64);
    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Keep the URL around so the manual retry link can re-use it;
    // revoke on unmount.
    return url;
  }, []);

  // Auto-download the errors workbook on mount when present. The ref
  // ensures we only fire once per mount (React 19 Strict Mode invokes
  // effects twice in dev — without the guard we'd double-trigger).
  useEffect(() => {
    if (!hasErrors || !errorsFile) return;
    if (downloadTriggeredRef.current) return;
    downloadTriggeredRef.current = true;
    try {
      const url = triggerDownload(errorsFile);
      setDownloadUrl(url);
    } catch {
      // The auto-download failed (browser security policy, SSR, etc.).
      // The manual retry link still works once we have a usable URL.
    }
  }, [hasErrors, errorsFile, triggerDownload]);

  useEffect(() => {
    return () => {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    };
  }, [downloadUrl]);

  return (
    <section
      className="bulk-upload__result"
      data-testid="bulk-upload-result"
      aria-labelledby="bulk-upload-result-title"
    >
      <div className="bulk-upload__result-heading">
        <span className="bulk-upload__result-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path
              d="M14 2H6.75A1.75 1.75 0 0 0 5 3.75v16.5C5 21.22 5.78 22 6.75 22h10.5A1.75 1.75 0 0 0 19 20.25V7.75L14 2Z"
              fill="none"
              stroke="currentColor"
              strokeLinejoin="round"
              strokeWidth={1.75}
            />
            <path
              d="M14 2v5.75h5m-9.25 7.5 1.75 1.75 3.75-4"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.75}
            />
          </svg>
        </span>
        <div className="bulk-upload__result-copy">
          <h3 id="bulk-upload-result-title">Carga procesada</h3>
          <p data-testid="bulk-upload-result-summary">
            Se cargaron{' '}
            <strong>correctamente {created} marbetes</strong>. Los registros
            con errores no se agregaron al inventario.
          </p>
        </div>
      </div>

      <div className="bulk-upload__result-overview">
        <div
          className="bulk-upload__result-summary"
          role="status"
          aria-live="polite"
          data-testid="bulk-upload-result-errors-summary"
        >
          <span>
            <strong data-testid="bulk-upload-result-error-count">
              {failed} errores encontrados
            </strong>{' '}
            de {total} filas registradas en el .xlsx
          </span>
        </div>

        <div
          className="bulk-upload__result-metrics"
          aria-label="Resumen de errores encontrados"
          data-testid="bulk-upload-result-metrics"
        >
          {METRIC_DEFINITIONS.map((metric) => {
            const count = categoryCounts[metric.category] ?? 0;
            return (
              <article
                key={metric.category}
                className="bulk-upload__result-metric"
                data-testid={`bulk-upload-result-metric-${metric.category}`}
              >
                <span
                  className="bulk-upload__result-metric-icon"
                  aria-hidden="true"
                >
                  {metric.icon}
                </span>
                <span>{metric.label}</span>
                <strong>{count}</strong>
              </article>
            );
          })}
        </div>
      </div>

      <div className="bulk-upload__actions">
        <button
          type="button"
          className="btn btn--secondary bulk-upload__replace-button"
          onClick={onUploadAnother}
          data-testid="bulk-upload-upload-another"
        >
          Subir nuevo archivo
        </button>
        <Link
          href="/asociar"
          className="btn btn--primary"
          data-testid="bulk-upload-assign"
          onClick={() => {
            // Closing the dialog keeps the focus on the parent trigger
            // so the user lands cleanly on the assignment page.
          }}
        >
          Asignar marbetes
        </Link>
      </div>

      {auditId !== null ? (
        <p className="bulk-upload__audit" data-testid="bulk-upload-audit">
          Auditoría: registro #{auditId}
        </p>
      ) : null}

      {hasErrors && errorsFile ? (
        <div
          className="bulk-upload__result-status"
          data-testid="bulk-upload-errors-file"
        >
          <span className="bulk-upload__result-status-icon" aria-hidden="true">
            <svg viewBox="0 0 64 64" focusable="false">
              <path
                className="bulk-upload__xlsx-page"
                d="M18 6h24l12 12v40H18V6Z"
              />
              <path className="bulk-upload__xlsx-fold" d="M42 6v12h12" />
              <rect
                className="bulk-upload__xlsx-label"
                x={4}
                y={13}
                width={36}
                height={15}
                rx={4}
              />
              <path
                className="bulk-upload__xlsx-grid"
                d="M21 35h27v14H21V35Zm9 0v14m9-14v14M21 42h27"
              />
              <circle
                className="bulk-upload__xlsx-download-bg"
                cx={47}
                cy={49}
                r={12}
              />
              <path className="bulk-upload__xlsx-download" d="M47 44v9" />
              <path
                className="bulk-upload__xlsx-download"
                d="m42.75 49 4.25 4.25 4.25-4.25"
              />
              <text
                className="bulk-upload__xlsx-text"
                x={8}
                y={24}
              >
                .xlsx
              </text>
            </svg>
          </span>
          <div className="bulk-upload__result-status-content">
            <strong className="bulk-upload__result-status-title">
              Archivo de errores generado
            </strong>
            <span>
              Descargamos automáticamente un archivo .xlsx de errores con
              los marbetes que no se cargaron y el motivo de cada error.{' '}
              <strong>
                Puedes corregirlo y usarlo como base para volver a subir los
                registros faltantes
              </strong>
              .
            </span>
            <span className="bulk-upload__result-download-help">
              ¿No se descargó el archivo?{' '}
              <a
                className="bulk-upload__result-download"
                href={downloadUrl ?? '#'}
                download={errorsFile?.fileName ?? 'errores.xlsx'}
                aria-disabled={downloadUrl === null}
                data-testid="bulk-upload-errors-retry"
                onClick={(e) => {
                  // If we have a fresh object URL the anchor's default
                  // behaviour handles it; if not, re-trigger a new
                  // download attempt in case the first one was blocked.
                  if (!downloadUrl) {
                    e.preventDefault();
                    try {
                      const url = triggerDownload(errorsFile);
                      setDownloadUrl(url);
                    } catch {
                      /* nothing more we can do */
                    }
                  }
                }}
              >
                Descárgalo aquí.
              </a>
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}