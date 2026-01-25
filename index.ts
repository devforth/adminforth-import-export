import { AdminForthPlugin, suggestIfTypo, AdminForthFilterOperators, Filters, AdminForthDataTypes } from "adminforth";
import type { IAdminForth, IHttpServer, AdminForthResourceColumn, AdminForthComponentDeclaration, AdminForthResource } from "adminforth";
import type { PluginOptions } from './types.js';

export default class ImportExport extends AdminForthPlugin {
  options: PluginOptions;
  emailField: AdminForthResourceColumn;
  authResourceId: string;
  adminforth: IAdminForth;

  constructor(options: PluginOptions) {
    super(options, import.meta.url);
    this.options = options;
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
      noAuth: true,
      handler: async ({ body }) => {
        const { filters, sort } = body;

        const data = await this.adminforth.connectors[this.resourceConfig.dataSource].getData({
          resource: this.resourceConfig,
          limit: 1e6,
          offset: 0,
          filters: this.adminforth.connectors[this.resourceConfig.dataSource].validateAndNormalizeInputFilters(filters),
          sort,
          getTotals: true,
        });

        // prepare data for PapaParse unparse
        const columns = this.resourceConfig.columns.filter((col) => !col.virtual);

        const columnsToForceQuote = columns.map(col => {
          return col.type !== AdminForthDataTypes.FLOAT 
            && col.type !== AdminForthDataTypes.INTEGER 
            && col.type !== AdminForthDataTypes.BOOLEAN;
        })

        const fields = columns.map((col) => col.name);

        const rows = data.data.map((row) => {
          return columns.map((col) => row[col.name]);
        });

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
      noAuth: true,
      handler: async ({ body }) => {
        const { data } = body;
        const rows = [];
        const columns = Object.keys(data);

        // check column names are valid
        const errors: string[] = [];
        columns.forEach((col) => {
          if (!this.resourceConfig.columns.some((c) => c.name === col)) {
            const similar = suggestIfTypo(this.resourceConfig.columns.map((c) => c.name), col);
            errors.push(`Column '${col}' defined in CSV not found in resource '${this.resourceConfig.resourceId}'. ${
              similar ? `If you mean '${similar}', rename it in CSV` : 'If column is in database but not in resource configuration, add it with showIn:[]'}`
            );
          }
        });
        if (errors.length > 0) {
          return { ok: false, errors };
        }

        const primaryKeyColumn = this.resourceConfig.columns.find(col => col.primaryKey);

        const resourceColumns = columns.map(colName => this.resourceConfig.columns.find(c => c.name === colName));

        const columnValues: any[] = Object.values(data);
        for (let i = 0; i < columnValues[0].length; i++) {
          const row = {};
          for (let j = 0; j < columns.length; j++) {
            const val = columnValues[j][i];
            const resourceCol = resourceColumns[j];

            if ( (resourceCol.type === AdminForthDataTypes.INTEGER 
                || resourceCol.type === AdminForthDataTypes.FLOAT) && val !== ''
              ) {
              // convert empty strings to null for numeric fields
              row[columns[j]] = +val;
            } else if (resourceCol.type === AdminForthDataTypes.BOOLEAN && val !== '') {
              row[columns[j]] = (val.toLowerCase() === 'true' || val === '1' || val === 1);
            } else {
              row[columns[j]] = val;
            }
          }
          rows.push(row);
        }

        console.log('Prepared rows for import:', rows);

        let importedCount = 0;
        let updatedCount = 0;

        await Promise.all(rows.map(async (row) => {
          try {
            if (primaryKeyColumn && row[primaryKeyColumn.name]) {
              const existingRecord = await this.adminforth.resource(this.resourceConfig.resourceId)
                .list([Filters.EQ(primaryKeyColumn.name, row[primaryKeyColumn.name])]);
              
              if (existingRecord.length > 0) {
                await this.adminforth.resource(this.resourceConfig.resourceId)
                  .update(row[primaryKeyColumn.name], row);
                updatedCount++;
                return;
              }
            }
            await this.adminforth.resource(this.resourceConfig.resourceId).create(row);
            importedCount++;
          } catch (e) {
            errors.push(e.message);
          }
        }));

        return { ok: true, importedCount, updatedCount, errors };
      }
    });

    server.endpoint({
      method: 'POST',
      path: `/plugin/${this.pluginInstanceId}/import-csv-new-only`,
      noAuth: true,
      handler: async ({ body }) => {
        const { data } = body;
        const rows = [];
        const columns = Object.keys(data);

        // check column names are valid
        const errors: string[] = [];
        columns.forEach((col) => {
          if (!this.resourceConfig.columns.some((c) => c.name === col)) {
            const similar = suggestIfTypo(this.resourceConfig.columns.map((c) => c.name), col);
            errors.push(`Column '${col}' defined in CSV not found in resource '${this.resourceConfig.resourceId}'. ${
              similar ? `If you mean '${similar}', rename it in CSV` : 'If column is in database but not in resource configuration, add it with showIn:[]'}`
            );
          }
        });
        if (errors.length > 0) {
          return { ok: false, errors };
        }

        const primaryKeyColumn = this.resourceConfig.columns.find(col => col.primaryKey);
        const resourceColumns = columns.map(colName => this.resourceConfig.columns.find(c => c.name === colName));
        const columnValues: any[] = Object.values(data);
        for (let i = 0; i < columnValues[0].length; i++) {
          const row = {};
          for (let j = 0; j < columns.length; j++) {
            const val = columnValues[j][i];
            const resourceCol = resourceColumns[j];

            if ( (resourceCol.type === AdminForthDataTypes.INTEGER 
                || resourceCol.type === AdminForthDataTypes.FLOAT) && val !== ''
              ) {
              // convert empty strings to null for numeric fields
              row[columns[j]] = +val;
            } else if (resourceCol.type === AdminForthDataTypes.BOOLEAN && val !== '') {
              row[columns[j]] = (val.toLowerCase() === 'true' || val === '1' || val === 1);
            } else {
              row[columns[j]] = val;
            }
          }
          rows.push(row);
        }

        let importedCount = 0;

        await Promise.all(rows.map(async (row) => {
          try {
            if (primaryKeyColumn && row[primaryKeyColumn.name]) {
              const existingRecord = await this.adminforth.resource(this.resourceConfig.resourceId)
                .list([Filters.EQ(primaryKeyColumn.name, row[primaryKeyColumn.name])]);
              
              if (existingRecord.length > 0) {
                return;
              }
            }
            await this.adminforth.resource(this.resourceConfig.resourceId).create(row);
            importedCount++;
          } catch (e) {
            errors.push(e.message);
          }
        }));

        return { ok: true, importedCount, errors };
      }
    });

    server.endpoint({
      method: 'POST',
      path: `/plugin/${this.pluginInstanceId}/check-records`,
      noAuth: true,
      handler: async ({ body }) => {
        const { data } = body as { data: Record<string, unknown[]> };
        const primaryKeyColumn = this.resourceConfig.columns.find(col => col.primaryKey);
        const columns = Object.keys(data);
        const columnValues = Object.values(data);

        const rows = Array.from({ length: columnValues[0].length }, (_, i) => {
          const row = {};
          for (let j = 0; j < columns.length; j++) {
            row[columns[j]] = columnValues[j][i];
          }
          return row;
        });

        const primaryKeys = rows
          .map(row => row[primaryKeyColumn.name])
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

}