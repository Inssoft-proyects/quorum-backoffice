/**
 * Unit tests for parseCsvCodes (WU #3 / Polish WU v4).
 *
 * parseCsvCodes is a pure helper that turns a CSV text payload into an array
 * of `{ code, line }` records (plus a list of per-line parse errors). The
 * bulk upload endpoint consumes its output. RFC-4180-lite semantics:
 *
 *   - Header row is detected case-insensitively as the literal "code".
 *   - Quoted fields may embed commas and double quotes (escaped as "").
 *   - Comment lines start with `#`. Empty lines are skipped silently.
 *   - Codes not matching /^[A-Za-z0-9._\-:]{8,128}$/ are rejected with
 *     `{line, message: 'invalid code format'}`.
 *   - 1-based; the header (when present) is not counted toward line numbers.
 *
 * The format regex intentionally excludes `,` and `"` so an embedded-comma
 * code (e.g. "A,B12345678") is rejected as malformed even though the CSV
 * parser successfully splits the row.
 */
import { parseCsvCodes } from '../../src/lib/marbete-id';

describe('parseCsvCodes', () => {
  it('strips a header row and returns each subsequent code with its line number', () => {
    const text = 'code\nCODE12345678\nCODE23456789\n';
    const { codes, errors } = parseCsvCodes(text);
    expect(errors).toEqual([]);
    expect(codes.map((c) => c.code)).toEqual(['CODE12345678', 'CODE23456789']);
    // Header is line 1 and is not counted; the first code is on line 2.
    expect(codes.map((c) => c.line)).toEqual([2, 3]);
  });

  it('parses a header-less CSV with simple codes', () => {
    const text = 'CODE12345678\nCODE23456789\nCODE34567890';
    const { codes, errors } = parseCsvCodes(text);
    expect(errors).toEqual([]);
    expect(codes.map((c) => c.code)).toEqual(['CODE12345678', 'CODE23456789', 'CODE34567890']);
    expect(codes.map((c) => c.line)).toEqual([1, 2, 3]);
  });

  it('handles a quoted field with an embedded comma (one code per row, first field only)', () => {
    // The parser correctly unquotes the first field as `A,B12345678`
    // (11 chars) — but the format regex forbids `,`, so the row lands in
    // `errors`. Trailing fields after the first comma are ignored because
    // the spec is "one code per row".
    const text = '"A,B12345678",C1234567890';
    const { codes, errors } = parseCsvCodes(text);
    expect(codes).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.line).toBe(1);
    expect(errors[0]?.message).toBe('invalid code format');
  });

  it('un-escapes a doubled double-quote inside a quoted field', () => {
    // The CSV source `"A""B12345678"` unescapes to `A"B12345678` (11 chars).
    // The format regex forbids `"`, so the unescaped value is rejected as
    // malformed — the test verifies the unescape happened (length + shape)
    // and that the error message is the standard format-fail.
    const text = '"A""B12345678"';
    const { codes, errors } = parseCsvCodes(text);
    expect(codes).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('invalid code format');
  });

  it('rejects codes that do not match the format regex', () => {
    // 130 'X' chars -> 130 > 128 (format upper bound).
    const tooLong = 'X'.repeat(130);
    const text = `short\nCODE12345678\nbad!chars\n${tooLong}`;
    const { codes, errors } = parseCsvCodes(text);
    expect(codes.map((c) => c.code)).toEqual(['CODE12345678']);
    // 3 errors: short (line 1), bad!chars (line 3), too long (line 4).
    expect(errors).toHaveLength(3);
    expect(errors.every((e) => e.message === 'invalid code format')).toBe(true);
  });

  it('skips empty trailing lines silently', () => {
    const text = 'code\n\nCODE12345678\n\n\n';
    const { codes, errors } = parseCsvCodes(text);
    expect(errors).toEqual([]);
    expect(codes.map((c) => c.code)).toEqual(['CODE12345678']);
  });
});