import  {type PluginsCommonOptions, StorageAdapter } from "adminforth";

export interface PluginOptions extends PluginsCommonOptions {
  /**
   * classicalUploadLimitMiB applied only to classical export. Switch to upload export to enable exporting high volumes of data
   * Before reading the whole dataset into RAM, a probe of the first records is fetched and their
   * serialized size is multiplied by the total count. If the estimate exceeds this limit, the export
   * is rejected instead of taking the server down. Note that the estimate is approximate: it measures
   * the serialized payload, while the same rows kept as JS objects take a few times more RAM.
   */
  classicalUploadLimitMiB?: number;

  /**
   * If you are going to export a huge dataset - it can make your server run out of memory, because all exported records are stored in RAM
   * To prevent this, you can use exportViaUpload option.
   * It requires a background jobs plugin to be setted up
   */
  exportViaUpload?: {
    /**
     * Size of the buffer, where records will be stored before upload. Min size is 5 MB. The default value is 5 MB. (takes RAM memory on the server)
     * AWS S3 doesn't support more that 10000 parts per upload, so if you have a huge database you want to export (for default settings more that 100 Gb) - increase buffer size
     */
    bufferSizeMb?: number;

    /**
     * How many records are pulled from the database per iteration. The default value is 100.
     * Bigger values make the export faster but take more RAM on the server, smaller values do the opposite.
     */
    readChunkSize?: number;

    storageAdapter: StorageAdapter;
  }
}