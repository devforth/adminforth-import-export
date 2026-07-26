<template>
  <div class="flex flex-col gap-3 w-full">
    <div class="flex items-center justify-between gap-4 text-sm text-gray-700 dark:text-gray-200">
      <span>
        {{ $t('Exported rows') }}:
        <span class="font-semibold">{{ exportedRows.toLocaleString() }}</span>
        <template v-if="totalRows">
          / {{ totalRows.toLocaleString() }}
        </template>
      </span>
      <span v-if="fileName" class="truncate text-xs text-gray-500 dark:text-gray-400" :title="fileName">
        {{ fileName }}
      </span>
    </div>

    <p v-if="job.status === 'CANCELLED'" class="text-sm text-gray-500 dark:text-gray-400">
      {{ $t('Export was cancelled, the file was not saved.') }}
    </p>
    <p v-else-if="job.state?.error" class="text-sm text-red-600 dark:text-red-400">
      {{ job.state.error }}
    </p>

    <Button
      v-if="fileReady && job.status !== 'CANCELLED'"
      class="w-fit mx-auto my-2"
      :loader="downloading"
      @click="download"
    >
      {{ $t('Download CSV') }}
    </Button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { Button } from '@/afcl';
import { callAdminForthApi } from '@/utils';
import adminforth from '@/adminforth';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const props = defineProps<{
  job: {
    id: string;
    status: string;
    state?: Record<string, any>;
  };
  meta: Record<string, any>;
  subscribeToJobStateFields: (fieldNames: string[]) => () => void;
  subscribeToJobTaskFields: (taskNames: string[], fieldNames: string[]) => () => void;
  getJobTasks: () => Promise<Record<string, any>[]>;

}>();

const downloading = ref(false);
let unsubscribe: (() => void) | undefined;

// component declaration is passed as `meta`, plugin meta sits one level deeper
const pluginInstanceId = computed(() => props.meta?.meta?.pluginInstanceId ?? props.meta?.pluginInstanceId);

const exportedRows = computed(() => props.job.state?.exportedRows ?? 0);
const totalRows = computed(() => props.job.state?.totalRows ?? 0);
const fileName = computed(() => props.job.state?.fileName ?? '');
const fileReady = computed(() => !!props.job.state?.fileReady);

async function download() {
  downloading.value = true;
  try {
    const res = await callAdminForthApi({
      path: `/plugin/${pluginInstanceId.value}/export-job-download-url`,
      method: 'POST',
      body: { jobId: props.job.id },
    });
    if (!res?.ok) {
      throw new Error(res?.error || t('Failed to get download link'));
    }
    const link = document.createElement('a');
    link.href = res.url;
    link.download = res.fileName || 'export.csv';
    link.rel = 'noopener';
    link.click();
  } catch (e) {
    adminforth.alert({
      message: e instanceof Error ? e.message : t('Failed to get download link'),
      variant: 'danger',
    });
  } finally {
    downloading.value = false;
  }
}

onMounted(() => {
  unsubscribe = props.subscribeToJobStateFields(['exportedRows', 'totalRows', 'fileReady', 'fileName']);
});

onBeforeUnmount(() => {
  unsubscribe?.();
});
</script>
