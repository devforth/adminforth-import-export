<template>
  <div ref="rootRef" class="relative" @click.stop>
    <div class="cursor-pointer flex gap-2 items-center justify-between -mx-4 -my-2 px-4 py-2" @click="toggle">
      <span class="flex gap-2 items-center">
        {{ $t('Export to CSV') }}

        <svg v-if="inProgress"
          aria-hidden="true" class="w-4 h-4 text-gray-200 animate-spin dark:text-gray-600 fill-blue-600" viewBox="0 0 100 101" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M100 50.5908C100 78.2051 77.6142 100.591 50 100.591C22.3858 100.591 0 78.2051 0 50.5908C0 22.9766 22.3858 0.59082 50 0.59082C77.6142 0.59082 100 22.9766 100 50.5908ZM9.08144 50.5908C9.08144 73.1895 27.4013 91.5094 50 91.5094C72.5987 91.5094 90.9186 73.1895 90.9186 50.5908C90.9186 27.9921 72.5987 9.67226 50 9.67226C27.4013 9.67226 9.08144 27.9921 9.08144 50.5908Z" fill="currentColor"/><path d="M93.9676 39.0409C96.393 38.4038 97.8624 35.9116 97.0079 33.5539C95.2932 28.8227 92.871 24.3692 89.8167 20.348C85.8452 15.1192 80.8826 10.7238 75.2124 7.41289C69.5422 4.10194 63.2754 1.94025 56.7698 1.05124C51.7666 0.367541 46.6976 0.446843 41.7345 1.27873C39.2613 1.69328 37.813 4.19778 38.4501 6.62326C39.0873 9.04874 41.5694 10.4717 44.0505 10.1071C47.8511 9.54855 51.7191 9.52689 55.5402 10.0491C60.8642 10.7766 65.9928 12.5457 70.6331 15.2552C75.2735 17.9648 79.3347 21.5619 82.5849 25.841C84.9175 28.9121 86.7997 32.2913 88.1811 35.8758C89.083 38.2158 91.5421 39.6781 93.9676 39.0409Z" fill="currentFill"/></svg>
      </span>
      <svg class="w-2 h-2 shrink-0" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 6 10">
        <path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 1 1 5l4 4"/>
      </svg>
    </div>

    <div v-if="open"
      class="absolute right-full top-0 mr-5 z-40 w-max bg-lightThreeDotsMenuBodyBackground dark:bg-darkThreeDotsMenuBodyBackground rounded-lg shadow border border-gray-100 dark:border-gray-600">
      <ul class="py-2 text-sm text-lightThreeDotsMenuBodyText dark:text-darkThreeDotsMenuBodyText">
        <li v-for="option in options" :key="option.select">
          <div
            class="px-4 py-1.5 text-sm whitespace-nowrap"
            :class="isDisabled(option)
              ? 'opacity-50 cursor-not-allowed'
              : 'cursor-pointer hover:text-lightThreeDotsMenuBodyTextHover hover:bg-lightThreeDotsMenuBodyBackgroundHover dark:hover:bg-darkThreeDotsMenuBodyBackgroundHover dark:hover:text-darkThreeDotsMenuBodyTextHover'"
            @click="!isDisabled(option) && run(option.select)"
          >
            {{ option.label() }}
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
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
const rootRef = ref<HTMLElement | null>(null);
const allCount = ref<number | null>(null);
const filteredCount = ref<number | null>(null);

defineExpose({
  click: () => { toggle(); },
});

const props = defineProps({
  meta: Object,
  record: Object,
  checkboxes: Array,
});

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

function handleClickOutside(e: MouseEvent) {
  if (open.value && rootRef.value && !rootRef.value.contains(e.target as Node)) {
    open.value = false;
  }
}

onMounted(() => document.addEventListener('mousedown', handleClickOutside));
onUnmounted(() => document.removeEventListener('mousedown', handleClickOutside));

function toggle() {
  open.value = !open.value;
  if (open.value) {
    fetchCounts();
  }
}

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
  open.value = false;
  exportCsv(select);
}

function downloadFile(data: string, filename: string) {
  const blob = new Blob([data], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  window.URL.revokeObjectURL(url);
}

async function exportCsv(select: string) {
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

    // Generate properly formatted CSV
    const csvContent = '﻿' + Papa.unparse(resp.data, {
      quotes: resp.columnsToForceQuote, // Force quotes only certain columns (!!!not all this breaks BI/Excel tasks)
      quoteChar: '"',
      escapeChar: '"',
    });

    // Download the file
    const filename = `export-${coreStore.resource?.resourceId}-${new Date().toISOString()}.csv`;
    downloadFile(csvContent, filename);

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
