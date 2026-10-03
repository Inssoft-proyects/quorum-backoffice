#!/usr/bin/env node
/**
 * Generator for the lookfeel bulk-upload .xlsx fixture.
 *
 * Writes `carga-masiva-fija.xlsx` next to this script. The workbook
 * is the canonical "happy + sad" fixture consumed by
 * `14-bulk-upload-flow.spec.ts`:
 *
 *    header  "Número de marbete"
 *    row 2   123456789                     (template example; skipped)
 *    row 3   8000012345678                 (created)
 *    row 4   8000023456789                 (created)
 *    row 5   8000034567890                 (created)
 *    row 6   ABCD1234EF                    (invalid_chars failure)
 *    row 7   8000012345678                 (duplicate_in_file failure)
 *
 * Output bytes are byte-deterministic (`md5sum` stable across
 * machines + runs) because we pin `wb.created`/`wb.modified` and
 * `creator`/`lastModifiedBy` to fixed values. The generator and
 * the committed .xlsx stay in lock-step.
 *
 * Why an mjs script: the lookfeel harness already uses node for its
 * static maquette server (no npm dependency injection for CLI
 * helpers). An .mjs script keeps the tooling minimal and avoids a
 * tsx/esbuild step just to write six numbers.
 *
 * Usage:
 *    node apps/web/e2e/lookfeel/fixtures/generate.mjs
 *    # or:
 *    node --no-warnings apps/web/e2e/lookfeel/fixtures/generate.mjs \
 *        --out apps/web/e2e/lookfeel/fixtures/carga-masiva-fija.xlsx
 */
import ExcelJS from 'exceljs';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_OUT = resolve(__dirname, 'carga-masiva-fija.xlsx');

function parseArgs(argv) {
  const out = { out: DEFAULT_OUT };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--out' && i + 1 < argv.length) {
      out.out = resolve(argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

async function main() {
  const { out } = parseArgs(process.argv);
  const wb = new ExcelJS.Workbook();
  // Pin created/modified + creator so the .xlsx output is byte-
  // deterministic (the docProps XML feeds back into the zip entry
  // timestamps that ExcelJS writes into the archive).
  wb.created = new Date('2024-01-01T00:00:00Z');
  wb.modified = new Date('2024-01-01T00:00:00Z');
  wb.creator = 'lookfeel-fixtures';
  wb.lastModifiedBy = 'lookfeel-fixtures';
  const ws = wb.addWorksheet('Marbetes');
  ws.columns = [{ header: 'Número de marbete', key: 'code', width: 24 }];
  ws.getRow(1).font = { bold: true };
  // Row 2: template's example (the parser keeps it as skippedExampleRows).
  ws.addRow({ code: '123456789' });
  // Rows 3-5: three valid 13-digit codes in the lookfeel-only 80000* range.
  ws.addRow({ code: '8000012345678' });
  ws.addRow({ code: '8000023456789' });
  ws.addRow({ code: '8000034567890' });
  // Row 6: invalid_chars failure (mixed letters + digits).
  ws.addRow({ code: 'ABCD1234EF' });
  // Row 7: duplicate_in_file failure (repeat of row 3).
  ws.addRow({ code: '8000012345678' });

  const buf = await wb.xlsx.writeBuffer();
  writeFileSync(out, Buffer.from(buf));
  // eslint-disable-next-line no-console
  console.log(`generate_fixture_done: ${out} (${buf.byteLength} bytes)`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('generate_fixture_failed', err);
  process.exit(1);
});