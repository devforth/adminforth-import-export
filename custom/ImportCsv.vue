<template>
    <div @click="importCsv"  class="cursor-pointer flex gap-2 items-center">
      {{$t('Import from CSV')}}

      <svg v-if="inProgress"
        aria-hidden="true" class="w-4 h-4 text-gray-200 animate-spin dark:text-gray-600 fill-blue-600" viewBox="0 0 100 101" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M100 50.5908C100 78.2051 77.6142 100.591 50 100.591C22.3858 100.591 0 78.2051 0 50.5908C0 22.9766 22.3858 0.59082 50 0.59082C77.6142 0.59082 100 22.9766 100 50.5908ZM9.08144 50.5908C9.08144 73.1895 27.4013 91.5094 50 91.5094C72.5987 91.5094 90.9186 73.1895 90.9186 50.5908C90.9186 27.9921 72.5987 9.67226 50 9.67226C27.4013 9.67226 9.08144 27.9921 9.08144 50.5908Z" fill="currentColor"/><path d="M93.9676 39.0409C96.393 38.4038 97.8624 35.9116 97.0079 33.5539C95.2932 28.8227 92.871 24.3692 89.8167 20.348C85.8452 15.1192 80.8826 10.7238 75.2124 7.41289C69.5422 4.10194 63.2754 1.94025 56.7698 1.05124C51.7666 0.367541 46.6976 0.446843 41.7345 1.27873C39.2613 1.69328 37.813 4.19778 38.4501 6.62326C39.0873 9.04874 41.5694 10.4717 44.0505 10.1071C47.8511 9.54855 51.7191 9.52689 55.5402 10.0491C60.8642 10.7766 65.9928 12.5457 70.6331 15.2552C75.2735 17.9648 79.3347 21.5619 82.5849 25.841C84.9175 28.9121 86.7997 32.2913 88.1811 35.8758C89.083 38.2158 91.5421 39.6781 93.9676 39.0409Z" fill="currentFill"/></svg>
    </div>
    <Dialog ref="confirmDialog" :header="t('Import Confirmation')" :buttons="computedButtons">
    <div v-if="importStats">
      <template v-if="importStats.existingCount > 0 && importStats.newCount > 0">
        <p>{{ $t('Are you sure you want to continue?') }}</p>
        <p class="mt-2">{{ $t('You are importing {count} records:', { count: importStats.total }) }}</p>
        <ul class="list-disc ml-6 mt-2">
          <li>{{ $t('{count} existing records will be replaced (old records will be lost)', { count: importStats.existingCount }) }}</li>
          <li>{{ $t('{count} new records will be added', { count: importStats.newCount }) }}</li>
        </ul>
        <p>{{ $t('What would you like to do?') }}</p>
      </template>

      <template v-if="importStats.existingCount === 0 && importStats.newCount > 0">
        <p>{{ $t('Are you sure you want to import the new records?') }}</p>
        <p class="mt-2">{{ $t('You are about to import {count} new records.', { count: importStats.newCount }) }}</p>
        <p>{{ $t('Would you like to proceed?') }}</p>
      </template>

      <template v-if="importStats.existingCount > 0 && importStats.newCount === 0">
        <p>{{ $t('Warning! All {count} records already exist in the system.', { count: importStats.existingCount }) }}</p>
        <p>{{ $t('Importing these will replace the existing records, which cannot be undone.') }}</p>
        <p>{{ $t('Would you like to proceed?') }}</p>
      </template>
    </div>
</Dialog>
</template>

<script setup lang="ts">
import { ref, Ref, computed } from 'vue';
import { callAdminForthApi } from '@/utils';
import adminforth from '@/adminforth';
import Papa from 'papaparse';
import { Dialog } from '@/afcl';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const inProgress: Ref<boolean> = ref(false);
const confirmDialog = ref(null);
const importStats = ref(null);
const pendingData = ref(null);
const props = defineProps({
  meta: Object,
  record: Object,
});
const computedButtons = computed(() => {
  if (!importStats.value) return [];

  const buttons = [
    { label: t('⚠️ Import All — Replace & Overwrite'), onclick: (dialog) => { confirmImport(dialog) }, visible: importStats.value.existingCount > 0 && importStats.value.newCount > 0 },
    { label: t('⚠️ Replace Existing Records'), onclick: (dialog) => { confirmImport(dialog) }, visible: importStats.value.existingCount > 0 && importStats.value.newCount === 0 },
    { label: t('➕ Import New Only'), onclick: (dialog) => { confirmImportNewOnly(dialog) }, visible: importStats.value.existingCount > 0 && importStats.value.newCount > 0 },
    { label: t('➕ Import Records'), onclick: (dialog) => { confirmImportNewOnly(dialog) }, visible: importStats.value.existingCount === 0 && importStats.value.newCount > 0 },
    { label: t('✖ Cancel'), onclick: (dialog) => dialog.hide() }
  ];

  return buttons.filter(button => button.visible !== false);
});
async function confirmImport(dialog) {
  dialog.hide();
  await postData(pendingData.value);
}

async function checkRecords(data: Record<string, string[]>) {
  const resp = await callAdminForthApi({
    path: `/plugin/${props.meta.pluginInstanceId}/check-records`,
    method: 'POST',
    body: { data }
  });

  return resp;
}

async function confirmImportNewOnly(dialog) {
  dialog.hide();
  await postDataNewOnly(pendingData.value);
}

async function postData(data: Record<string, string[]>, skipDuplicates: boolean = false) {
  const resp = await callAdminForthApi({
    path: `/plugin/${props.meta.pluginInstanceId}/import-csv`,
    method: 'POST',
    body: { data }
  });

  inProgress.value = false;

  if (resp.importedCount > 0 || resp.updatedCount > 0) {
    adminforth.list.refresh();
  }
  adminforth.alert({
    message: `Imported ${resp.importedCount || 0} records. Updated ${resp.updatedCount || 0} records. ${resp.errors?.length ? `Errors: ${resp.errors.join(', ')}` : ''}`,
    variant: resp.errors?.length ? (
      resp.importedCount ? 'warning' : 'danger'
    ) : 'success'
  });

  adminforth.list.closeThreeDotsDropdown();
}

async function postDataNewOnly(data: Record<string, string[]>) {
  const resp = await callAdminForthApi({
    path: `/plugin/${props.meta.pluginInstanceId}/import-csv-new-only`,
    method: 'POST',
    body: { data }
  });

  inProgress.value = false;
  if (resp.importedCount > 0) {
    adminforth.list.refresh();
  }
  adminforth.alert({
    message: `Imported ${resp.importedCount || 0} records. ${resp.errors?.length ? `Errors: ${resp.errors.join(', ')}` : ''}`,
    variant: resp.errors?.length ? 'warning' : 'success'
  });

  adminforth.list.closeThreeDotsDropdown();
}

async function importCsv() {
  inProgress.value = false;
  const fileInput = document.createElement('input');

  fileInput.type = 'file';
  fileInput.accept = '.csv';
  fileInput.click();
  fileInput.onchange = async (e) => {
    inProgress.value = true;

    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) {
      inProgress.value = false;
      return;
    }
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const text = e.target.result as string;
        
        Papa.parse(text, {
          header: true,
          skipEmptyLines: true,

          complete: async (results) => {
            if (results.errors.length > 0) {
              adminforth.alert({
                message: `CSV parsing errors: ${results.errors[0]?.message || 'Unknown error'}`,
                variant: 'danger'
              });
              throw new Error(`CSV parsing errors: ${results.errors.map(e => e.message).join(', ')}`);
            }
            const data: Record<string, string[]> = {};
            const rows = results.data as Record<string, string>[];
            
            if (rows.length === 0) {
              adminforth.alert({
                message: `No data rows found in CSV`,
                variant: 'danger'
              });
              throw new Error('No data rows found in CSV');
            }
            Object.keys(rows[0]).forEach(column => {
              data[column] = rows.map(row => row[column]);
            });

            // Store data for later use
            pendingData.value = data;

            // Check records and show confirmation
            const stats = await checkRecords(data);
            importStats.value = stats;
            confirmDialog.value?.open();
            inProgress.value = false;
          },
          error: (error) => {
            adminforth.alert({
                message: `CSV parsing errors: ${results.errors[0]?.message || 'Unknown error'}`,
                variant: 'danger'
            });
            throw new Error(`Failed to parse CSV: ${error.message}`);
          }
        });
      } catch (error) {
        inProgress.value = false;
        adminforth.alert({
          message: `Error processing CSV: ${error.message}`,
          variant: 'danger'
        });
      }
    };
    reader.readAsText(file);
  };
}
</script>