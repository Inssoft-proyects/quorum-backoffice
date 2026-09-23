import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface MaskedNumberProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** The masked code shown by default (e.g. "9***176"). */
  value: string;
  /**
   * Optional unmasked value. When provided, the masked text is replaced
   * with the unmasked digits and the chip flips from "Oculto" (eye-off)
   * to "Revelado" (eye).
   */
  revealed?: string;
}

/**
 * Renders the maquette's "credential cell": a tabular monospace mask and a
 * small privacy chip showing whether the value is hidden or has been
 * revealed. Used inside the table No. Marbete column.
 */
export function MaskedNumber({
  value,
  revealed,
  className,
  ...props
}: MaskedNumberProps) {
  const isRevealed = Boolean(revealed);
  const display = revealed ?? value;
  return (
    <span
      className={cn('credential-cell', className)}
      data-testid="masked-number"
      data-revealed={isRevealed ? 'true' : 'false'}
      {...props}
    >
      <span className="credential-mask">{display}</span>
      <span
        className={cn('privacy-chip', isRevealed && 'privacy-chip--revealed')}
        aria-label={isRevealed ? 'Revelado' : 'Oculto'}
      >
        {isRevealed ? (
          <Eye className="privacy-chip__icon" aria-hidden />
        ) : (
          <EyeOff className="privacy-chip__icon" aria-hidden />
        )}
        <span>{isRevealed ? 'Revelado' : 'Oculto'}</span>
      </span>
    </span>
  );
}
