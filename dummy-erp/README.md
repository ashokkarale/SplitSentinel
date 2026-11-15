# Open ERP (dummy procurement ERP)

A small stand-in for a real ERP: users raise purchase requisitions (PRs), and each one is written
to the Data Fabric entity `PurchaseRequisition`. It is a separate UiPath Coded Web App with its
own OAuth client, not part of the SplitSentinel solution. SplitSentinel only sees the records it
creates, through its Data Fabric "record created" trigger, as it would with a real ERP.

## What it does

| Screen | Purpose |
|---|---|
| Requisitions | PR list, 25 per page, newest first by default; sort by PR, created, description, amount, status or case (server-side, across all pages) |
| New requisition → Enter one | Form with every entity field. Requester fills the cost centre, vendor fills the category, amount defaults to quantity × unit price, PR number defaults to the next free one |
| New requisition → Upload CSV | Template download, upload, row-by-row check, then import of the valid rows with a per-row result |

Every PR is written with a **single-record insert** (`entities.insertRecord`), also during CSV
import. Data Fabric raises trigger events only for single inserts, never for batch
`insertRecords`, so each imported PR starts its own approval check.

## CSV format

Header row with the entity's field names (download the template from the app):

```
prId,requesterId,costCenter,projectCode,vendorId,category,description,quantity,unitPrice,amount,currency,deliverySite,blanketPoRef,isEmergency,createdAt,status
```

- Required: `prId`, `requesterId`, `vendorId`, `description`, and `amount` or `quantity` + `unitPrice`.
- Defaults: `costCenter` from the requester, `category` from the vendor, `currency` INR,
  `isEmergency` false, `createdAt` now, `status` Submitted.
- `createdAt` accepts ISO 8601 (`2026-11-15T10:30:00+05:30`) or `2026-11-15 10:30`.
- Rows are rejected for: duplicate PR numbers (existing or earlier in the file), unknown requester
  or vendor, non-numeric amounts, invalid status, and values over the field length.
  Mismatches that may be intended (cost centre differs from the requester's, amount differs
  from quantity × price) are warnings, and the row is still imported.
- `splitCaseId` is owned by the approval checker and is ignored if present. At most 500 rows per file.

## Setup

1. `npm ci`
2. Copy `uipath.example.json` to `uipath.json` and fill in the client id, org and tenant.
   `uipath.json` is git-ignored because it holds tenant details. The OAuth client is a
   non-confidential External Application with user scopes
   `DataFabric.Schema.Read DataFabric.Data.Read DataFabric.Data.Write`.
3. `npm run dev` and open http://localhost:5173.

## Deploy

```bash
npm run build
uip codedapp pack dist -n open-erp --display-name "Open ERP" --version <x.y.z>
uip codedapp publish -n open-erp --version <x.y.z> --type Web --personal-workspace
uip codedapp deploy -n open-erp --folder-key <personal-workspace-folder-key>
```

It is deployed to the Personal Workspace, so it sits outside the SplitSentinel solution folder.
A Personal Workspace deploy needs the package in the Personal Workspace feed
(`publish --personal-workspace`). The deploy registers the app's production redirect URI on the
OAuth client.
