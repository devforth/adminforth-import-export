import { AdminForthPlugin, suggestIfTypo, AdminForthFilterOperators, Filters, AdminForthDataTypes, rejectApiRawFilters, interpretResource, ActionCheckSource, AllowedActionsEnum } from "adminforth";
import type { IAdminForth, IHttpServer, AdminForthResourceColumn, AdminForthComponentDeclaration, AdminForthResource, AdminUser } from "adminforth";
import type { PluginOptions } from './types.js';
import pLimit from 'p-limit';
import { z } from "zod";

const exportCsvBodySchema = z.object({
  filters: z.any(),
  sort: z.any(),
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
    (resourceConfig.options.pageInjections.list.threeDotsDropdownItems as AdminForthComponentDeclaration[]).push({
      file: this.componentPath('ExportCsv.vue'),
      meta: { pluginInstanceId: this.pluginInstanceId, select: 'all' }
    }, {
      file: this.componentPath('ExportCsv.vue'),
      meta: { pluginInstanceId: this.pluginInstanceId, select: 'filtered' }
    }, {
      file: this.componentPath('ImportCsv.vue'),
      meta: { pluginInstanceId: this.pluginInstanceId }
    });


    // simply modify resourceConfig or adminforth.config. You can get access to plugin options via this.options;
  }
  
  validateConfigAfterDiscover(adminforth: IAdminForth, resourceConfig: AdminForthResource) {
    // optional method where you can safely check field types after database discovery was performed
    try {
      this.auditLogPlugin = this.adminforth.getPluginByClassName('AuditLogPlugin');
    } catch (e) {
      console.warn('Failed to get AuditLogPlugin for imort-export plugin. Audit logging will be skipped.');
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
      handler: async ({ body, adminUser, headers, response }) => {
        const payload = body as z.infer<typeof exportCsvBodySchema>;
        const { filters, sort } = payload;
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
        const data = await this.adminforth.connectors[this.resourceConfig.dataSource].getData({
          resource: this.resourceConfig,
          limit: 1e6,
          offset: 0,
          filters: this.adminforth.connectors[this.resourceConfig.dataSource].validateAndNormalizeInputFilters(filters),
          sort,
          getTotals: true,
        });

        // prepare data for PapaParse unparse
        const columns = this.resourceConfig.columns.filter((col) => !col.virtual && !col.backendOnly);

        const columnsToForceQuote = columns.map(col => {
          return col.type !== AdminForthDataTypes.FLOAT 
            && col.type !== AdminForthDataTypes.INTEGER 
            && col.type !== AdminForthDataTypes.BOOLEAN;
        })

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

        this.tryToAuditLogAction('export', `Export CSV with filters: ${JSON.stringify(filters)} and sort: ${JSON.stringify(sort)}. Total records: ${rows.length}`, adminUser, headers);

        return { 
          data: { fields, data: rows }, 
          columnsToForceQuote, 
          exportedCount: data.total, 
          ok: true 
        };
      }
    });

    server.endpoint({
      method: 'POST',
      path: `/plugin/${this.pluginInstanceId}/import-csv`,
      request_schema: importCsvBodySchema,
      handler: async ({ body, adminUser, query, headers, cookies, requestUrl, response }) => {
        const payload = body as z.infer<typeof importCsvBodySchema>;
        const { data } = payload;
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
        const columns = this.getColumnNames(data);
        const { errors, resourceColumns } = this.validateColumns(columns);
        const resource = this.adminforth.config.resources.find(r => r.resourceId === this.resourceConfig.resourceId);

        if (errors.length > 0) {
          return { ok: false, errors };
        }
        const primaryKeyColumn = this.resourceConfig.columns.find(col => col.primaryKey);
        const rows = this.buildRowsFromData(data, columns, resourceColumns, { coerceTypes: true });

        console.log('Prepared rows for import:', rows);
        this.tryToAuditLogAction('import', `Import CSV with ${Object.keys(data).length} columns`, adminUser, headers);

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
                const oldRecord = await connector.getRecordByPrimaryKey(resource, recordId)
                if (!oldRecord) {
                    const primaryKeyColumn = resource.columns.find((col) => col.primaryKey);
                    return { error: `Record with ${primaryKeyColumn.name} ${recordId} not found` };
                }
                const { error } = await this.adminforth.updateResourceRecord({ 
                  resource, updates: row, adminUser, oldRecord, recordId, response, 
                  extra: { body, query, headers, cookies, requestUrl, response } 
                });
                if (error) {
                  return { error };
                }
                updatedCount++;
                return;
              }
            }
            await this.adminforth.createResourceRecord({
              resource: resource,
              record: row,
              adminUser: adminUser,
              extra: { body, query, headers, cookies, requestUrl, response } 
            });            
            importedCount++;
          } catch (e) {
            errors.push(e.message);
          }
        })));

        return { ok: true, importedCount, updatedCount, errors };
      }
    });

    server.endpoint({
      method: 'POST',
      path: `/plugin/${this.pluginInstanceId}/import-csv-new-only`,
      request_schema: importCsvBodySchema,
      handler: async ({ body, adminUser, query, headers, cookies, requestUrl, response }) => {
        const payload = body as z.infer<typeof importCsvBodySchema>;
        const { data } = payload;
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
        const columns = this.getColumnNames(data);
        const resource = this.adminforth.config.resources.find(r => r.resourceId === this.resourceConfig.resourceId);
        const { errors, resourceColumns } = this.validateColumns(columns);
        if (errors.length > 0) {
          return { ok: false, errors };
        }

        const primaryKeyColumn = this.resourceConfig.columns.find(col => col.primaryKey);
        const rows = this.buildRowsFromData(data, columns, resourceColumns, { coerceTypes: true });
        this.tryToAuditLogAction('import', `Import CSV (new only) with ${Object.keys(data).length} columns`, adminUser, headers);

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
              extra: { body, query, headers, cookies, requestUrl, response } 
            });
            importedCount++;
          } catch (e) {
            errors.push(e.message);
          }
        })));

        return { ok: true, importedCount, errors };
      }
    });

    server.endpoint({
      method: 'POST',
      path: `/plugin/${this.pluginInstanceId}/check-records`,
      request_schema: importCsvBodySchema,
      handler: async ({ body, adminUser, response }) => {
        const payload = body as z.infer<typeof importCsvBodySchema>;
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
        const { data } = payload;
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
    });
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