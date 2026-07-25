import  {type PluginsCommonOptions, StorageAdapter } from "adminforth";

export interface PluginOptions extends PluginsCommonOptions {
  /**
   * If you are going to export a huge dataset - it can make your server run out of memory, because all exported records are stored in RAM
   * To prevent this, you can use exportBigDataset option.
   * It requires a background jobs plugin to be setted up
   */
  exportBigDataset?: {
    /**
     * Size of the buffer, where records will be stored before upload. Min size is 5 MB. The default value is 10 MB. (takes RAM memory on the server)
     * AWS S3 doesn't support more that 10000 parts per upload, so if you have a huge database you want to export (for default settings more that 100 Gb) - increase buffer size
     */
    bufferSizeMb?: number;

    storageAdapter: StorageAdapter;

    /**
     * Limit of parallel exports. Default value is 5. If you have a huge dataset to export, you can increase this value to speed up the export process.
     * But be careful, because it will take more RAM memory on the server.
     */
    parallelExportsLimit?: number;
  }
}