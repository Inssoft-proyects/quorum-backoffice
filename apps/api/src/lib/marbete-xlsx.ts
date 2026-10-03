/**
 * .xlsx bulk-marbete parser + helpers.
 *
 * Drives the POST /api/v1/marbetes/bulk-xlsx route. Per the design canon
 * (carga-masiva-marbetes.html) the upload is a single .xlsx with:
 *
 *   - First worksheet named "Marbetes" (or whatever the user chose).
 *   - Header row 1 in column A: "Número de marbete" (case- and
 *     accent-insensitive). Any other header fails the file outright
 *     (`xlsx_parse_failed`).
 *   - Row 2 is the template's example row (the literal value
 *     "123456789") — we count it as `skippedExampleRows` and move on,
 *     no failure recorded.
 *   - Real records from row 3 onward. One code per row, column A only;
 *     extra columns are ignored.
 *
 * Validation per the design's error taxonomy:
 *   - 'invalid_chars'        : code contains non-digit characters
 *   - 'length_out_of_range'  : code length is outside 8..128
 *   - 'duplicate_in_file'    : same code appears more than once
 *   - 'already_exists'       : code is already in the inventory
 *                              (populated by MarbetesService.bulkCreate,
 *                               not by this module)
 *   - 'other'                : catch-all
 *
 * Pure functions over a `Buffer`; no DB access, no Fastify, no session.
 * The route layer is responsible for base64 decoding, size enforcement,
 * OTP, and the actual inventory insert.
 */
import ExcelJS from 'exceljs';
import { Buffer } from 'node:buffer';
import type { BulkFailureCategory } from '@quorum-backoffice/shared';

/** Hard cap on the decoded workbook size (5 MB). */
export const XLSX_MAX_DECODED_BYTES = 5 * 1024 * 1024;

/** Code length range shared with the JSON /bulk endpoint. */
export const CODE_MIN_LENGTH = 8;
export const CODE_MAX_LENGTH = 128;

/** Example row emitted by the template generator; skipped, not failed. */
export const EXAMPLE_CODE = '123456789';

/**
 * Header variants we accept in row 1, column A. Compared after
 * trim+lowercase+diacritic-strip. The Spanish title uses an acute
 * accent over the "u"; users routinely strip accents in spreadsheets.
 */
const HEADER_CANONICAL = 'numero de marbete';

/** Stable machine-readable category for a per-row failure.
 *  Single source of truth: the Zod-derived type in
 *  packages/shared/src/dto/marbete.ts (re-exported for local callers). */
export type { BulkFailureCategory };

/** Per-row failure surfaced to the operator. */
export interface XlsxRowFailure {
  /** 1-based row number in the original xlsx. */
  xlsxRow: number;
  /** Raw code value as the parser saw it (already stringified). */
  code: string;
  category: BulkFailureCategory;
  /** Human-readable Spanish reason, ready to render in the UI. */
  reason: string;
}

/** A row that passed all parser-side validation and is ready for bulkCreate. */
export interface XlsxSurvivor {
  /** Position in the survivors list (also the index into bulkCreate.items). */
  index: number;
  /** 1-based row number in the original xlsx. */
  xlsxRow: number;
  code: string;
}

export type ParseErrorCode = 'xlsx_parse_failed' | 'xlsx_too_large';

export interface ParseXlsxResult {
  /** null when the workbook had no "Número de marbete" header on row 1. */
  header: { row: number; text: string } | null;
  /** Non-null when the whole file should be rejected before per-row work. */
  parseError: ParseErrorCode | null;
  /** Codes ready to hand to MarbetesService.bulkCreate (order = xlsx order). */
  survivors: XlsxSurvivor[];
  /** Per-row failures (not including already_exists; that comes from DB). */
  failures: XlsxRowFailure[];
  /** Number of rows that matched the template's example row and were skipped. */
  skippedExampleRows: number;
}

/**
 * Spanish label for each failure category. Stable contract for the UI
 * and the generated errors workbook's "Categoría" column.
 */
export const CATEGORY_REASON_ES: Record<BulkFailureCategory, string> = {
  length_out_of_range: 'Dígitos faltantes o sobrantes',
  invalid_chars: 'Caracteres inválidos',
  duplicate_in_file: 'Duplicado',
  already_exists: 'Ya registrado',
  other: 'Otro motivo',
};

/**
 * Normalize a header cell value: trim, lowercase, strip diacritics.
 * Used both to detect the header on row 1 and to make error matching
 * tolerant of the most common operator typos.
 */
function normalizeHeader(input: unknown): string {
  if (input === null || input === undefined) return '';
  const raw = String(input).trim().toLowerCase();
  // Strip combining diacritics (NFD + remove combining marks). The
  // Spanish title "Número" uses U+0302 (combining acute).
  return raw.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

/** Coerce an ExcelJS cell to a flat string (handles formula-result objects). */
function cellToString(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    // ExcelJS surfaces formula results as { formula, result }.
    const r = (v as { result?: unknown }).result;
    if (r === null || r === undefined) return '';
    if (typeof r === 'object') {
      // Hyperlinks / rich text: take the visible text if available.
      const t = (r as { text?: unknown }).text;
      return t === null || t === undefined ? '' : String(t);
    }
    return String(r);
  }
  return String(v);
}

/** True when every character is an ASCII digit. */
function isDigitOnly(s: string): boolean {
  return /^[0-9]+$/.test(s);
}

/**
 * Classify a single raw cell value against the design taxonomy. Returns
 * `null` for a code that passes both digit-only and length checks.
 */
function classifyFormat(raw: string): BulkFailureCategory | null {
  if (!isDigitOnly(raw)) return 'invalid_chars';
  if (raw.length < CODE_MIN_LENGTH || raw.length > CODE_MAX_LENGTH) {
    return 'length_out_of_range';
  }
  return null;
}

/**
 * Parse an .xlsx buffer.
 *
 * Behaviour:
 *   - Reject buffers larger than {@link XLSX_MAX_DECODED_BYTES}
 *     outright (`parseError = 'xlsx_too_large'`).
 *   - Reject buffers that fail to load as a workbook, or whose first
 *     sheet has a row-1, column-A header that is not one of the
 *     canonical "Número de marbete" variants (`parseError =
 *     'xlsx_parse_failed'`).
 *   - Otherwise walk column A: skip the header, skip the example row,
 *     skip empty rows, classify every non-empty value, detect
 *     duplicates among the valid survivors (first occurrence wins).
 */
export async function parseXlsxBuffer(buffer: Buffer): Promise<ParseXlsxResult> {
  if (buffer.length > XLSX_MAX_DECODED_BYTES) {
    return emptyResult('xlsx_too_large');
  }

  let workbook: ExcelJS.Workbook;
  try {
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
  } catch {
    return emptyResult('xlsx_parse_failed');
  }

  const ws = workbook.worksheets[0];
  if (!ws) {
    return emptyResult('xlsx_parse_failed');
  }

  // Header check: row 1, column A.
  const headerRow = ws.getRow(1);
  const headerText = cellToString(headerRow.getCell(1));
  if (normalizeHeader(headerText) !== HEADER_CANONICAL) {
    return emptyResult('xlsx_parse_failed');
  }

  const failures: XlsxRowFailure[] = [];
  const survivors: XlsxSurvivor[] = [];
  let skippedExampleRows = 0;

  // Track first-seen xlsx row for each valid code so we can attribute
  // duplicates back to the right row.
  const firstSeenByCode = new Map<string, number>();

  // Walk row 2 onward. We intentionally use rowCount from ExcelJS so
  // empty trailing rows don't loop forever; the cell-value check below
  // skips them.
  const lastRow = ws.rowCount;
  for (let r = 2; r <= lastRow; r += 1) {
    const cell = ws.getRow(r).getCell(1);
    const raw = cellToString(cell).trim();
    if (raw === '') {
      // Empty row: skip silently.
      continue;
    }
    if (raw === EXAMPLE_CODE) {
      skippedExampleRows += 1;
      continue;
    }

    const category = classifyFormat(raw);
    if (category !== null) {
      failures.push({
        xlsxRow: r,
        code: raw,
        category,
        reason: CATEGORY_REASON_ES[category],
      });
      continue;
    }

    const firstSeenRow = firstSeenByCode.get(raw);
    if (firstSeenRow !== undefined) {
      failures.push({
        xlsxRow: r,
        code: raw,
        category: 'duplicate_in_file',
        reason: CATEGORY_REASON_ES.duplicate_in_file,
      });
      continue;
    }

    firstSeenByCode.set(raw, r);
    survivors.push({ index: survivors.length, xlsxRow: r, code: raw });
  }

  return {
    header: { row: 1, text: headerText },
    parseError: null,
    survivors,
    failures,
    skippedExampleRows,
  };
}

function emptyResult(parseError: ParseErrorCode): ParseXlsxResult {
  return {
    header: null,
    parseError,
    survivors: [],
    failures: [],
    skippedExampleRows: 0,
  };
}

/**
 * Build the in-memory .xlsx "Errores" workbook that the operator can
 * download to fix and re-upload. Columns:
 *   Fila | Número de marbete | Categoría | Motivo
 *
 * Header + at least one data row required so the file is never
 * accidental-empty. The caller decides whether to attach it to the
 * response based on the failures count.
 */
export async function buildXlsxErrorsWorkbook(
  failures: XlsxRowFailure[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Errores');
  ws.columns = [
    { header: 'Fila', key: 'fila', width: 8 },
    { header: 'Número de marbete', key: 'code', width: 24 },
    { header: 'Categoría', key: 'category', width: 28 },
    { header: 'Motivo', key: 'reason', width: 36 },
  ];
  ws.getRow(1).font = { bold: true };
  failures.forEach((f) => {
    const categoryLabel = CATEGORY_REASON_ES[f.category];
    ws.addRow({
      fila: f.xlsxRow,
      code: f.code,
      category: categoryLabel,
      reason: f.reason || categoryLabel,
    });
  });
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

/**
 * Build the official template workbook in memory. Mirrors the design
 * canon: sheet "Marbetes" with header in A1 and the example row in A2,
 * and a sibling sheet "Instrucciones" with operator-facing help text.
 *
 * The on-disk asset (`apps/web/public/assets/plantilla-carga-masiva-marbetes.xlsx`)
 * is generated by the tsx script `apps/api/scripts/generate-bulk-template.ts`,
 * which writes the same bytes to disk so the web app can serve it via
 * `<a download>`.
 */
export async function generateXlsxTemplateBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  const marbetes = wb.addWorksheet('Marbetes');
  marbetes.columns = [{ header: 'Número de marbete', key: 'code', width: 24 }];
  marbetes.getRow(1).font = { bold: true };
  marbetes.addRow({ code: EXAMPLE_CODE });

  const instrucciones = wb.addWorksheet('Instrucciones');
  instrucciones.columns = [{ header: '', key: 'line', width: 90 }];
  const helpLines = [
    'Cómo usar esta plantilla de carga masiva de marbetes',
    '',
    '1. Un registro por fila en la columna A (Número de marbete).',
    '2. Elimina la fila 2 antes de subir el archivo: es solo un ejemplo.',
    '3. Captura únicamente dígitos numéricos (0-9).',
    '4. No incluyas códigos duplicados dentro del mismo archivo.',
    '5. La fecha de vencimiento se calcula automáticamente como la fecha de carga + 3 años.',
    '6. El estado inicial de cada marbete será Disponible.',
    '7. Si la carga tiene errores, se descarga un archivo .xlsx con el detalle para corregirlo y volver a subirlo.',
  ];
  helpLines.forEach((line) => {
    instrucciones.addRow({ line });
  });
  instrucciones.getRow(1).font = { bold: true };

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

/**
 * Strict base64 decode. Throws when the input is not valid base64 or
 * when the decoded length is zero. Rejects the conventional URL-safe
 * alphabet on purpose: callers must send canonical RFC 4648 base64.
 */
export function decodeBase64Strict(input: string): Buffer {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('contentBase64 required');
  }
  // Buffer.from with 'base64' is permissive about padding and whitespace;
  // require canonical alphabet + length mod 4 == 0 up front.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input)) {
    throw new Error('contentBase64 is not valid base64');
  }
  if (input.length % 4 !== 0) {
    throw new Error('contentBase64 length is not a multiple of 4');
  }
  const buf = Buffer.from(input, 'base64');
  if (buf.length === 0) {
    throw new Error('contentBase64 decoded to empty buffer');
  }
  return buf;
}