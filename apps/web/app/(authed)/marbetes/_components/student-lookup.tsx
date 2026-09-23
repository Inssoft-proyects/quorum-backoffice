'use client';
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { ApiError, getStudentByCanvasId, type StudentDetailResponse } from '@/lib/api-client';

interface Props {
  /** Controlled canvasUserId. Empty string means "no value yet"; null means "explicit unassign". */
  value: number | null | '';
  onChange: (v: number | null | '') => void;
  disabled?: boolean;
}

type LookupState = 'idle' | 'loading' | 'found' | 'not_found' | 'inactive' | 'error';

/**
 * Reusable canvasUserId input with on-blur student resolution.
 *
 * Behaviour:
 *   - The parent owns `value` (a controlled number, '', or null).
 *   - Internally we keep a `lookupId` that triggers a fetch in a useEffect
 *     when it changes. We seed it from the initial value so an edit dialog
 *     opening on an already-assigned marbete resolves the student name on
 *     mount, before any blur.
 *   - On blur, if the input differs from the last resolved id, we re-fetch.
 *   - "Quitar asignación" sets the parent value to null and resets local
 *     lookup state.
 *   - Errors are mapped to small Spanish strings; the actual API enforcement
 *     (student_not_found / student_not_active) lives server-side and is
 *     caught again at submit time.
 */
export function StudentLookup({ value, onChange, disabled }: Props) {
  const [state, setState] = useState<LookupState>('idle');
  const [student, setStudent] = useState<StudentDetailResponse | null>(null);
  const [lookupId, setLookupId] = useState<number | null>(
    typeof value === 'number' ? value : null,
  );

  useEffect(() => {
    if (lookupId === null) {
      setStudent(null);
      if (state !== 'idle') setState('idle');
      return;
    }
    let cancelled = false;
    setState('loading');
    (async () => {
      try {
        const s = await getStudentByCanvasId(lookupId);
        if (cancelled) return;
        setStudent(s);
        setState(s.isActive ? 'found' : 'inactive');
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setStudent(null);
          setState('not_found');
        } else {
          setStudent(null);
          setState('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `state` is intentionally excluded from deps: updating it inside
    // this effect would re-trigger the effect and create a fetch loop.
  }, [lookupId]);

  function commitLookup(id: number | null) {
    setLookupId(id);
    onChange(id);
  }

  function handleBlur() {
    const num = typeof value === 'number' ? value : value === '' ? null : Number(value);
    if (!Number.isFinite(num) || num === null) return;
    if (num !== lookupId) setLookupId(num);
  }

  function handleUnassign() {
    setStudent(null);
    setState('idle');
    commitLookup(null);
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="student-lookup">
      <div className="flex items-end gap-2">
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          placeholder="12345"
          value={value === null ? '' : String(value)}
          onChange={(e) => {
            const raw = e.target.value.trim();
            if (raw === '') onChange('');
            else onChange(Number(raw));
          }}
          onBlur={handleBlur}
          disabled={disabled}
          data-testid="student-canvas-id"
          aria-label="Matrícula Canvas"
        />
        <button
          type="button"
          onClick={handleUnassign}
          disabled={disabled || value === '' || value === null}
          className="h-9 rounded-md border border-border bg-background px-2 text-xs text-text-muted hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="student-unassign"
        >
          Quitar asignación
        </button>
      </div>
      {state === 'loading' ? (
        <p className="text-xs text-text-muted" data-testid="student-state">
          Buscando…
        </p>
      ) : null}
      {state === 'found' && student ? (
        <p className="text-xs text-feedback-success" data-testid="student-state">
          {student.fullName} ({student.email}) — Activa
        </p>
      ) : null}
      {state === 'inactive' && student ? (
        <p className="text-xs text-alert-error-text" data-testid="student-state">
          {student.fullName} ({student.email}) — Inactiva en Canvas
        </p>
      ) : null}
      {state === 'not_found' ? (
        <p className="text-xs text-alert-error-text" data-testid="student-state">
          Matrícula no encontrada en cache. Sincronice desde Canvas primero.
        </p>
      ) : null}
      {state === 'error' ? (
        <p className="text-xs text-alert-error-text" data-testid="student-state">
          Error de red al consultar la matrícula.
        </p>
      ) : null}
    </div>
  );
}