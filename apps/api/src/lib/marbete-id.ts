/**
 * Helpers for marbete identity + masking.
 *
 *   - generatePublicUid(): operator-friendly id ("m-AB12CD")
 *   - sha256Hex():          sha256 of a code, used to populate code_hash
 *   - maskCode():           display-only mask ("3***24")
 *
 * Pure functions; safe to unit-test.
 */
import { createHash, randomBytes } from 'node:crypto';

const PUBLIC_UID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // confusable-free, 31 chars

export function generatePublicUid(): string {
  const bytes = randomBytes(4); // 4 bytes -> 5 base32 chars
  let out = 'm-';
  for (let i = 0; i < 4; i++) {
    const b = bytes[i] ?? 0;
    out += PUBLIC_UID_ALPHABET[b % PUBLIC_UID_ALPHABET.length];
  }
  return out;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Display mask: first 1 char + *** + last 2 chars. Falls back to *** for
 * codes shorter than 4 chars (defensive).
 */
export function maskCode(code: string): string {
  if (code.length <= 3) return '***';
  return `${code[0]}***${code.slice(-2)}`;
}

// ---- CSV parser (WU #3 / Polish WU v4) ----
//
// RFC-4180-lite. One code per row; quoted fields support embedded commas
// and double-quote escaping via `""`. A header row whose first non-empty
// trimmed field equals `code` (case-insensitive) is stripped silently.
// Lines beginning with `#` and empty lines are skipped without producing
// errors. Codes that don't match the operator-facing format are reported
// as `{line, message: 'invalid code format'}`. Line numbers are 1-based
// and reflect the original input; when a header is detected it occupies
// line 1 and is NOT counted in the returned `codes[].line`.
export interface ParsedCsvRow {
  code: string;
  line: number;
  raw: string;
}

export interface ParsedCsvError {
  line: number;
  message: string;
}

const CODE_FORMAT_REGEX = /^[A-Za-z0-9._\-:]{8,128}$/;

export function parseCsvCodes(text: string): {
  codes: ParsedCsvRow[];
  errors: ParsedCsvError[];
} {
  const codes: ParsedCsvRow[] = [];
  const errors: ParsedCsvError[] = [];

  const rawLines = text.split(/\r?\n/);
  // Drop a single trailing empty line so a file ending in `\n` doesn't
  // register an empty "row".
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }

  let hasHeader = false;
  for (let i = 0; i < rawLines.length; i += 1) {
    const rawLine = rawLines[i] ?? '';
    const lineNumber = i + 1; // 1-based, header is line 1
    const trimmed = rawLine.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('#')) continue;

    if (!hasHeader) {
      // Detect the header by the first non-empty field of the row.
      const firstField = readFirstField(rawLine).trim().toLowerCase();
      if (firstField === 'code') {
        hasHeader = true;
        continue;
      }
    }

    // Each row is a single code, but allow quoted form with embedded commas.
    const fields = parseCsvLine(rawLine);
    const code = fields.length > 0 ? (fields[0] ?? '') : '';
    if (!CODE_FORMAT_REGEX.test(code)) {
      errors.push({ line: lineNumber, message: 'invalid code format' });
      continue;
    }
    codes.push({ code, line: lineNumber, raw: rawLine });
  }

  return { codes, errors };
}

/**
 * Parse a single CSV row into its fields, honoring double-quoted fields
 * with embedded commas and the `""` -> `"` escape. Used by parseCsvCodes
 * for the header-detection sniff (first field only) and for the per-row
 * code value.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
        if (ch === '"') {
          const next = line[i + 1];
          if (next === '"') {
            cur += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
        } else {
          cur += ch ?? '';
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(cur);
        cur = '';
      } else {
        cur += ch ?? '';
      }
  }
  fields.push(cur);
  return fields;
}

/**
 * Return just the first field of a CSV row, applying the same quoting
 * rules as parseCsvLine but stopping at the first unquoted comma.
 */
function readFirstField(line: string): string {
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        const next = line[i + 1];
        if (next === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch ?? '';
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      return cur;
    } else {
      cur += ch ?? '';
    }
  }
  return cur;
}
