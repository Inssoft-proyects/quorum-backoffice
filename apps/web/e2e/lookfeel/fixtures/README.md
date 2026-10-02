# Lookfeel fixtures (.xlsx bulk upload)

This directory ships the synthetic `.xlsx` workbooks the lookfeel specs
upload against the live BulkUploadDialog. Keeping the workbook under
version control (rather than generating it at test time) keeps the
specs deterministic and makes the expected failure taxonomy visible in
diffs.

## Files

- `carga-masiva-fija.xlsx` — the canonical "happy + sad" fixture
  consumed by `14-bulk-upload-flow.spec.ts` (and, in the optional
  write flow, `13-asociar-screen.spec.ts`).

## How the fixture is built

`generate.mjs` writes the workbook using the same `exceljs` library the
bulk upload dialog and the API parser use. The generator pins the
workbook's `created`/`modified` dates so the output is byte-deterministic
(`md5sum` is stable across machines + runs); re-running the generator
reproduces the same `.xlsx` byte-for-byte. The script is the source of
truth; the `.xlsx` is its committed output.

```bash
node apps/web/e2e/lookfeel/fixtures/generate.mjs
```

## Row layout (`carga-masiva-fija.xlsx`)

The parser is documented in `apps/api/src/lib/marbete-xlsx.ts`. Row 1
carries the header `"Número de marbete"`. Row 2 is the template
example (`123456789`) and is silently skipped — never counted as a
failure. Real records start at row 3.

The committed fixture is exactly six rows of data (eight rows total
including the header + example). It produces:

- **3 created marbetes** (`created = 3`, `failed = 0` initially,
  `failed = 2` after we add the invalid/duplicate rows):
  - `8000012345678` (13 digits, valid)
  - `8000023456789` (13 digits, valid)
  - `8000034567890` (13 digits, valid)
- **1 `invalid_chars` failure**:
  - `ABCD1234EF` (contains letters, 10 chars)
- **1 `duplicate_in_file` failure**:
  - `8000012345678` — second occurrence of the first valid row, the
    parser flags the second as `duplicate_in_file`.
- **1 example row** (silently skipped, never counted):
  - `123456789`

So the result view renders:

| Card label                       | Count |
| ------------------------------- | ----- |
| Dígitos faltantes o sobrantes   | 0     |
| Caracteres inválidos            | 1     |
| Duplicado                       | 1     |
| Ya registrado                   | 0     |

The four numbers above are what `14-bulk-upload-flow.spec.ts`
asserts against `data-testid="bulk-upload-result-metric-*"`.

## Why a 13-digit `80000*` range

The 8+ digit, `80000*` prefix range is reserved for the lookfeel suite
by convention. No production upload uses it. This lets the specs:

1. Hit the parser happy path (8+ digits, digit-only → created).
2. Hit the `duplicate_in_file` failure path deterministically without
   racing production data.
3. Hit the `invalid_chars` failure path deterministically.
4. Run a write flow (`assign + unassign` one of the three created
   marbetes) without colliding with another worker's fixture run.

The created codes are reported in the spec's stdout so a cleanup pass
can sweep them out of the inventory afterwards.

## Why not a server-side generator

The spec needs the file to be uploaded via Playwright's
`setInputFiles()` against the live modal. A server-side route would
require a session + nonce contract and would couple the lookfeel
harness to the destructive-write path. The committed file is the
lowest-coupling option.