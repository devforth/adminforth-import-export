import { AdminForthDataTypes, AdminForthSortDirections, Filters } from 'adminforth';
import type { AdminForthResourceColumn, AdminUser, IAdminForthSort } from 'adminforth';
import { stringify } from 'csv/sync';
import ExcelJS from 'exceljs';
import { Writable } from 'node:stream';
import type BackgroundJobsPlugin from '@adminforth/background-jobs';
import type ImportExportPlugin from './index.js';

export const EXPORT_CSV_JOB_HANDLER_NAME = 'export_csv_job_handler';
export const MINIMAL_BUFFER_SIZE_MB = 5;

/** How many records are pulled from the database per iteration, unless overridden in plugin options. */
export const DEFAULT_READ_CHUNK_SIZE = 100;
/** Minimal delay between two progress publications, to not spam websocket/db on fast datasets. */
const PROGRESS_PUBLISH_INTERVAL_MS = 1000;
/** Minimal delay between two checks whether the job was cancelled from UI. */
const CANCELLATION_CHECK_INTERVAL_MS = 2000;
/** Lifetime of the presigned download link handed to the browser. */
const DOWNLOAD_URL_EXPIRES_IN_SECONDS = 3600;
/** Excel's worksheet limit includes the header row. */
const MAX_XLSX_DATA_ROWS_PER_SHEET = 1_048_575;

type TaskState = {
  filters: any;
  sort: IAdminForthSort[];
  fileKey: string;
  fileName: string;
  fileFormat: 'csv' | 'xlsx';
};

type TaskHandlerParams = {
  jobId: string;
  getState: () => Promise<Record<string, any>>;
};

type ObjectWriter = {
  write(data: string | Buffer | Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
};

/** Bridges the storage adapter's async writer to the Node stream expected by ExcelJS. */
class StorageAdapterWritable extends Writable {
  constructor(private readonly writer: ObjectWriter) {
    super();
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const data = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk;
    this.writer.write(data).then(
      () => callback(),
      (error) => callback(error instanceof Error ? error : new Error(String(error))),
    );
  }
}

/**
 * ✅Columns which end up in the exported file. Mirrors {@link ImportExportPlugin.exportCsv}.
 */
function getExportColumns(plugin: ImportExportPlugin): {
  columns: AdminForthResourceColumn[];
  fields: string[];
  columnsToForceQuote: boolean[];
} {
  const columns = plugin.resourceConfig.columns.filter((col) => !col.virtual && !col.backendOnly);
  return {
    columns,
    fields: columns.map((col) => col.name),
    // numbers and booleans are left bare, everything else is quoted:
    // quoting all columns breaks BI/Excel tasks
    columnsToForceQuote: columns.map((col) => (
      col.type !== AdminForthDataTypes.FLOAT
      && col.type !== AdminForthDataTypes.INTEGER
      && col.type !== AdminForthDataTypes.BOOLEAN
      && col.type !== AdminForthDataTypes.DECIMAL
    )),
  };
}

/**
 * ✅Turns a record into an array of CSV cells. `null` is returned for empty cells so that
 * csv-stringify renders them as an empty unquoted value.
 */
function serializeCsvRow(columns: AdminForthResourceColumn[], row: Record<string, any>): (string | null)[] {
  return columns.map((col) => {
    const value = row[col.name];
    if (value === null || value === undefined) {
      return null;
    }
    if (col.type === AdminForthDataTypes.JSON || col.isArray?.enabled) {
      return JSON.stringify(value);
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    return `${value}`;
  });
}

/** Preserves native spreadsheet types while serializing complex resource values as JSON. */
function serializeXlsxRow(columns: AdminForthResourceColumn[], row: Record<string, any>): (string | number | boolean | Date | null)[] {
  return columns.map((col) => {
    const value = row[col.name];
    if (value === null || value === undefined) {
      return null;
    }
    if (col.type === AdminForthDataTypes.JSON || col.isArray?.enabled) {
      return JSON.stringify(value);
    }
    if (value instanceof Date || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    return `${value}`;
  });
}

/**
 * ✅All cells are already strings, so the only thing `cast` does here is deciding per-column
 * whether the cell has to be quoted.
 */
function buildCsvChunk(rows: (string | null)[][], columnsToForceQuote: boolean[]): string {
  return stringify(rows, {
    quote: '"',
    escape: '"',
    cast: {
      string: (value: string, context: { index: number }) => (
        columnsToForceQuote[context.index]
          ? { value, quoted: true, quoted_empty: true }
          : value
      ),
    },
  });
}
//✅
function getBackgroundJobsPlugin(plugin: ImportExportPlugin): BackgroundJobsPlugin {
  const backgroundJobsPlugin = plugin.adminforth.getPluginByClassName<BackgroundJobsPlugin>('BackgroundJobsPlugin');
  if (!backgroundJobsPlugin) {
    throw new Error('BackgroundJobsPlugin is required for big dataset export, please add it to your plugins');
  }
  return backgroundJobsPlugin;
}

//✅
function getJobsResourceMeta(backgroundJobsPlugin: BackgroundJobsPlugin): { resourceId: string; pkColumn: string } {
  const resourceConfig = backgroundJobsPlugin.resourceConfig;
  return {
    resourceId: resourceConfig.resourceId,
    pkColumn: resourceConfig.columns.find((col) => col.primaryKey).name,
  };
}

//✅
async function getJobRecord(plugin: ImportExportPlugin, jobId: string): Promise<Record<string, any> | null> {
  const backgroundJobsPlugin = getBackgroundJobsPlugin(plugin);
  const { resourceId, pkColumn } = getJobsResourceMeta(backgroundJobsPlugin);
  return await plugin.adminforth.resource(resourceId).get(Filters.EQ(pkColumn, jobId));
}

/**
 * ✅Pagination by limit/offset is only stable when the sort is unambiguous, otherwise the database
 * is free to return the same record in two different chunks. Appending the primary key fixes it.
 */
function buildStableSort(plugin: ImportExportPlugin, sort: IAdminForthSort[]): IAdminForthSort[] {
  const primaryKeyColumn = plugin.resourceConfig.columns.find((col) => col.primaryKey);
  const normalizedSort: IAdminForthSort[] = Array.isArray(sort) ? [...sort] : [];
  if (!primaryKeyColumn || normalizedSort.some((s) => s.field === primaryKeyColumn.name)) {
    return normalizedSort;
  }
  return [...normalizedSort, { field: primaryKeyColumn.name, direction: AdminForthSortDirections.asc }];
}

/**
 * ✅Progress of the standard background-jobs UI is derived from the number of finished tasks, and
 * the whole export is a single task. So the percentage is published manually here.
 */
async function publishProgress(plugin: ImportExportPlugin, jobId: string, percent: number): Promise<void> {
  try {
    const backgroundJobsPlugin = getBackgroundJobsPlugin(plugin);
    const { resourceId } = getJobsResourceMeta(backgroundJobsPlugin);
    await plugin.adminforth.resource(resourceId).update(jobId, {
      [backgroundJobsPlugin.options.progressField]: percent,
    });
    plugin.adminforth.websocket.publish('/background-jobs-job-update', { jobId, progress: percent });
  } catch (e) {
    console.error(`ImportExport: failed to publish progress for export job ${jobId}:`, e);
  }
}

//✅
async function isJobCancelled(plugin: ImportExportPlugin, jobId: string): Promise<boolean> {
  try {
    const backgroundJobsPlugin = getBackgroundJobsPlugin(plugin);
    const jobRecord = await getJobRecord(plugin, jobId);
    return jobRecord?.[backgroundJobsPlugin.options.statusField] === 'CANCELLED';
  } catch (e) {
    console.error(`ImportExport: failed to read status of export job ${jobId}:`, e);
    return false;
  }
}

//✅
async function abortQuietly(writer: { abort: () => Promise<void> }, fileKey: string): Promise<void> {
  try {
    await writer.abort();
  } catch (e) {
    console.error(`ImportExport: failed to abort export upload "${fileKey}":`, e);
  }
}

//✅
export async function runExportCsvJob(
  plugin: ImportExportPlugin,
  { jobId, getState }: TaskHandlerParams,
): Promise<void> {
  const backgroundJobsPlugin = getBackgroundJobsPlugin(plugin);
  const { filters, sort, fileKey, fileFormat } = (await getState()) as TaskState;
  const { storageAdapter, bufferSizeMb, readChunkSize } = plugin.options.exportViaUpload;
  const chunkSize = readChunkSize ?? DEFAULT_READ_CHUNK_SIZE;

  const connector = plugin.adminforth.connectors[plugin.resourceConfig.dataSource];
  //normalize filters and sort 
  const normalizedFilters = connector.validateAndNormalizeInputFilters(filters);
  const stableSort = buildStableSort(plugin, sort);
  //get columns, fields in format like: ['id', 'name', 'email', 'balance'] and columnsToForceQuote in format like: [false, true, true, false]
  const { columns, fields, columnsToForceQuote } = getExportColumns(plugin);
  const isXlsx = (fileFormat ?? plugin.options.fileFormat) === 'xlsx';

  const estimatedTotal: number = (await backgroundJobsPlugin.getJobStateField(jobId, 'totalRows')) ?? 0;

  const contentType = isXlsx
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : 'text/csv';
  const writer = await storageAdapter.createWriteStream(fileKey, contentType, bufferSizeMb);
  let xlsxStream: StorageAdapterWritable | undefined;
  let xlsxWorkbook: ExcelJS.stream.xlsx.WorkbookWriter | undefined;
  let xlsxWorksheet: ExcelJS.Worksheet | undefined;
  let xlsxStreamError: Error | undefined;
  let xlsxSheetNumber = 0;
  let xlsxDataRowsInSheet = 0;

  let exportedRows = 0;
  let lastProgressPublishedAt = 0;
  let lastCancellationCheckAt = Date.now();
  let cancelled = false;

  try {
    if (isXlsx) {
      xlsxStream = new StorageAdapterWritable(writer);
      // Attach immediately because the archive starts writing before workbook.commit().
      xlsxStream.on('error', (error) => {
        xlsxStreamError = error;
      });
      xlsxWorkbook = new ExcelJS.stream.xlsx.WorkbookWriter({
        stream: xlsxStream,
        useSharedStrings: false,
        useStyles: false,
      });
      xlsxSheetNumber = 1;
      xlsxWorksheet = xlsxWorkbook.addWorksheet('Export');
      xlsxWorksheet.addRow(fields).commit();
    } else {
      // BOM keeps Excel-compatible CSV readers from misdetecting UTF-8 text.
      await writer.write('﻿' + buildCsvChunk([fields], columnsToForceQuote));
    }

    for (let offset = 0; ; offset += chunkSize) {
      const { data } = await connector.getData({
        resource: plugin.resourceConfig,
        limit: chunkSize,
        offset,
        filters: normalizedFilters,
        sort: stableSort,
        getTotals: false,
      });


      if (data.length) {
        if (xlsxWorksheet) {
          data.forEach((row) => {
            if (xlsxDataRowsInSheet === MAX_XLSX_DATA_ROWS_PER_SHEET) {
              xlsxWorksheet.commit();
              xlsxSheetNumber++;
              xlsxWorksheet = xlsxWorkbook.addWorksheet(`Export ${xlsxSheetNumber}`);
              xlsxWorksheet.addRow(fields).commit();
              xlsxDataRowsInSheet = 0;
            }
            xlsxWorksheet.addRow(serializeXlsxRow(columns, row)).commit();
            xlsxDataRowsInSheet++;
          });
          if (xlsxStreamError) {
            throw xlsxStreamError;
          }
        } else {
          await writer.write(buildCsvChunk(data.map((row) => serializeCsvRow(columns, row)), columnsToForceQuote));
        }
        exportedRows += data.length;
      }

      const now = Date.now();
      if (now - lastCancellationCheckAt >= CANCELLATION_CHECK_INTERVAL_MS) {
        lastCancellationCheckAt = now;
        if (await isJobCancelled(plugin, jobId)) {
          cancelled = true;
          break;
        }
      }

      const isLastChunk = data.length < chunkSize;
      if (!isLastChunk && now - lastProgressPublishedAt >= PROGRESS_PUBLISH_INTERVAL_MS) {
        lastProgressPublishedAt = now;
        await backgroundJobsPlugin.setJobStateField(jobId, 'exportedRows', exportedRows);
        if (estimatedTotal > 0) {
          // the estimate can be stale, so never let it reach 100% before the file is closed
          await publishProgress(plugin, jobId, Math.min(99, Math.floor((exportedRows / estimatedTotal) * 100)));
        }
      }

      if (isLastChunk) {
        break;
      }
    }

    if (cancelled) {
      // Finalize the ZIP stream so all pending writes settle before aborting the multipart upload.
      if (xlsxWorkbook) {
        await xlsxWorkbook.commit();
      }
      await abortQuietly(writer, fileKey);
      await backgroundJobsPlugin.setJobStateField(jobId, 'exportedRows', exportedRows);
      return;
    }

    if (xlsxWorkbook) {
      await xlsxWorkbook.commit();
      if (xlsxStreamError) {
        throw xlsxStreamError;
      }
    }
    await writer.close();
  } catch (e) {
    // leaves no dangling multipart upload behind
    xlsxStream?.destroy();
    await abortQuietly(writer, fileKey);
    throw e;
  }

  await backgroundJobsPlugin.setJobStateField(jobId, 'totalRows', exportedRows);
  await backgroundJobsPlugin.setJobStateField(jobId, 'exportedRows', exportedRows);
  await backgroundJobsPlugin.setJobStateField(jobId, 'fileReady', true);
}

/**
 * ✅Creates the background job which exports the resource into a CSV or XLSX file in the storage adapter.
 */
export async function startExport(
  plugin: ImportExportPlugin,
  {
    filters,
    sort,
    adminUser,
    totalRows,
  }: {
    filters: any;
    sort: IAdminForthSort[];
    adminUser: AdminUser;
    totalRows?: number;
  },
): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  const backgroundJobsPlugin = getBackgroundJobsPlugin(plugin);
  const resourceId = plugin.resourceConfig.resourceId;
  const fileFormat = plugin.options.fileFormat ?? 'csv';

  const fileName = `export-${resourceId}-${new Date().toISOString()}.${fileFormat}`;
  // job id is not known before the job is created, so the timestamped name is what makes the key unique
  const fileKey = `adminforth-import-export/${resourceId}/${fileName}`;

  const jobId = await backgroundJobsPlugin.startNewJob(
    `Export ${resourceId} to ${fileFormat.toUpperCase()}`,
    adminUser,
    [{ state: { filters, sort, fileKey, fileName, fileFormat } as TaskState }],
    `${EXPORT_CSV_JOB_HANDLER_NAME}-${plugin.pluginInstanceId}`,
    {
      pluginInstanceId: plugin.pluginInstanceId,
      resourceId,
      fileName,
      fileKey,
      fileFormat,
      fileReady: false,
      exportedRows: 0,
      totalRows: totalRows ?? 0,
    },
  );

  return { ok: true, jobId };
}

/**
 * ✅Returns a short living presigned link to the file produced by the given export job.
 */
export async function getExportDownloadUrl(
  plugin: ImportExportPlugin,
  jobId: string,
  adminUser: AdminUser
): Promise<{ ok: boolean; url?: string; fileName?: string; error?: string }> {
  const backgroundJobsPlugin = getBackgroundJobsPlugin(plugin);

  const jobRecord = await getJobRecord(plugin, jobId);
  if (!jobRecord) {
    return { ok: false, error: 'Export job not found' };
  }
  if (jobRecord[backgroundJobsPlugin.options.jobHandlerField] !== `${EXPORT_CSV_JOB_HANDLER_NAME}-${plugin.pluginInstanceId}`) {
    return { ok: false, error: 'Export job not found' };
  }
  if (jobRecord[backgroundJobsPlugin.options.startedByField] !== adminUser.pk /* && !isPrivileged(adminUser) */) {
    return { ok:false, error:'Export job not found' };  // same message → not an existence oracle
  }

  const state = jobRecord[backgroundJobsPlugin.options.stateField] || {};

  if (!state.fileReady || !state.fileKey) {
    return { ok: false, error: 'Export is not finished yet' };
  }

  const { storageAdapter } = plugin.options.exportViaUpload;
  const url = await storageAdapter.getDownloadUrl(state.fileKey, DOWNLOAD_URL_EXPIRES_IN_SECONDS);

  return { ok: true, url, fileName: state.fileName };
}
