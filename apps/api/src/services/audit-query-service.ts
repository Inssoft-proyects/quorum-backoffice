/**
 * Read-only query service for the audit log surface.
 *
 * Distinct from `AuditService` (which writes). Routing for the read API
 * lives in routes/audit.ts and uses this service exclusively — keeping
 * reads and writes through separate boundaries makes the append-only
 * contract easier to audit.
 *
 * No OTP required for list/detail — these are GETs and the OTP middleware
 * is bypassed at the route layer. WU6 will add an `auditor+` RBAC
 * preHandler on top of this surface.
 */
import type pg from 'pg';
import type {
  ListAuditFilter,
  ListAuditResponse,
  AuditEntry,
} from '@quorum-backoffice/shared';
import { AppError } from '../lib/errors';
import { PgAuditRepo } from '../repositories/pg-audit';

interface ServiceDeps {
  pool: pg.Pool;
}

export class AuditQueryService {
  private readonly repo: PgAuditRepo;

  constructor(private readonly deps: ServiceDeps) {
    this.repo = new PgAuditRepo(deps.pool);
  }

  async list(filter: ListAuditFilter): Promise<ListAuditResponse> {
    const { rows, total } = await this.repo.list(filter);
    const items = rows.map((r) => this.repo.toResponse(r));
    return { total, limit: filter.limit, offset: filter.offset, items };
  }

  async detail(id: number): Promise<AuditEntry> {
    const row = await this.repo.findById(id);
    if (!row) throw AppError.notFound(`audit entry ${id} not found`);
    return this.repo.toResponse(row);
  }
}
