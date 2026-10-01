/**
 * Unit tests for the .xlsx bulk-marbete parser and template generator.
 *
 * The parser lives at `apps/api/src/lib/marbete-xlsx.ts` and is exercised
 * by the POST /api/v1/marbetes/bulk-xlsx route. These tests cover the
 * pure helpers (parsing, classifying, errors-workbook generation,
 * template generation) so the route's behaviour is verified in
 * isolation from Fastify + pg + session.
 *
 * Taxonomy per the design canon (carga-masiva-marbetes.html):
 *   - 'length_out_of_range'  : code length is outside 8..128
 *   - 'invalid_chars'        : code contains non-digit characters
 *   - 'duplicate_in_file'    : same code appears more than once in the file
 *   - 'already_exists'       : code is already in the inventory (reported
 *                              by MarbetesService.bulkCreate with reason
 *                              'code already exists')
 *   - 'other'                : catch-all for anything that does not match
 *
 * The template generator (`generateXlsxTemplateBuffer`) is a tsx-script
 * entry point; here we exercise the same in-memory builder to keep the
 * test surface pure.
 */
import ExcelJS from 'exceljs';
import { Buffer } from 'node:buffer';
import {
  parseXlsxBuffer,
  buildXlsxErrorsWorkbook,
  generateXlsxTemplateBuffer,
  decodeBase64Strict,
  XLSX_MAX_DECODED_BYTES,
  type BulkFailureCategory,
  type XlsxRowFailure,
} from '../../src/lib/marbete-xlsx';

/** Build an in-memory .xlsx buffer with a single sheet named `sheetName`. */
async function buildSingleSheet(
  sheetName: string,
  rows: Array<Array<unknown>>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  rows.forEach((r) => ws.addRow(r as ExcelJS.CellValue[]));
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

describe('parseXlsxBuffer', () => {
  it('parses a clean file: header on row 1, one example row skipped, three valid records', async () => {
    const buf = await buildSingleSheet('Marbetes', [
      ['Número de marbete'],
      ['123456789'],
      ['84729103'],
      ['84729104'],
      ['99112233'],
    ]);
    const result = await parseXlsxBuffer(buf);
    expect(result.header).toEqual({ row: 1, text: 'Número de marbete' });
    expect(result.skippedExampleRows).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.survivors.map((s) => s.xlsxRow)).toEqual([3, 4, 5]);
    expect(result.survivors.map((s) => s.code)).toEqual([
      '84729103',
      '84729104',
      '99112233',
    ]);
  });

  it('detects header case- and accent-insensitively ("numero de marbete")', async () => {
    const buf = await buildSingleSheet('Marbetes', [
      ['numero de marbete'],
      ['11111111'],
    ]);
    const result = await parseXlsxBuffer(buf);
    expect(result.header?.row).toBe(1);
    expect(result.survivors.map((s) => s.code)).toEqual(['11111111']);
  });

  it('rejects the file when the header is missing or wrong (400-class)', async () => {
    const buf = await buildSingleSheet('Marbetes', [['wrong'], ['11111111']]);
    const result = await parseXlsxBuffer(buf);
    expect(result.header).toBeNull();
    expect(result.parseError).toBe('xlsx_parse_failed');
    expect(result.survivors).toEqual([]);
  });

  it('skips empty rows silently (no failure, no skip count bump)', async () => {
    const buf = await buildSingleSheet('Marbetes', [
      ['Número de marbete'],
      [],
      ['11111111'],
      [],
    ]);
    const result = await parseXlsxBuffer(buf);
    expect(result.skippedExampleRows).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.survivors.map((s) => s.xlsxRow)).toEqual([3]);
  });

  it('classifies non-digit chars as "invalid_chars"', async () => {
    const buf = await buildSingleSheet('Marbetes', [
      ['Número de marbete'],
      ['CODE12345'],
      ['11111A111'],
    ]);
    const result = await parseXlsxBuffer(buf);
    expect(result.survivors).toEqual([]);
    expect(result.failures).toHaveLength(2);
    for (const f of result.failures) {
      expect(f.category).toBe<BulkFailureCategory>('invalid_chars');
    }
    expect(result.failures.map((f) => f.xlsxRow)).toEqual([2, 3]);
  });

  it('classifies out-of-range length as "length_out_of_range" (7 and 129 digits)', async () => {
    const tooShort = '1'.repeat(7);
    const tooLong = '9'.repeat(129);
    const buf = await buildSingleSheet('Marbetes', [
      ['Número de marbete'],
      [tooShort],
      [tooLong],
      ['12345678'],
    ]);
    const result = await parseXlsxBuffer(buf);
    expect(result.failures).toHaveLength(2);
    const sorted = [...result.failures].sort((a, b) => a.xlsxRow - b.xlsxRow);
    expect(sorted[0]?.category).toBe<BulkFailureCategory>('length_out_of_range');
    expect(sorted[0]?.code).toBe(tooShort);
    expect(sorted[1]?.category).toBe<BulkFailureCategory>('length_out_of_range');
    expect(sorted[1]?.code).toBe(tooLong);
    expect(result.survivors.map((s) => s.code)).toEqual(['12345678']);
  });

  it('reports in-file duplicates as "duplicate_in_file" (first occurrence wins)', async () => {
    const buf = await buildSingleSheet('Marbetes', [
      ['Número de marbete'],
      ['12345678'],
      ['87654321'],
      ['12345678'], // dup of row 2
      ['99999999'],
      ['87654321'], // dup of row 3
    ]);
    const result = await parseXlsxBuffer(buf);
    expect(result.survivors.map((s) => s.xlsxRow)).toEqual([2, 3, 5]);
    expect(result.failures).toHaveLength(2);
    const sorted = [...result.failures].sort((a, b) => a.xlsxRow - b.xlsxRow);
    expect(sorted[0]).toMatchObject({ xlsxRow: 4, category: 'duplicate_in_file', code: '12345678' });
    expect(sorted[1]).toMatchObject({ xlsxRow: 6, category: 'duplicate_in_file', code: '87654321' });
  });

  it('combines skip / invalid / length / dup categories in one pass and preserves order', async () => {
    const buf = await buildSingleSheet('Marbetes', [
      ['Número de marbete'],
      ['123456789'], // example row -> skipped
      ['CODE00001'], // invalid_chars
      ['12345678'], // ok
      ['12345678'], // dup_in_file
      ['1'], // length_out_of_range
    ]);
    const result = await parseXlsxBuffer(buf);
    expect(result.skippedExampleRows).toBe(1);
    expect(result.survivors.map((s) => s.xlsxRow)).toEqual([4]);
    expect(result.failures.map((f) => ({ row: f.xlsxRow, cat: f.category }))).toEqual([
      { row: 3, cat: 'invalid_chars' },
      { row: 5, cat: 'duplicate_in_file' },
      { row: 6, cat: 'length_out_of_range' },
    ]);
  });

  it('rejects files larger than XLSX_MAX_DECODED_BYTES (5 MB)', async () => {
    const buf = Buffer.alloc(XLSX_MAX_DECODED_BYTES + 1, 0xff);
    const result = await parseXlsxBuffer(buf);
    expect(result.parseError).toBe('xlsx_too_large');
  });

  it('rejects a buffer that is not a valid xlsx (corrupt header)', async () => {
    const buf = Buffer.from('not-an-excel-file', 'utf8');
    const result = await parseXlsxBuffer(buf);
    expect(['xlsx_parse_failed', 'xlsx_too_large']).toContain(result.parseError ?? '');
    expect(result.survivors).toEqual([]);
  });

  it('coerces numeric cell values to their digit string (Excel often stores digits as numbers)', async () => {
    const buf = await buildSingleSheet('Marbetes', [
      ['Número de marbete'],
      [12345678],
    ]);
    const result = await parseXlsxBuffer(buf);
    expect(result.survivors.map((s) => s.code)).toEqual(['12345678']);
  });
});

describe('buildXlsxErrorsWorkbook', () => {
  it('emits a workbook with the "Errores" sheet and header + per-failure rows', async () => {
    const failures: XlsxRowFailure[] = [
      { xlsxRow: 2, code: 'CODE00001', category: 'invalid_chars', reason: 'Caracteres inválidos' },
      { xlsxRow: 3, code: '1', category: 'length_out_of_range', reason: 'Dígitos faltantes o sobrantes' },
    ];
    const buf = await buildXlsxErrorsWorkbook(failures);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.getWorksheet('Errores');
    expect(ws).toBeDefined();
    const header = ws?.getRow(1);
    expect(header?.getCell(1).value).toBe('Fila');
    expect(header?.getCell(2).value).toBe('Número de marbete');
    expect(header?.getCell(3).value).toBe('Categoría');
    expect(header?.getCell(4).value).toBe('Motivo');
    const row2 = ws?.getRow(2);
    expect(row2?.getCell(1).value).toBe(2);
    expect(row2?.getCell(2).value).toBe('CODE00001');
    expect(row2?.getCell(3).value).toBe('Caracteres inválidos');
    expect(row2?.getCell(4).value).toBe('Caracteres inválidos');
    const row3 = ws?.getRow(3);
    expect(row3?.getCell(1).value).toBe(3);
    expect(row3?.getCell(2).value).toBe('1');
    expect(row3?.getCell(3).value).toBe('Dígitos faltantes o sobrantes');
  });

  it('round-trips: the generated errors file is itself a valid xlsx with the right header', async () => {
    const failures: XlsxRowFailure[] = [
      { xlsxRow: 5, code: 'ABC', category: 'invalid_chars', reason: 'Caracteres inválidos' },
    ];
    const buf = await buildXlsxErrorsWorkbook(failures);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.getWorksheet('Errores');
    expect(ws?.name).toBe('Errores');
    expect(ws?.getRow(1).getCell(2).value).toBe('Número de marbete');
    expect(ws?.rowCount).toBe(2);
  });
});

describe('generateXlsxTemplateBuffer', () => {
  it('produces a workbook whose first sheet has the design header, the example row in A2, and a sibling "Instrucciones" sheet', async () => {
    const buf = await generateXlsxTemplateBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const marbetes = wb.getWorksheet('Marbetes');
    expect(marbetes).toBeDefined();
    expect(marbetes?.getCell('A1').value).toBe('Número de marbete');
    expect(marbetes?.getCell('A2').value).toBe('123456789');
    const instrucciones = wb.getWorksheet('Instrucciones');
    expect(instrucciones).toBeDefined();
    // The Instructions sheet is text-only and has at least 5 rows of help text.
    expect((instrucciones?.rowCount ?? 0) >= 5).toBe(true);
  });

  it('round-trips through parseXlsxBuffer (header + 1 skipped example row + 0 survivors)', async () => {
    const buf = await generateXlsxTemplateBuffer();
    const result = await parseXlsxBuffer(buf);
    expect(result.header).toEqual({ row: 1, text: 'Número de marbete' });
    expect(result.skippedExampleRows).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.survivors).toEqual([]);
  });
});

describe('decodeBase64Strict', () => {
  it('decodes a canonical base64 string', () => {
    const raw = Buffer.from('hello', 'utf8');
    const round = decodeBase64Strict(raw.toString('base64')).toString('utf8');
    expect(round).toBe('hello');
  });

  it('rejects URL-safe base64 (uses - and /)', () => {
    expect(() => decodeBase64Strict('a-bcd')).toThrow();
  });

  it('rejects inputs whose length is not a multiple of 4', () => {
    expect(() => decodeBase64Strict('abc')).toThrow();
  });

  it('rejects the empty string', () => {
    expect(() => decodeBase64Strict('')).toThrow();
  });
});