<template>
  <!-- stopping clicks keeps the three dots menu open while the format submenu is used -->
  <DropdownMenu
    v-model:open="open"
    placement="left-start"
    class="block -mx-3 -my-2"
    contentClass="min-w-[10rem]"
    @click.stop
  >
    <template #trigger>
      <div class="flex w-full items-center justify-between gap-3 px-3 py-2 cursor-pointer">
        <span class="flex items-center gap-2">
          <IconDownload class="w-4 h-4 text-lightInputIconColor dark:text-darkInputIconColor" aria-hidden="true" />
          {{ fileFormat === 'xlsx' ? $t('Export to Excel') : $t('Export to CSV') }}
          <Spinner v-if="inProgress" class="w-4 h-4" />
        </span>
        <IconChevronLeft class="w-4 h-4 shrink-0 text-lightInputIconColor dark:text-darkInputIconColor" aria-hidden="true" />
      </div>
    </template>

    <DropdownMenuItem
      v-for="option in options"
      :key="option.select"
      :disabled="isDisabled(option)"
      @click="run(option.select)"
    >
      {{ option.label() }}
    </DropdownMenuItem>
  </DropdownMenu>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { DropdownMenu, DropdownMenuItem, Spinner } from '@/afcl';
import { IconChevronLeft, IconDownload } from '@iconify-prerendered/vue-lucide';
import { useCoreStore } from '@/stores/core';
import { callAdminForthApi } from '@/utils';
import { useFiltersStore } from '@/stores/filters';
import adminforth from '@/adminforth';
import Papa from 'papaparse';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const filtersStore = useFiltersStore();
const coreStore = useCoreStore();
const inProgress = ref(false);
const open = ref(false);
const allCount = ref<number | null>(null);
const filteredCount = ref<number | null>(null);
let countsPromise: Promise<void> | null = null;

defineExpose({
  click: () => { toggle(); },
});

const props = defineProps({
  meta: Object,
  record: Object,
  checkboxes: Array,
});
const fileFormat = props.meta?.fileFormat === 'xlsx' ? 'xlsx' : 'csv';

function formatCount(count: number) {
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${Math.floor(count / 1000)}k+`;
  return `${Math.floor(count / 1_000_000)}M+`;
}

function withCount(label: string, count: number | null) {
  return count === null ? `${label} (…)` : `${label} (${formatCount(count)})`;
}

const options = [
  { select: 'all', label: () => withCount(t('All'), allCount.value) },
  { select: 'filtered', label: () => withCount(t('Filtered'), filteredCount.value) },
  { select: 'selected', label: () => `${t('Selected')} (${props.checkboxes?.length || 0})` },
];

function isDisabled(option: { select: string }) {
  return option.select === 'selected' && !(props.checkboxes?.length);
}

function toggle() {
  open.value = !open.value;
}

watch(open, (opened) => {
  if (opened) {
    countsPromise = fetchCounts();
  }
});

async function fetchCounts() {
  const resourceId = coreStore.resource?.resourceId;
  if (!resourceId) {
    return;
  }
  const countOnly = (filters: any) => callAdminForthApi({
    path: '/get_resource_data',
    method: 'POST',
    body: { source: 'list', resourceId, limit: 1, offset: 0, filters, sort: [] },
  });
  try {
    const [allResp, filteredResp] = await Promise.all([
      countOnly([]),
      countOnly(filtersStore.getFilters()),
    ]);
    allCount.value = allResp?.total ?? null;
    filteredCount.value = filteredResp?.total ?? null;
  } catch (e) {
    // leave counts as null (renders "…") on failure
  }
}

function run(select: string) {
  if (props.meta?.exportViaUpload) {
    startExportJob(select);
  } else {
    exportFile(select);
  }
}

/**
 * Total is taken from counts already fetched for the dropdown labels, so the backend does not have
 * to run an extra count query just to render export progress.
 */
async function getTotalForSelection(select: string): Promise<number | undefined> {
  if (select === 'selected') {
    return props.checkboxes?.length || 0;
  }
  await countsPromise;
  const count = select === 'filtered' ? filteredCount.value : allCount.value;
  return count ?? undefined;
}

async function startExportJob(select: string) {
  inProgress.value = true;
  try {
    const resp = await callAdminForthApi({
      path: `/plugin/${props.meta?.pluginInstanceId}/start-export-job`,
      method: 'POST',
      body: {
        filters: select === 'filtered' ? filtersStore.getFilters() : [],
        sort: filtersStore.getSort(),
        selectedIds: select === 'selected' ? props.checkboxes : undefined,
        totalRows: await getTotalForSelection(select),
      },
    });

    if (!resp?.ok) {
      throw new Error(resp?.error || t('Failed to start export'));
    }

    // registered globally by the background jobs plugin
    (window as any).OpenJobInfoPopup?.(resp.jobId);
  } catch (error) {
    adminforth.alert({
      message: error instanceof Error ? error.message : t('Export failed'),
      variant: 'danger',
    });
  } finally {
    inProgress.value = false;
    adminforth.list.closeThreeDotsDropdown();
  }
}

function downloadFile(data: BlobPart, filename: string, mimeType: string) {
  const blob = new Blob([data], { type: mimeType });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  window.URL.revokeObjectURL(url);
}

async function exportFile(select: string) {
  inProgress.value = true;
  try {
    const resp = await callAdminForthApi({
      path: `/plugin/${props.meta?.pluginInstanceId}/export-csv`,
      method: 'POST',
      body: {
        filters: select === 'filtered' ? filtersStore.getFilters() : [],
        sort: filtersStore.getSort(),
        selectedIds: select === 'selected' ? props.checkboxes : undefined,
      }
    });

    if (resp.error) {
      throw new Error(resp.error);
    }

    const filenameBase = `export-${coreStore.resource?.resourceId}-${new Date().toISOString()}`;
    if (fileFormat === 'xlsx') {
      // exceljs is a CommonJS bundle: its API is the default export of the dynamic import
      const { default: ExcelJS } = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet('Export').addRows([resp.data.fields, ...resp.data.data]);
      downloadFile(
        await workbook.xlsx.writeBuffer(),
        `${filenameBase}.xlsx`,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
    } else {
      // BOM keeps Excel-compatible CSV readers from misdetecting UTF-8 text.
      const csvContent = '﻿' + Papa.unparse(resp.data, {
        quotes: resp.columnsToForceQuote,
        quoteChar: '"',
        escapeChar: '"',
      });
      downloadFile(csvContent, `${filenameBase}.csv`, 'text/csv;charset=utf-8');
    }

    adminforth.alert({
      message: `Exported ${resp.exportedCount} item${resp.exportedCount > 1 ? 's' : ''} successfully. Check your downloads folder`,
    });
  } catch (error) {
    adminforth.alert({
      message: error instanceof Error ? error.message : 'Export failed',
      variant: 'danger'
    });
  } finally {
    inProgress.value = false;
    adminforth.list.closeThreeDotsDropdown();
  }
}
</script>
