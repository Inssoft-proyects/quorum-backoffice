'use client';

import * as React from 'react';
import { useCallback, useRef, useState } from 'react';

export interface SelectedFile {
  file: File;
  /** Pre-formatted size label (e.g. "12 KB") for display. */
  sizeLabel: string;
}

export interface BulkUploadDropzoneProps {
  /** Currently selected file (null → empty state, set → selected state). */
  selectedFile: SelectedFile | null;
  /** Called with the selected File when a valid .xlsx is picked. */
  onFileSelected: (file: File) => void;
}

/**
 * Dropzone sub-tree for the marbetes .xlsx bulk-upload modal.
 *
 * Per canon (.bulk-upload__dropzone in bulk-marbet-upload.css): dashed
 * dropzone with an empty state (icon + prompt + "Seleccionar archivo"
 * button + format hint) and a selected state (file row + "Datos
 * generados automáticamente" explainer + 3-year-validity rule). An
 * inline error block surfaces the canon copy when the user picks a
 * non-.xlsx file.
 *
 * Drag-and-drop, click-to-pick, and re-pick all funnel through the
 * same `onFileSelected` callback; the parent decides whether the
 * file actually triggers an upload.
 */
export function BulkUploadDropzone({
  selectedFile,
  onFileSelected,
}: BulkUploadDropzoneProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isXlsxFile = useCallback((file: File | null | undefined): boolean => {
    return Boolean(file?.name?.toLowerCase().endsWith('.xlsx'));
  }, []);

  const handlePick = useCallback(
    (file: File | null | undefined) => {
      if (!file) return;
      if (!isXlsxFile(file)) {
        if (inputRef.current) inputRef.current.value = '';
        setErrorMessage(
          'El archivo seleccionado no es válido. Utiliza un archivo en formato .xlsx.',
        );
        return;
      }
      setErrorMessage(null);
      onFileSelected(file);
    },
    [isXlsxFile, onFileSelected],
  );

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    handlePick(e.target.files?.[0]);
  }

  function handleDragEnter(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragging(true);
  }

  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setIsDragging(false);
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    handlePick(e.dataTransfer.files?.[0]);
  }

  const dropzoneClasses = ['bulk-upload__dropzone'];
  if (isDragging) dropzoneClasses.push('is-dragging');
  if (errorMessage) dropzoneClasses.push('is-error');

  const hasFile = selectedFile !== null;

  return (
    <div
      className={dropzoneClasses.join(' ')}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-testid="bulk-upload-dropzone"
    >
      <div
        className="bulk-upload__empty-state"
        hidden={hasFile}
        data-testid="bulk-upload-empty-state"
      >
        <span className="bulk-upload__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path
              d="M14 2H6.75A1.75 1.75 0 0 0 5 3.75v16.5C5 21.22 5.78 22 6.75 22h10.5c.97 0 1.75-.78 1.75-1.75V7.75L14 2Z"
              fill="none"
              stroke="currentColor"
              strokeLinejoin="round"
              strokeWidth={1.75}
            />
            <path
              d="M14 2v5.75h5M12 17v-7m0 0-2.5 2.5M12 10l2.5 2.5"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.75}
            />
          </svg>
        </span>
        <p className="bulk-upload__prompt">Arrastra y suelta tu archivo aquí</p>
        <span className="bulk-upload__or" aria-hidden="true">
          o
        </span>
        <label
          className="btn btn--primary bulk-upload__select-button"
          htmlFor="bulk-upload-file-input"
          data-testid="bulk-upload-select-button"
        >
          Seleccionar archivo
        </label>
        <p className="bulk-upload__format">
          Formato permitido: <strong>.xlsx</strong>
        </p>
      </div>

      <div
        className="bulk-upload__selected-state"
        hidden={!hasFile}
        data-testid="bulk-upload-selected-state"
      >
        {hasFile ? (
          <>
            <div
              className="bulk-upload__selected-file"
              data-testid="bulk-upload-selected-file"
            >
              <span className="bulk-upload__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                  <path
                    d="M14 2H6.75A1.75 1.75 0 0 0 5 3.75v16.5C5 21.22 5.78 22 6.75 22h10.5c.97 0 1.75-.78 1.75-1.75V7.75L14 2Z"
                    fill="none"
                    stroke="currentColor"
                    strokeLinejoin="round"
                    strokeWidth={1.75}
                  />
                  <path
                    d="M14 2v5.75h5"
                    fill="none"
                    stroke="currentColor"
                    strokeLinejoin="round"
                    strokeWidth={1.75}
                  />
                  <path
                    d="m9.25 15 1.75 1.75 3.75-4"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.75}
                  />
                </svg>
              </span>
              <div className="bulk-upload__file-details">
                <strong
                  className="bulk-upload__file-name"
                  title={selectedFile!.file.name}
                  data-testid="bulk-upload-file-name"
                >
                  {selectedFile!.file.name}
                </strong>
                <span data-testid="bulk-upload-file-size">
                  {selectedFile!.sizeLabel}
                </span>
              </div>
            </div>

            <div
              className="bulk-upload__generated"
              aria-labelledby="generated-data-title"
            >
              <h3 id="generated-data-title">Datos generados automáticamente</h3>
              <p>
                Al procesar el archivo, el sistema generará el ID interno, la
                fecha de carga, la fecha de vencimiento y el estado inicial{' '}
                <strong>Disponible</strong>.
              </p>
              <p className="bulk-upload__generated-rule">
                Fecha de vencimiento = Fecha de carga + 3 años
              </p>
            </div>
          </>
        ) : null}
      </div>

      <input
        ref={inputRef}
        id="bulk-upload-file-input"
        className="bulk-upload__file-input"
        type="file"
        accept=".xlsx"
        onChange={handleInputChange}
        data-testid="bulk-upload-file-input"
        aria-label="Seleccionar archivo .xlsx"
      />

      <p
        className="bulk-upload__error"
        role="alert"
        hidden={!errorMessage}
        data-testid="bulk-upload-error"
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
        <span>{errorMessage ?? ''}</span>
      </p>
    </div>
  );
}

/**
 * Format a byte count using es-MX thousands grouping and KB / MB /
 * GB units. Mirrors `formatFileSize` in bulk-marbet-upload.js.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const units = ['bytes', 'KB', 'MB', 'GB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  const maximumFractionDigits = unitIndex === 0 ? 0 : value < 10 ? 1 : 0;
  return `${new Intl.NumberFormat('es-MX', { maximumFractionDigits }).format(value)} ${units[unitIndex]}`;
}