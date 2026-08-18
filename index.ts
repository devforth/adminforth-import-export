import { AdminForthPlugin, suggestIfTypo, AdminForthFilterOperators, Filters, AdminForthDataTypes, rejectApiRawFilters, interpretResource, ActionCheckSource, AllowedActionsEnum } from "adminforth";
import type { IAdminForth, IHttpServer, AdminForthResourceColumn, AdminForthComponentDeclaration, AdminForthResource, AdminUser, HttpExtra, IAdminForthHttpResponse } from "adminforth";
import type { PluginOptions } from './types.js';
import type BackgroundJobsPlugin from '@adminforth/background-jobs';
import pLimit from 'p-limit';
import { z } from "zod";
import {
  DEFAULT_READ_CHUNK_SIZE,
  EXPORT_CSV_JOB_HANDLER_NAME,
  MINIMAL_BUFFER_SIZE_MB,
  getExportDownloadUrl,
  runExportCsvJob,
  startExport,
} from './exportMultipartUpload.js';

const SIZE_PROBE_ROWS = 20;
/**
 * Rows held as JS objects cost several times more than their serialized form (per-property
 * overhead, 2 bytes per char in non-latin1 strings), so the RAM guess is scaled up.
 */
const RAM_OVERHEAD_FACTOR = 4;
const DEFAULT_EXPORT_VIA_UPLOAD_BUFFER_SIZE_MB = 5;

const exportCsvBodySchema = z.object({
  filters: z.any(),
  sort: z.any(),
  selectedIds: z.array(z.any()).optional(),
}).strict();

const startExportJobBodySchema = z.object({
  filters: z.any(),
  sort: z.any(),
  selectedIds: z.array(z.any()).optional(),
  totalRows: z.number().int().nonnegative().optional(),
}).strict();

const exportDownloadUrlBodySchema = z.object({
  jobId: z.string(),
}).strict();

const importCsvBodySchema = z.object({
  data: z.record(z.string(), z.array(z.unknown())),
}).strict();

export default class ImportExport extends AdminForthPlugin {
  options: PluginOptions;
  emailField: AdminForthResourceColumn;
  authResourceId: string;
  adminforth: IAdminForth;
  auditLogPlugin: Record<string, any> | undefined;
  backgroundJobsPlugin: any;
 
  constructor(options: PluginOptions) {
    super(options, import.meta.url);
    this.options = options;
  }

  private isRowValid(row: Record<string, unknown>): string[] {
    let errors = [];
    for (const col of Object.keys(row)) {
      const resourceCol = this.resourceConfig.columns.find(c => c.name === col);
      if (!resourceCol) {
        errors.push(`Column '${col}' not found in resource configuration.`);
        continue;
      }    
      if (resourceCol.backendOnly) {
        errors.push(`Column '${col}' is backend only and cannot be imported.`);
      }
      if (resourceCol.enum && !resourceCol.enum.some(e => e.value === row[col])) {
        errors.push(`Column '${col}' has an enum of [${resourceCol.enum.map(e => e.label).join(', ')}] but got value '${row[col]}'.`);
      }
    }
    return errors;
  }

  private tryToAuditLogAction(actionName: 'import' | 'export', actionDetails: string, adminUser: AdminUser, headers?: Record<string, string> ) {
    if (!this.auditLogPlugin) {
      console.warn('AuditLogPlugin not found, skipping audit log for action:', actionDetails);
      return;
    }
    try {
      this.auditLogPlugin.logCustomAction({
        resourceId: this.resourceConfig.resourceId,
        recordId: null,
        actionId: actionName,
        oldData: null,
        data: {
          details: actionDetails,

        },
        user: adminUser,
        headers: headers || {},
      });
    } catch (e) {
      console.error('Failed to log action to AuditLogPlugin:', e);
    }
  }

  /**
   * When user exported a manual selection, the selection itself becomes the only filter.
   */
  private resolveExportFilters(
    filters: any,
    selectedIds?: unknown[]
  ): { ok: boolean; filters?: any; error?: string } {
    if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
      return { ok: true, filters };
    }
    const primaryKeyColumn = this.resourceConfig.columns.find(col => col.primaryKey);
    if (!primaryKeyColumn) {
      return { ok: false, error: 'Cannot export selected records: resource has no primary key' };
    }
    return {
      ok: true,
      filters: [{
        field: primaryKeyColumn.name,
        operator: AdminForthFilterOperators.IN,
        value: selectedIds,
      }],
    };
  }

  private async ensureAnyAllowed(
    adminUser: AdminUser,
    checks: { source: ActionCheckSource; action: AllowedActionsEnum }[],
    meta: Record<string, unknown> = {}
  ): Promise<{ ok: boolean; error?: string }> {
    for (const { source, action } of checks) {
      const { allowedActions } = await interpretResource(
        adminUser,
        this.resourceConfig,
        meta,
        source,
        this.adminforth
      );

      if (allowedActions[action] === true) {
        return { ok: true };
      }
    }

    return {
      ok: false,
      error: 'Action is not allowed',
    };
  }

  async modifyResourceConfig(adminforth: IAdminForth, resourceConfig: AdminForthResource) {
    super.modifyResourceConfig(adminforth, resourceConfig);
    if (!resourceConfig.options.pageInjections) {
      resourceConfig.options.pageInjections = {};
    }
    if (!resourceConfig.options.pageInjections.list) {
      resourceConfig.options.pageInjections.list = {};
    }
    if (!resourceConfig.options.pageInjections.list.threeDotsDropdownItems) {
      resourceConfig.options.pageInjections.list.threeDotsDropdownItems = [];
    }
    const dropdownItems = resourceConfig.options.pageInjections.list.threeDotsDropdownItems as AdminForthComponentDeclaration[];
    dropdownItems.push({
      file: this.componentPath('ExportCsv.vue'),
      meta: {
        pluginInstanceId: this.pluginInstanceId,
        exportViaUpload: !!this.options.exportViaUpload,
      }
    });

    if (this.options.importEnabled !== false) {
      dropdownItems.push({
        file: this.componentPath('ImportCsv.vue'),
        meta: { pluginInstanceId: this.pluginInstanceId }
      });
    }


    // simply modify resourceConfig or adminforth.config. You can get access to plugin options via this.options;
  }
  
  validateConfigAfterDiscover(adminforth: IAdminForth, resourceConfig: AdminForthResource) {
    // optional method where you can safely check field types after database discovery was performed
    try {
      this.auditLogPlugin = this.adminforth.getPluginByClassName('AuditLogPlugin');
    } catch (e) {
      console.warn('Failed to get AuditLogPlugin for import-export plugin. Audit logging will be skipped.');
    }

    if (this.options.exportViaUpload) {
      const backgroundJobsPlugin = adminforth.getPluginByClassName<BackgroundJobsPlugin>('BackgroundJobsPlugin');

      if (!backgroundJobsPlugin) {
        throw new Error(`BackgroundJobsPlugin is required for export of big dataset to work, please add it to your plugins`);
      }

      if (!this.options.exportViaUpload.storageAdapter) {
        throw new Error(`exportViaUpload.storageAdapter is required for export of big dataset to work`);
      }

      if (this.options.exportViaUpload.bufferSizeMb === undefined) {
        this.options.exportViaUpload.bufferSizeMb = MINIMAL_BUFFER_SIZE_MB;
      } else if (this.options.exportViaUpload.bufferSizeMb < MINIMAL_BUFFER_SIZE_MB) {
        throw new Error(`exportViaUpload.bufferSizeMb must be at least ${MINIMAL_BUFFER_SIZE_MB}, got ${this.options.exportViaUpload.bufferSizeMb}`);
      }

      if (this.options.exportViaUpload.readChunkSize === undefined) {
        this.options.exportViaUpload.readChunkSize = DEFAULT_READ_CHUNK_SIZE;
      } else if (!Number.isInteger(this.options.exportViaUpload.readChunkSize) || this.options.exportViaUpload.readChunkSize < 1) {
        throw new Error(`exportViaUpload.readChunkSize must be a positive integer, got ${this.options.exportViaUpload.readChunkSize}`);
      }

      this.options.exportViaUpload.storageAdapter.setupLifecycle(
        `${this.resourceConfig.resourceId}-${this.pluginInstanceId}`
      );

      backgroundJobsPlugin.registerTaskHandler({
        jobHandlerName: `${EXPORT_CSV_JOB_HANDLER_NAME}-${this.pluginInstanceId}`,
        handler: async ({ jobId, getState }) => {
          await runExportCsvJob(this, { jobId, getState });
        },
        // whole export is a single task which streams the file, there is nothing to parallelize
        parallelLimit: 1,
      })

      backgroundJobsPlugin.registerTaskDetailsComponent({
        jobHandlerName: `${EXPORT_CSV_JOB_HANDLER_NAME}-${this.pluginInstanceId}`,
        component: {
          file: this.componentPath('ExportCsvJobViewComponent.vue'),
          meta: { pluginInstanceId: this.pluginInstanceId },
        },
      })
    }
  }

  instanceUniqueRepresentation(pluginOptions: any) : string {
    // optional method to return unique string representation of plugin instance. 
    // Needed if plugin can have multiple instances on one resource 
    return `${this.pluginInstanceId}`;
  }

  setupEndpoints(server: IHttpServer) {
    server.endpoint({
      method: 'POST',
      path: `/plugin/${this.pluginInstanceId}/export-csv`,
      request_schema: exportCsvBodySchema,
      handler: async ({ body, adminUser, headers }) => {
        const { filters, sort, selectedIds } = body as z.infer<typeof exportCsvBodySchema>;
        if (!filters || !sort) {
          return { ok: false, error: 'Missing filters or sort in request body' };
        }
        const access = await this.ensureAnyAllowed(
          adminUser,
          [
            { source: ActionCheckSource.ListRequest, action: AllowedActionsEnum.list },
            { source: ActionCheckSource.ShowRequest, action: AllowedActionsEnum.show },
          ],
          { requestBody: body }
        );
        if (!access.ok) {
          return { ok: false, error: access.error };
        }
        const rawFilterError = rejectApiRawFilters(body.filters);
        if (rawFilterError) {
          return rawFilterError;
        }

        const effectiveFilters = this.resolveExportFilters(filters, selectedIds);
        if (!effectiveFilters.ok) {
          return { ok: false, error: effectiveFilters.error };
        }

        return this.exportCsv(effectiveFilters.filters, sort, { adminUser, headers });
      }
    });

    if (this.options.importEnabled !== false) {
      server.endpoint({
        method: 'POST',
        path: `/plugin/${this.pluginInstanceId}/import-csv`,
        request_schema: importCsvBodySchema,
        handler: async ({ body, adminUser, query, headers, cookies, requestUrl, response }) => {
          const { data } = body as z.infer<typeof importCsvBodySchema>;
          if (!data || typeof data !== 'object') {
            return { ok: false, error: 'Invalid data format. Expected an object with column names as keys and arrays of values as values.' };
          }
          const createEditAccess = await this.ensureAnyAllowed(
            adminUser,
            [
              { source: ActionCheckSource.CreateRequest, action: AllowedActionsEnum.create },
              { source: ActionCheckSource.EditRequest, action: AllowedActionsEnum.edit }
            ],
            { requestBody: body }
          );
          if (!createEditAccess.ok) {
            return { ok: false, error: createEditAccess.error };
          }
          return this.importCsv(data, {
            adminUser,
            headers,
            response,
            extra: { body, query, headers, cookies, requestUrl, response },
          });
        }
      });

      server.endpoint({
        method: 'POST',
        path: `/plugin/${this.pluginInstanceId}/import-csv-new-only`,
        request_schema: importCsvBodySchema,
        handler: async ({ body, adminUser, query, headers, cookies, requestUrl, response }) => {
          const { data } = body as z.infer<typeof importCsvBodySchema>;
          if (!data || typeof data !== 'object') {
            return { ok: false, error: 'Invalid data format. Expected an object with column names as keys and arrays of values as values.' };
          }
          const access = await this.ensureAnyAllowed(
            adminUser,
            [{ source: ActionCheckSource.CreateRequest, action: AllowedActionsEnum.create }],
            { requestBody: body }
          );
          if (!access.ok) {
            return { ok: false, error: access.error };
          }
          return this.importCsvNewOnly(data, {
            adminUser,
            headers,
            extra: { body, query, headers, cookies, requestUrl, response },
          });
        }
      });

      server.endpoint({
        method: 'POST',
        path: `/plugin/${this.pluginInstanceId}/check-records`,
        request_schema: importCsvBodySchema,
        handler: async ({ body, adminUser }) => {
          const { data } = body as z.infer<typeof importCsvBodySchema>;
          const access = await this.ensureAnyAllowed(
            adminUser,
            [
              { source: ActionCheckSource.ListRequest, action: AllowedActionsEnum.list },
              { source: ActionCheckSource.ShowRequest, action: AllowedActionsEnum.show },
            ],
            { requestBody: body }
          );
          if (!access.ok) {
            return { ok: false, error: access.error };
          }
          return this.checkRecords(data);
        }
      });
    }

    server.endpoint({
      method: 'POST',
      path: `/plugin/${this.pluginInstanceId}/start-export-job`,
      request_schema: startExportJobBodySchema,
      handler: async ({ body, adminUser, headers }) => {
        const { filters, sort, selectedIds, totalRows } = body as z.infer<typeof startExportJobBodySchema>;
        if (!this.options.exportViaUpload) {
          return { ok: false, error: 'Big dataset export is not enabled for this resource' };
        }
        if (!filters || !sort) {
          return { ok: false, error: 'Missing filters or sort in request body' };
        }
        const access = await this.ensureAnyAllowed(
          adminUser,
          [
            { source: ActionCheckSource.ListRequest, action: AllowedActionsEnum.list },
            { source: ActionCheckSource.ShowRequest, action: AllowedActionsEnum.show },
          ],
          { requestBody: body }
        );
        if (!access.ok) {
          return { ok: false, error: access.error };
        }
        const rawFilterError = rejectApiRawFilters(body.filters);
        if (rawFilterError) {
          return rawFilterError;
        }

        const effectiveFilters = this.resolveExportFilters(filters, selectedIds);
        if (!effectiveFilters.ok) {
          return { ok: false, error: effectiveFilters.error };
        }

        const effectiveTotalRows = Array.isArray(selectedIds) && selectedIds.length > 0
          ? selectedIds.length
          : totalRows;

        this.tryToAuditLogAction(
          'export',
          `Started background CSV export with filters: ${JSON.stringify(effectiveFilters.filters)} and sort: ${JSON.stringify(sort)}`,
          adminUser,
          headers
        );

        try {
          return await startExport(this, {
            filters: effectiveFilters.filters,
            sort,
            adminUser,
            totalRows: effectiveTotalRows,
          });
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : 'Failed to start export job' };
        }
      },
    })

    server.endpoint({
      method: 'POST',
      path: `/plugin/${this.pluginInstanceId}/export-job-download-url`,
      request_schema: exportDownloadUrlBodySchema,
      handler: async ({ body, adminUser }) => {
        const { jobId } = body as z.infer<typeof exportDownloadUrlBodySchema>;
        if (!this.options.exportViaUpload) {
          return { ok: false, error: 'Big dataset export is not enabled for this resource' };
        }
        const access = await this.ensureAnyAllowed(
          adminUser,
          [
            { source: ActionCheckSource.ListRequest, action: AllowedActionsEnum.list },
            { source: ActionCheckSource.ShowRequest, action: AllowedActionsEnum.show },
          ],
          { requestBody: body }
        );
        if (!access.ok) {
          return { ok: false, error: access.error };
        }
        try {
          return await getExportDownloadUrl(this, jobId, adminUser);
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : 'Failed to build download link' };
        }
      },
    })
  }

  /**
   * Approximates how much the full result set of the given query will weigh, without reading it.
   * A small probe of records is fetched and its serialized size is multiplied by the total count.
   * Can be called programmatically, e.g. `this.estimateExportSize(filters, sort)`.
   */
  public async estimateExportSize(
    filters: any,
    sort: any
  ): Promise<{ totalRows: number; serializedMiB: number; ramMiB: number }> {
    const connector = this.adminforth.connectors[this.resourceConfig.dataSource];
    const probe = await connector.getData({
      resource: this.resourceConfig,
      limit: SIZE_PROBE_ROWS,
      offset: 0,
      filters: connector.validateAndNormalizeInputFilters(filters),
      sort,
      getTotals: true,
    });

    const totalRows = probe.total ?? 0;
    if (!totalRows || probe.data.length === 0) {
      return { totalRows, serializedMiB: 0, ramMiB: 0 };
    }

    const bytesPerRow = Buffer.byteLength(JSON.stringify(probe.data), 'utf8') / probe.data.length;
    const serializedMiB = (bytesPerRow * totalRows) / 1024 / 1024;

    return { totalRows, serializedMiB, ramMiB: serializedMiB * RAM_OVERHEAD_FACTOR };
  }

  /**
   * Export resource records as CSV-ready data.
   * Can be called programmatically, e.g. `this.exportCsv(filters, sort)`.
   */
  public async exportCsv(
    filters: any,
    sort: any,
    options: { adminUser?: AdminUser; headers?: Record<string, string> } = {}
  ): Promise<{
    ok: true;
    data: { fields: string[]; data: unknown[][] };
    columnsToForceQuote: boolean[];
    exportedCount: number;
  } | { ok: false; error: string }> {
    const { adminUser, headers } = options;
    const connector = this.adminforth.connectors[this.resourceConfig.dataSource];

    const { serializedMiB } = await this.estimateExportSize(filters, sort);
    console.log("Estimated size:", serializedMiB);
    const limit = this.options.classicalUploadLimitMiB ?? DEFAULT_EXPORT_VIA_UPLOAD_BUFFER_SIZE_MB;
    if (serializedMiB > limit) {
      return { 
        ok: false, 
        error: 'Upload limit exceeded, please filter smaller amount of data for export or contact your administrator' 
      };
    }

    const data = await connector.getData({
      resource: this.resourceConfig,
      limit: 1e6,
      offset: 0,
      filters: connector.validateAndNormalizeInputFilters(filters),
      sort,
      getTotals: true,
    });

    // prepare data for PapaParse unparse
    const columns = this.resourceConfig.columns.filter((col) => !col.virtual && !col.backendOnly);

    const columnsToForceQuote = columns.map(col => {
      return col.type !== AdminForthDataTypes.FLOAT
        && col.type !== AdminForthDataTypes.INTEGER
        && col.type !== AdminForthDataTypes.BOOLEAN;
    });

    const fields = columns.map((col) => col.name);

    const rows = data.data.map((row) => {
      return columns.map((col) => {
        const value = row[col.name];
        if (col.type === AdminForthDataTypes.JSON || col.isArray?.enabled) {
          return value == null ? value : JSON.stringify(value);
        }
        return value;
      });
    });

    if (adminUser) {
      this.tryToAuditLogAction('export', `Export CSV with filters: ${JSON.stringify(filters)} and sort: ${JSON.stringify(sort)}. Total records: ${rows.length}`, adminUser, headers);
    }

    return {
      ok: true,
      data: { fields, data: rows },
      columnsToForceQuote,
      exportedCount: data.total,
    };
  }

  /**
   * Import records from column-oriented data, creating new records and updating
   * existing ones (matched by primary key).
   * Can be called programmatically, e.g. `this.importCsv(data, { adminUser })`.
   */
  public async importCsv(
    data: Record<string, unknown[]>,
    options: {
      adminUser?: AdminUser;
      headers?: Record<string, string>;
      extra?: HttpExtra;
      response?: IAdminForthHttpResponse;
    } = {}
  ): Promise<{ ok: boolean; importedCount?: number; updatedCount?: number; errors: string[] }> {
    const { adminUser, headers, extra, response } = options;
    const columns = this.getColumnNames(data);
    const { errors, resourceColumns } = this.validateColumns(columns);
    const resource = this.adminforth.config.resources.find(r => r.resourceId === this.resourceConfig.resourceId);

    if (errors.length > 0) {
      return { ok: false, errors };
    }
    const primaryKeyColumn = this.resourceConfig.columns.find(col => col.primaryKey);
    const rows = this.buildRowsFromData(data, columns, resourceColumns, { coerceTypes: true });

    if (adminUser) {
      this.tryToAuditLogAction('import', `Import CSV with ${Object.keys(data).length} columns`, adminUser, headers);
    }

    let importedCount = 0;
    let updatedCount = 0;
    const limit = pLimit(100);

    await Promise.all(rows.map((row) => limit(async () => {
      try {
        const rowErrors = await this.isRowValid(row);
        if (rowErrors.length > 0) {
          errors.push(...rowErrors);
          return;
        }
        const recordId = primaryKeyColumn ? row[primaryKeyColumn.name] as string : undefined;
        if (primaryKeyColumn && recordId) {
          const existingRecord = await this.adminforth.resource(this.resourceConfig.resourceId)
            .list([Filters.EQ(primaryKeyColumn.name, recordId)]);

          if (existingRecord.length > 0) {
            const connector = this.adminforth.connectors[resource.dataSource];
            const oldRecord = await connector.getRecordByPrimaryKey(resource, recordId);
            if (!oldRecord) {
              errors.push(`Record with ${primaryKeyColumn.name} ${recordId} not found`);
              return;
            }
            const { error } = await this.adminforth.updateResourceRecord({
              resource, updates: row, adminUser, oldRecord, recordId, response,
              extra,
            });
            if (error) {
              errors.push(error);
              return;
            }
            updatedCount++;
            return;
          }
        }
        await this.adminforth.createResourceRecord({
          resource: resource,
          record: row,
          adminUser: adminUser,
          extra,
        });
        importedCount++;
      } catch (e) {
        errors.push(e.message);
      }
    })));

    return { ok: true, importedCount, updatedCount, errors };
  }

  /**
   * Import only records that do not already exist (matched by primary key).
   * Can be called programmatically, e.g. `this.importCsvNewOnly(data, { adminUser })`.
   */
  public async importCsvNewOnly(
    data: Record<string, unknown[]>,
    options: {
      adminUser?: AdminUser;
      headers?: Record<string, string>;
      extra?: HttpExtra;
    } = {}
  ): Promise<{ ok: boolean; importedCount?: number; errors: string[] }> {
    const { adminUser, headers, extra } = options;
    const columns = this.getColumnNames(data);
    const resource = this.adminforth.config.resources.find(r => r.resourceId === this.resourceConfig.resourceId);
    const { errors, resourceColumns } = this.validateColumns(columns);
    if (errors.length > 0) {
      return { ok: false, errors };
    }

    const primaryKeyColumn = this.resourceConfig.columns.find(col => col.primaryKey);
    const rows = this.buildRowsFromData(data, columns, resourceColumns, { coerceTypes: true });

    if (adminUser) {
      this.tryToAuditLogAction('import', `Import CSV (new only) with ${Object.keys(data).length} columns`, adminUser, headers);
    }

    let importedCount = 0;
    const limit = pLimit(100);

    await Promise.all(rows.map((row) => limit(async () => {
      try {
        const rowErrors = await this.isRowValid(row);
        if (rowErrors.length > 0) {
          errors.push(...rowErrors);
          return;
        }
        if (primaryKeyColumn && row[primaryKeyColumn.name]) {
          const existingRecord = await this.adminforth.resource(this.resourceConfig.resourceId)
            .list([Filters.EQ(primaryKeyColumn.name, row[primaryKeyColumn.name])]);

          if (existingRecord.length > 0) {
            return;
          }
        }
        await this.adminforth.createResourceRecord({
          resource: resource,
          record: row,
          adminUser: adminUser,
          extra,
        });
        importedCount++;
      } catch (e) {
        errors.push(e.message);
      }
    })));

    return { ok: true, importedCount, errors };
  }

  /**
   * Check how many of the given records already exist (matched by primary key).
   * Can be called programmatically, e.g. `this.checkRecords(data)`.
   */
  public async checkRecords(data: Record<string, unknown[]>): Promise<{
    ok: true;
    total: number;
    existingCount: number;
    newCount: number;
  }> {
    const primaryKeyColumn = this.resourceConfig.columns.find(col => col.primaryKey);
    const columns = this.getColumnNames(data);
    const rows = this.buildRowsFromData(data, columns, undefined, { coerceTypes: false });

    const primaryKeys = rows
      .map(row => primaryKeyColumn ? row[primaryKeyColumn.name] : undefined)
      .filter(key => key !== undefined && key !== null && key !== '');

    const existingRecords = await this.adminforth
      .resource(this.resourceConfig.resourceId)
      .list([{
        field: primaryKeyColumn.name,
        operator: AdminForthFilterOperators.IN,
        value: primaryKeys,
      }]);

    return {
      ok: true,
      total: rows.length,
      existingCount: existingRecords.length,
      newCount: rows.length - existingRecords.length,
    };
  }

  private getColumnNames(data: Record<string, unknown[]>): string[] {
    return Object.keys(data ?? {});
  }

  private validateColumns(columns: string[]): {
    errors: string[];
    resourceColumns: AdminForthResourceColumn[];
  } {
    const errors: string[] = [];
    const resourceColumns: AdminForthResourceColumn[] = [];

    columns.forEach((col) => {
      const resourceColumn = this.resourceConfig.columns.find((c) => c.name === col);
      if (!resourceColumn) {
        const similar = suggestIfTypo(this.resourceConfig.columns.map((c) => c.name), col);
        errors.push(
          `Column '${col}' defined in CSV not found in resource '${this.resourceConfig.resourceId}'. ${
            similar
              ? `If you mean '${similar}', rename it in CSV`
              : 'If column is in database but not in resource configuration, add it with showIn:[]'
          }`
        );
        return;
      }
      resourceColumns.push(resourceColumn);
    });

    return { errors, resourceColumns };
  }

  private buildRowsFromData(
    data: Record<string, unknown[]>,
    columns: string[],
    resourceColumns?: AdminForthResourceColumn[],
    { coerceTypes }: { coerceTypes: boolean } = { coerceTypes: true }
  ) {
    const columnValues: unknown[][] = Object.values(data ?? {});
    if (columns.length === 0 || columnValues.length === 0) {
      return [];
    }

    const rows: Record<string, unknown>[] = [];
    const rowCount = columnValues[0].length;

    for (let i = 0; i < rowCount; i++) {
      const row: Record<string, unknown> = {};
      for (let j = 0; j < columns.length; j++) {
        const val = columnValues[j][i];
        const resourceCol = resourceColumns ? resourceColumns[j] : undefined;
        row[columns[j]] = coerceTypes
          ? this.coerceValue(resourceCol, val)
          : val;
      }
      rows.push(row);
    }

    return rows;
  }

  private coerceValue(resourceCol: AdminForthResourceColumn | undefined, val: unknown): unknown {
    if (!resourceCol || val === '') {
      return val;
    }

    if (
      (resourceCol.type === AdminForthDataTypes.INTEGER
        || resourceCol.type === AdminForthDataTypes.FLOAT)
    ) {
      return +val;
    }

    if (resourceCol.type === AdminForthDataTypes.BOOLEAN) {
      if (typeof val === 'string') {
        return val.toLowerCase() === 'true' || val === '1';
      }
      return val === 1 || val === true;
    }

    if (resourceCol.type === AdminForthDataTypes.JSON || resourceCol.isArray?.enabled) {
      if (typeof val === 'string') {
        try {
          return JSON.parse(val);
        } catch {
          return val;
        }
      }
      return val;
    }

    return val;
  }

}