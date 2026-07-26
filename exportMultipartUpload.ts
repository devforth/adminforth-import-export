import { AdminForthDataTypes, AdminForthSortDirections, Filters } from 'adminforth';
import type { AdminForthResourceColumn, AdminUser, IAdminForthSort } from 'adminforth';
import { stringify } from 'csv/sync';
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

type TaskState = {
  filters: any;
  sort: IAdminForthSort[];
  fileKey: string;
  fileName: string;
};

type TaskHandlerParams = {
  jobId: string;
  getState: () => Promise<Record<string, any>>;
};

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
function serializeRow(columns: AdminForthResourceColumn[], row: Record<string, any>): (string | null)[] {
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
  const { filters, sort, fileKey } = (await getState()) as TaskState;
  const { storageAdapter, bufferSizeMb, readChunkSize } = plugin.options.exportBigDataset;
  const chunkSize = readChunkSize ?? DEFAULT_READ_CHUNK_SIZE;

  const connector = plugin.adminforth.connectors[plugin.resourceConfig.dataSource];
  //normalize filters and sort 
  const normalizedFilters = connector.validateAndNormalizeInputFilters(filters);
  const stableSort = buildStableSort(plugin, sort);
  //get columns, fields in format like: ['id', 'name', 'email', 'balance'] and columnsToForceQuote in format like: [false, true, true, false]
  const { columns, fields, columnsToForceQuote } = getExportColumns(plugin);

  const estimatedTotal: number = (await backgroundJobsPlugin.getJobStateField(jobId, 'totalRows')) ?? 0;

  const writer = await storageAdapter.createWriteStream(fileKey, 'text/csv', bufferSizeMb);

  let exportedRows = 0;
  let lastProgressPublishedAt = 0;
  let lastCancellationCheckAt = Date.now();
  let cancelled = false;

  try {
    // BOM keeps Excel happy with non-ASCII values
    // Add this symbol to the beginning of the file to indicate that it is UTF-8 encoded. (requred for some versions of Excel for some reason. Without this symbol encoding can be broken)
    await writer.write('﻿' + buildCsvChunk([fields], columnsToForceQuote));
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
        await writer.write(buildCsvChunk(data.map((row) => serializeRow(columns, row)), columnsToForceQuote));
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
      await abortQuietly(writer, fileKey);
      await backgroundJobsPlugin.setJobStateField(jobId, 'exportedRows', exportedRows);
      return;
    }

    await writer.close();
  } catch (e) {
    // leaves no dangling multipart upload behind
    await abortQuietly(writer, fileKey);
    throw e;
  }

  await backgroundJobsPlugin.setJobStateField(jobId, 'totalRows', exportedRows);
  await backgroundJobsPlugin.setJobStateField(jobId, 'exportedRows', exportedRows);
  await backgroundJobsPlugin.setJobStateField(jobId, 'fileReady', true);
}

/**
 * ✅Creates the background job which exports the resource into a CSV file in the storage adapter.
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

  const fileName = `export-${resourceId}-${new Date().toISOString()}.csv`;
  // job id is not known before the job is created, so the timestamped name is what makes the key unique
  const fileKey = `adminforth-import-export/${resourceId}/${fileName}`;

  const jobId = await backgroundJobsPlugin.startNewJob(
    `Export ${resourceId} to CSV`,
    adminUser,
    [{ state: { filters, sort, fileKey, fileName } as TaskState }],
    `${EXPORT_CSV_JOB_HANDLER_NAME}-${plugin.pluginInstanceId}`,
    {
      pluginInstanceId: plugin.pluginInstanceId,
      resourceId,
      fileName,
      fileKey,
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
): Promise<{ ok: boolean; url?: string; fileName?: string; error?: string }> {
  const backgroundJobsPlugin = getBackgroundJobsPlugin(plugin);

  const jobRecord = await getJobRecord(plugin, jobId);
  if (!jobRecord) {
    return { ok: false, error: 'Export job not found' };
  }
  if (jobRecord[backgroundJobsPlugin.options.jobHandlerField] !== `${EXPORT_CSV_JOB_HANDLER_NAME}-${plugin.pluginInstanceId}`) {
    return { ok: false, error: 'Export job not found' };
  }

  const state = jobRecord[backgroundJobsPlugin.options.stateField] || {};

  if (!state.fileReady || !state.fileKey) {
    return { ok: false, error: 'Export is not finished yet' };
  }

  const { storageAdapter } = plugin.options.exportBigDataset;
  const url = await storageAdapter.getDownloadUrl(state.fileKey, DOWNLOAD_URL_EXPIRES_IN_SECONDS);

  return { ok: true, url, fileName: state.fileName };
}
