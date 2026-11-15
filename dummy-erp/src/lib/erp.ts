// Data Fabric access for Open ERP. Entities are addressed by name, so the app carries no
// tenant-specific ids. Every PR is written with `insertRecord` (one record per call):
// Data Fabric fires record-created trigger events only for single inserts, never for
// batch `insertRecords`, and downstream approval checks rely on that event.
import type { PaginatedResponse, PaginationCursor, UiPath } from '@uipath/uipath-typescript/core';
import type { EntityQueryRecordsOptions, EntityRecord } from '@uipath/uipath-typescript/entities';
import { Entities } from '@uipath/uipath-typescript/entities';
import type { Masters, PurchaseRequisition } from './pr';
import { toRecord } from './pr';

export const PR_ENTITY = { name: 'PurchaseRequisition' };

type Row = Record<string, unknown>;

/** Server-side sort for the PR list. Fields are entity field names. */
export interface PrSort {
  field: 'prId' | 'createdAt' | 'description' | 'amount' | 'status' | 'splitCaseId';
  desc: boolean;
}

export const DEFAULT_SORT: PrSort = { field: 'createdAt', desc: true };

export interface PrPage {
  items: PurchaseRequisition[];
  totalCount: number;
  hasNextPage: boolean;
  nextCursor?: PaginationCursor;
}

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));

function toPr(r: Row): PurchaseRequisition {
  return {
    prId: str(r.prId), requesterId: str(r.requesterId), costCenter: str(r.costCenter),
    projectCode: r.projectCode ? str(r.projectCode) : null, vendorId: str(r.vendorId), category: str(r.category),
    description: str(r.description), quantity: Number(r.quantity) || 0, unitPrice: Number(r.unitPrice) || 0,
    amount: Number(r.amount) || 0, currency: str(r.currency) || 'INR', deliverySite: str(r.deliverySite),
    blanketPoRef: r.blanketPoRef ? str(r.blanketPoRef) : null, isEmergency: r.isEmergency === true,
    createdAt: str(r.createdAt), status: str(r.status), splitCaseId: r.splitCaseId ? str(r.splitCaseId) : null,
  };
}

export function createErp(sdk: UiPath) {
  const entities = new Entities(sdk);

  // Passing pageSize selects the paginated overload; the cast names that result type.
  const query = (name: string, options: EntityQueryRecordsOptions & { pageSize: number }) =>
    entities.queryRecords({ name }, options) as Promise<PaginatedResponse<EntityRecord>>;

  /** Every row of an entity: list calls return one page, so follow the cursor to the end. */
  async function readAll(name: string, fields?: string[]): Promise<Row[]> {
    const out: Row[] = [];
    let cursor: PaginationCursor | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = await query(name, {
        pageSize: 1000, ...(fields ? { selectedFields: fields } : {}), ...(cursor ? { cursor } : {}),
      } as EntityQueryRecordsOptions & { pageSize: number });
      out.push(...(page.items as Row[]));
      if (!page.hasNextPage || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return out;
  }

  return {
    /** Requesters and vendors for the pickers and for CSV validation. */
    async loadMasters(): Promise<Masters> {
      const [emps, vens] = await Promise.all([
        readAll('Employee', ['employeeId', 'name', 'costCenter']),
        readAll('Vendor', ['vendorId', 'name', 'category']),
      ]);
      return {
        employees: new Map(emps
          .map((e) => [str(e.employeeId), { name: str(e.name), costCenter: str(e.costCenter) }])),
        vendors: new Map(vens.map((v) => [str(v.vendorId), { name: str(v.name), category: str(v.category) }])),
      };
    },

    /** All PR numbers in use (for the next-number suggestion and duplicate checks). */
    async loadPrIds(): Promise<Set<string>> {
      const rows = await readAll(PR_ENTITY.name, ['prId']);
      return new Set(rows.map((r) => str(r.prId).toUpperCase()));
    },

    /** One page of PRs in the given order. prId breaks ties so pages never overlap or skip. */
    async listPrs(pageSize: number, cursor?: PaginationCursor, sort: PrSort = DEFAULT_SORT): Promise<PrPage> {
      const sortOptions = [{ fieldName: sort.field, isDescending: sort.desc }];
      if (sort.field !== 'prId') sortOptions.push({ fieldName: 'prId', isDescending: sort.desc });
      const page = await query(PR_ENTITY.name, {
        pageSize, sortOptions, ...(cursor ? { cursor } : {}),
      } as EntityQueryRecordsOptions & { pageSize: number });
      return {
        items: (page.items as Row[]).map(toPr),
        totalCount: page.totalCount ?? page.items.length,
        hasNextPage: page.hasNextPage,
        nextCursor: page.nextCursor,
      };
    },

    /** Creates one PR (single insert, so the record-created event fires). */
    async createPr(pr: PurchaseRequisition): Promise<void> {
      await entities.insertRecord(PR_ENTITY, toRecord(pr));
    },
  };
}

export type Erp = ReturnType<typeof createErp>;

export function errorText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}
