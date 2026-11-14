import { triggerDescriptor, type ConnectorLookupValue } from "@uipath/maestro-builder-sdk";

export interface RecordCreatedWhere {
  /** Select the scope for entity discovery LOOKUP — sends a `system.value`, never a name or e-mail: lookup(<Descriptor>, 'entityScope') (helpers in the LOOKUP lines above the descriptor). */
  entityScope: ConnectorLookupValue<string>;
  /** Select the tenant entity to monitor for new records LOOKUP — sends a `system.name`, never a name or e-mail: lookup(<Descriptor>, 'tenantEntityName') (helpers in the LOOKUP lines above the descriptor). */
  tenantEntityName?: ConnectorLookupValue<string>;
  /** Select the folder entity to monitor for new records LOOKUP — sends a `system.name`, never a name or e-mail: lookup(<Descriptor>, 'folderEntityName') (helpers in the LOOKUP lines above the descriptor). */
  folderEntityName?: ConnectorLookupValue<string>;
}

export interface RecordCreatedOutputs {
  Id?: string;
}

/**
 * Record Created — uipath.connector.event.uipath-uipath-dataservice.record-created
 *
 * Start a flow on it with `onEvent(RecordCreated, { where: { … } })`, or pause for it
 * with `waitForEvent(RecordCreated, { … })`; `where` carries its event parameters.
 *
 * LOOKUP: `entityScope` -> system.value
 *   by: `displayName`
 *   use: lookup(RecordCreated, 'entityScope').byDisplayName(value)
 *   also: .byDisplayName  ·  .by(name, value)
 *   strategy: paged scan (this operation declares no filterPattern)
 * LOOKUP: `tenantEntityName` -> system.name
 *   by: `displayName`
 *   use: lookup(RecordCreated, 'tenantEntityName').byDisplayName(value)
 *   also: .byDisplayName  ·  .by(name, value)
 *   strategy: paged scan (this operation declares no filterPattern)
 * LOOKUP: `folderEntityName` -> system.name
 *   by: `displayName`
 *   use: lookup(RecordCreated, 'folderEntityName').byDisplayName(value)
 *   also: .byDisplayName  ·  .by(name, value)
 *   strategy: paged scan (this operation declares no filterPattern)
 */
export const RecordCreated = triggerDescriptor<RecordCreatedWhere, RecordCreatedOutputs>()({
  connector: "uipath-uipath-dataservice",
  event: "record-created",
  version: "1.0.0",
  displayName: "Record Created",
  lookups: {
    entityScope: {
      objectName: "system",
      path: "/v3/entity-scope-options",
      by: ["displayName"],
      value: "value",
      aliases: { byDisplayName: "displayName" },
      strategy: "scan",
    },
    tenantEntityName: {
      objectName: "system",
      path: "/standard-objects-pure-ldo",
      by: ["displayName"],
      value: "name",
      aliases: { byDisplayName: "displayName" },
      strategy: "scan",
    },
    folderEntityName: {
      objectName: "system",
      path: "/standard-objects/folder-entities?folderKey={folderEntityName_folderKey}",
      by: ["displayName"],
      value: "name",
      aliases: { byDisplayName: "displayName" },
      strategy: "scan",
    },
  },
} as const);
