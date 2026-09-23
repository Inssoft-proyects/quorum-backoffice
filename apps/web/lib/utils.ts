import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Combine class names safely with Tailwind-aware deduplication.
 *
 * Tailwind utilities applied later win; later class names override earlier
 * ones for conflicting properties.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
