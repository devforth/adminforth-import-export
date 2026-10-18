<template>
  <div
    :class="[
      'flex items-center gap-2 cursor-pointer',
      checkProgress ? 'opacity-50 pointer-events-none' : ''
    ]">
    <IconUpload class="w-4 h-4 text-lightInputIconColor dark:text-darkInputIconColor" aria-hidden="true" />
    {{ fileFormat === 'xlsx' ? $t('Import from Excel') : $t('Import from CSV') }}
  </div>

  <Dialog ref="confirmDialog" class="w-full max-w-xl" :header="t('Import Confirmation')" :buttons="computedButtons">
    <div v-if="importStats" class="space-y-2">
      <template v-if="importStats.existingCount > 0 && importStats.newCount > 0">
        <p>{{ $t('Are you sure you want to continue?') }}</p>
        <p>{{ $t('You are importing {count} records:', { count: importStats.total }) }}</p>
        <ul class="list-disc ps-5 space-y-1">
          <li>{{ $t('{count} existing records will be replaced (old records will be lost)', { count: importStats.existingCount }) }}</li>
          <li>{{ $t('{count} new records will be added', { count: importStats.newCount }) }}</li>
        </ul>
        <p>{{ $t('What would you like to do?') }}</p>
      </template>

      <template v-if="importStats.existingCount === 0 && importStats.newCount > 0">
        <p>{{ $t('Are you sure you want to import the new records?') }}</p>
        <p>{{ $t('You are about to import {count} new records.', { count: importStats.newCount }) }}</p>
        <p>{{ $t('Would you like to proceed?') }}</p>
      </template>

      <template v-if="importStats.existingCount > 0 && importStats.newCount === 0">
        <p>{{ $t('Warning! All {count} records already exist in the system.', { count: importStats.existingCount }) }}</p>
        <p>{{ $t('Importing these will replace the existing records, which cannot be undone.') }}</p>
        <p>{{ $t('Would you like to proceed?') }}</p>
      </template>
    </div>
  </Dialog>

  <!-- declared after the dialog so the progress overlay stays above it -->
  <Modal v-model:open="checkProgress" :closeByClickOutside="false" :closeByEsc="false">
    <div class="flex items-center gap-3 px-5 py-4 text-sm">
      <Spinner class="w-5 h-5" />
      {{ $t('Checking data...') }}
    </div>
  </Modal>
  <Modal v-model:open="importProgress" :closeByClickOutside="false" :closeByEsc="false">
    <div class="flex items-center gap-3 px-5 py-4 text-sm">
      <Spinner class="w-5 h-5" />
      {{ $t('Importing...') }}
    </div>
  </Modal>
</template>

<script setup lang="ts">
import { ref, Ref, computed, watch } from 'vue';
import { callAdminForthApi } from '@/utils';
import adminforth from '@/adminforth';
import Papa from 'papaparse';
import { Dialog, Modal, Spinner } from '@/afcl';
import { IconUpload } from '@iconify-prerendered/vue-lucide';
import { useI18n } from 'vue-i18n';


const { t } = useI18n();
defineExpose({
  click,
});

const importProgress: Ref<boolean> = ref(false);
const checkProgress: Ref<boolean> = ref(false);
const confirmDialog = ref(null);
const importStats = ref(null);
const pendingData = ref<Record<string, unknown[]> | null>(null);
const props = defineProps({
  meta: Object,
  record: Object,
});
const fileFormat = props.meta?.fileFormat === 'xlsx' ? 'xlsx' : 'csv';
// secondary actions first, the main (or destructive) action is the rightmost button
const computedButtons = computed(() => {
  if (!importStats.value) return [];
  const { existingCount, newCount } = importStats.value;

  const buttons = [
    { label: t('Cancel'), options: { variant: 'secondary' }, onclick: (dialog) => dialog.hide() },
    { label: t('Import New Only'), options: { variant: 'secondary' }, onclick: (dialog) => { confirmImportNewOnly(dialog) }, visible: existingCount > 0 && newCount > 0 },
    { label: t('⚠️ Import All — Replace & Overwrite'), options: { variant: 'danger' }, onclick: (dialog) => { confirmImport(dialog) }, visible: existingCount > 0 && newCount > 0 },
    { label: t('⚠️ Replace Existing Records'), options: { variant: 'danger' }, onclick: (dialog) => { confirmImport(dialog) }, visible: existingCount > 0 && newCount === 0 },
    { label: t('Import Records'), onclick: (dialog) => { confirmImportNewOnly(dialog) }, visible: existingCount === 0 && newCount > 0 },
  ];

  return buttons.filter(button => button.visible !== false);
});
async function confirmImport(dialog) {
  await postData(pendingData.value);
  dialog.hide();
}

async function checkRecords(data: Record<string, unknown[]>) {
  checkProgress.value = true;
  const resp = await callAdminForthApi({
    path: `/plugin/${props.meta.pluginInstanceId}/check-records`,
    method: 'POST',
    body: { data }
  });
  checkProgress.value = false;
  return resp;
}

async function confirmImportNewOnly(dialog) {
  await postDataNewOnly(pendingData.value);
  dialog.hide();
}

async function postData(data: Record<string, unknown[]>) {
  importProgress.value = true;
  const resp = await callAdminForthApi({
    path: `/plugin/${props.meta.pluginInstanceId}/import-csv`,
    method: 'POST',
    body: { data }
  });

  importProgress.value = false;

  if (resp.importedCount > 0 || resp.updatedCount > 0) {
    adminforth.list.refresh();
  }
  adminforth.alert({
    message: `Imported ${resp.importedCount || 0} records. Updated ${resp.updatedCount || 0} records. ${resp.errors?.length ? `First error: ${resp.errors[0]}` : ''}`,
    variant: resp.errors?.length ? (
      resp.importedCount ? 'warning' : 'danger'
    ) : 'success'
  });

  adminforth.list.closeThreeDotsDropdown();
}

async function postDataNewOnly(data: Record<string, unknown[]>) {
  importProgress.value = true;
  const resp = await callAdminForthApi({
    path: `/plugin/${props.meta.pluginInstanceId}/import-csv-new-only`,
    method: 'POST',
    body: { data }
  });

  importProgress.value = false;
  if (resp.importedCount > 0) {
    adminforth.list.refresh();
  }
  adminforth.alert({
    message: `Imported ${resp.importedCount || 0} records. ${resp.errors?.length ? `First error: ${resp.errors[0]}` : ''}`,
    variant: resp.errors?.length ? 'warning' : 'success'
  });

  adminforth.list.closeThreeDotsDropdown();
}

async function prepareImport(rows: Record<string, unknown>[], formatLabel: string) {
  if (rows.length === 0) {
    throw new Error(`No data rows found in ${formatLabel}`);
  }

  const data: Record<string, unknown[]> = {};
  Object.keys(rows[0]).forEach(column => {
    data[column] = rows.map(row => row[column]);
  });

  pendingData.value = data;
  importStats.value = await checkRecords(data);
  confirmDialog.value?.open();
}

async function parseCsv(file: File) {
  const results = Papa.parse<Record<string, string>>(await file.text(), {
    header: true,
    skipEmptyLines: true,
    // Do not enable dynamicTyping: values such as string IDs must remain strings.
  });

  if (results.errors.length > 0) {
    const firstError = results.errors[0];
    const row = typeof firstError.row === 'number' ? firstError.row + 1 : '?';
    throw new Error(`CSV parsing error at row ${row}: ${firstError.message || 'Unknown error'}`);
  }

  await prepareImport(results.data, 'CSV');
}

async function parseXlsx(file: File) {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(await file.arrayBuffer(), {
    type: 'array',
    cellDates: true,
  });
  if (workbook.SheetNames.length === 0) {
    throw new Error('No worksheets found in Excel file');
  }

  const allRows: Record<string, unknown>[] = [];
  let expectedColumns: string[] | undefined;
  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
      workbook.Sheets[sheetName],
      { defval: '', raw: true },
    );
    if (rows.length === 0) {
      continue;
    }
    const columns = Object.keys(rows[0]);
    if (expectedColumns && columns.join('\0') !== expectedColumns.join('\0')) {
      throw new Error(`Worksheet '${sheetName}' has different columns`);
    }
    expectedColumns = columns;
    rows.forEach(row => allRows.push(row));
  }
  await prepareImport(allRows, 'Excel file');
}

async function importFile() {
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = fileFormat === 'xlsx' ? '.xlsx' : '.csv';
  fileInput.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) {
      return;
    }
    try {
      const expectedExtension = `.${fileFormat}`;
      if (!file.name.toLowerCase().endsWith(expectedExtension)) {
        throw new Error(`Unsupported file type. Select a ${expectedExtension} file.`);
      }
      if (fileFormat === 'xlsx') {
        await parseXlsx(file);
      } else {
        await parseCsv(file);
      }
    } catch (error) {
      adminforth.alert({
        message: error instanceof Error ? error.message : 'Failed to process import file',
        variant: 'danger',
      });
    }
  };
  fileInput.click();
}


function click() {
  importFile();
}
</script>
