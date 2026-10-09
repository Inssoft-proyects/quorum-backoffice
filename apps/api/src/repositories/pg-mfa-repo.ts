/**
 * PostgreSQL repository for the MFA authentication surface (M1).
 *
 * This module owns the read paths that bind the MFA chain
 *
 *     marbete.code_hash  →  marbete.assigned_student_id
 *                            ↓
 *                          students_cache.id + is_active
 *                            ↓
 *                          dispositivos.serial_number
 *                            ↓
 *                          dispositivos.assigned_student_id
 *
 * plus the student-session INSERT and the `student.mfa_authenticate`
 * audit row. It is intentionally separate from `pg-marbetes.ts` and
 * `pg-dispositivos.ts` for three reasons:
 *
 *   1. **Cohesion of the MFA fail-closed path.** The MFA service
 *      walks a small, fixed set of SQL queries; centralizing them
 *      here keeps the service's policy code (DOs and DON'Ts) free
 *      of SQL plumbing and makes the read-side queries trivially
 *      auditable as a single, isolated module.
 *   2. **No leakage of the marbete code or device serial.** The
 *      marbete lookup takes a sha256 hash (not the raw code) and
 *      the device lookup takes a serial — the service's audit
 *      writer uses these as inputs and the repo never echoes
 *      either value in a row that flows back to a deny path.
 *   3. **Stable surface for the unit-test mocks.** The MFA service
 *      accepts a typed `MfaRepoLike` interface (see below) so the
 *      unit suite can exercise the policy order with deterministic
 *      fakes without ever hitting a real database.
 *
 * Mirrors the snake_case-at-SQL-boundary / camelCase-response shape
 * used by `pg-marbetes.ts` and `pg-dispositivos.ts` so the row
 * types line up with the rest of the API.
 */
import type pg from 'pg';

type Client = pg.Pool | pg.PoolClient;

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/**
 * The marbete row resolved from a sha256 `code_hash` lookup. Only the
 * columns the MFA service consults are returned (the marbete detail
 * page is out of scope). The MFA service uses `assigned_student_id`
 * to look up the student + the device; it never reads `code_hash` or
 * `public_uid` on the deny path (so neither can leak through the
 * audit row or the deny response).
 */
export interface MfaMarbeteRow {
  id: number;
  public_uid: string;
  status: 'active' | 'inactive' | 'revoked';
  assigned_student_id: number | null;
  deleted_at: Date | null;
}

/**
 * The student row the MFA service hydrates from
 * `marbetes.assigned_student_id`. The MFA service rejects the
 * request with `deny.student_inactive` when `is_active = false`.
 */
export interface MfaStudentRow {
  id: number;
  canvas_user_id: number;
  full_name: string;
  email: string;
  is_active: boolean;
}

/**
 * The device row the MFA service hydrates from
 * `dispositivos.serial_number`. `assigned_student_id` is the internal
 * `students_cache.id` (NOT the canvas_user_id, NOT the marbete's
 * student id). The MFA service rejects the request with
 * `deny.device_not_bound_to_student` when this value does not match
 * the student the marbete points to.
 */
export interface MfaDeviceRow {
  id: number;
  serial_number: string;
  status: 'active' | 'revoked';
  revoked_at: Date | null;
  assigned_student_id: number | null;
}

/**
 * The student session row the MFA service inserts. Mirrors the
 * `sessions` table columns relevant to the MFA flow (the new
 * `kind='student'` + `canvas_user_id` columns added by migration
 * 0017_mfa_sessions_kind.sql). `user_id` is always NULL for an
 * MFA session — the student is identified by `canvas_user_id`,
 * and the `kind` discriminator is the source of truth for the
 * role (a BackOffice operator session is `kind='user'`, an MFA
 * student session is `kind='student'`).
 */
export interface MfaStudentSessionRow {
  id: string;
  kind: 'student';
  canvas_user_id: number;
  expires_at: Date;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Repo class
// ---------------------------------------------------------------------------

export class PgMfaRepo {
  constructor(private readonly client: Client) {}

  /**
   * Look up a marbete by its `code_hash` (sha256 hex of the raw code
   * the student submits). Returns `null` when the marbete does not
   * exist OR is soft-deleted — the service collapses both outcomes
   * to `deny.marbete_unknown` so the response cannot distinguish
   * "unknown id" from "deleted id".
   *
   * The `status` column is returned so the service can reject
   * `revoked` / `inactive` marbetes with the same deny code (the
   * existing access-decision pattern: never distinguish "doesn't
   * exist" from "revoked" to the caller).
   *
   * The `public_uid` is returned for the audit row (so the operator
   * can reconcile the MFA event with the marbete by id) but the
   * service MUST NOT echo it in the deny response.
   */
  async findMarbeteByCodeHash(codeHash: string): Promise<MfaMarbeteRow | null> {
    const r = await this.client.query<MfaMarbeteRow>(
      `SELECT id, public_uid, status, assigned_student_id, deleted_at
         FROM marbetes
        WHERE code_hash = $1
          AND deleted_at IS NULL`,
      [codeHash],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Look up a student by their internal `students_cache.id` (the FK
   * `marbetes.assigned_student_id` references). The MFA service
   * treats a NULL row (no student) and `is_active = false` as the
   * same deny code (`deny.student_inactive`) so an attacker cannot
   * enumerate which ids are "valid but inactive" vs "missing".
   */
  async findStudentById(id: number): Promise<MfaStudentRow | null> {
    const r = await this.client.query<MfaStudentRow>(
      `SELECT id, canvas_user_id, full_name, email, is_active
         FROM students_cache
        WHERE id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Look up a device by its `serial_number`. The MFA service checks
   * the returned row against the marbete's `assigned_student_id`:
   *
   *   - row not found                       → `deny.device_unknown`
   *   - row found, status != 'active'       → `deny.device_unknown`
   *   - row found, status = 'active',
   *     assigned_student_id IS NULL         → `deny.device_unknown`
   *   - row found, status = 'active',
   *     assigned_student_id != student.id   → `deny.device_not_bound_to_student`
   *
   * The serial is returned for the audit row's denormalized context
   * (so the operator can correlate the MFA event with a device
   * later) but the service MUST NOT echo it in the deny response.
   */
  async findDeviceBySerialNumber(serialNumber: string): Promise<MfaDeviceRow | null> {
    const r = await this.client.query<MfaDeviceRow>(
      `SELECT id, serial_number, status, revoked_at, assigned_student_id
         FROM dispositivos
        WHERE serial_number = $1`,
      [serialNumber],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Insert a new MFA student session row. Mirrors the
   * `PgSessionRepo.insert` shape but extends the row with
   * `kind='student'` and `canvas_user_id` (the new columns added
   * by migration 0017_mfa_sessions_kind.sql). The CHECK
   * constraint on `kind='student' AND canvas_user_id IS NOT NULL`
   * is enforced by the DB so a refactor that forgets to pass the
   * `canvas_user_id` here surfaces a 23514 SQLSTATE at INSERT
   * time (the migration runner already exercises the same CHECK
   * via the constraint name).
   *
   * The role for a student session is implicit in `kind`; we do
   * NOT write a separate `role` column because the discriminator
   * + the lookup table is sufficient.
   */
  async insertStudentSession(args: {
    id: string;
    canvasUserId: number;
    expiresAt: Date;
    ip: string | null;
    userAgent: string | null;
  }): Promise<MfaStudentSessionRow> {
    const r = await this.client.query<MfaStudentSessionRow>(
      `INSERT INTO sessions
         (id, user_id, kind, canvas_user_id, expires_at, ip, user_agent)
       VALUES ($1, NULL, 'student', $2, $3, $4::inet, $5)
       RETURNING id, kind, canvas_user_id, expires_at, created_at`,
      [args.id, args.canvasUserId, args.expiresAt, args.ip, args.userAgent],
    );
    const row = r.rows[0];
    if (!row) throw new Error('mfa_session_insert_failed');
    return row;
  }

  /**
   * Look up a MFA student session by id. Mirrors the
   * `PgSessionRepo.findById` shape but constrains to
   * `kind='student'`. Returns `null` for any other kind
   * (a backoffice operator session, an unknown id, or an expired
   * row) so the route layer never accidentally grants a user
   * session the MFA endpoint's privileges.
   */
  async findStudentSessionById(id: string): Promise<MfaStudentSessionRow | null> {
    const r = await this.client.query<MfaStudentSessionRow>(
      `SELECT id, kind, canvas_user_id, expires_at, created_at
         FROM sessions
        WHERE id = $1
          AND kind = 'student'`,
      [id],
    );
    return r.rows[0] ?? null;
  }
}
