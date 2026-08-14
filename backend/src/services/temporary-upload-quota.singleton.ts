import { loadConfig } from "../config";
import { TemporaryUploadDiskQuota } from "./temporary-upload-disk-quota";

let quota: TemporaryUploadDiskQuota | undefined;

export function temporaryUploadQuota() {
  const config = loadConfig();
  quota ??= new TemporaryUploadDiskQuota({
    imageBytes: config.MAX_IMAGE_BYTES,
    videoBytes: config.MAX_VIDEO_BYTES,
    batchBytes: config.TEMP_UPLOAD_BATCH_MAX_BYTES,
    processBytes: config.TEMP_UPLOAD_DISK_QUOTA_BYTES,
    activeFiles: config.TEMP_UPLOAD_MAX_ACTIVE_FILES,
  });
  return quota;
}

export function releaseTemporaryUploadFile(filePath: string | undefined) {
  if (filePath) quota?.release(filePath);
}
