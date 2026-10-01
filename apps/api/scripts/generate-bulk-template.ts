#!/usr/bin/env tsx
/**
 * CLI: generate the official .xlsx bulk-marbete template.
 *
 * Writes the bytes to apps/web/public/assets/plantilla-carga-masiva-marbetes.xlsx
 * so the backoffice web app can serve it via `<a download>` from the
 * bulk-upload modal (see design canon: carga-masiva-marbetes.html).
 *
 * The on-disk template must:
 *   - Sheet "Marbetes": A1 = "Número de marbete", A2 = "123456789" (example)
 *   - Sheet "Instrucciones": neutral-Spanish operator help text
 *
 * Usage:
 *   npm run generate:bulk-template
 *
 * The script is idempotent: re-running it overwrites the same bytes
 * (the only row in Marbetes is the example row; the workbook is a
 * compile-time constant).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateXlsxTemplateBuffer } from '../src/lib/marbete-xlsx';

async function main(): Promise<void> {
  const buf = await generateXlsxTemplateBuffer();
  const outPath = path.resolve(
    __dirname,
    '..',
    '..',
    'web',
    'public',
    'assets',
    'plantilla-carga-masiva-marbetes.xlsx',
  );
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, buf);
  // eslint-disable-next-line no-console
  console.log(`generate_bulk_template_done: ${outPath} (${buf.length} bytes)`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('generate_bulk_template_failed', err);
  process.exit(1);
});