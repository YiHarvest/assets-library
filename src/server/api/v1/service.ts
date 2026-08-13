import type {
  AssetAction,
  AssetList,
  ApiV1AssetDetail,
  AssetQuery,
  AssetQueryResponse,
  TaskAccepted,
  TaskStatusResponse,
  UpdateAssetTask,
  UserMediaListResponse,
  UserStorageUsageResponse,
  MediaType,
} from "@/shared/contracts";
import { defaultApiV1Service } from "@/server/api/v1/default-service";

export interface StagedUploadFile {
  id: string;
  ordinal: number;
  filename: string;
  mediaType: MediaType;
  contentType: string;
  sizeBytes: number;
  stagingPath: string;
}

export interface StagedUpload {
  taskId: string;
  user_id: string | null;
  callback_url: string | null;
  auto_publish: boolean;
  files: StagedUploadFile[];
}

export interface ApiV1Service {
  submitUpload(input: StagedUpload): Promise<TaskStatusResponse>;
  getTask(taskId: string): Promise<TaskStatusResponse>;
  listAssets(input: AssetList, origin: string): Promise<UserMediaListResponse>;
  searchAssets(input: AssetQuery): Promise<AssetQueryResponse>;
  getAsset(assetId: string): Promise<ApiV1AssetDetail>;
  updateAsset(input: UpdateAssetTask): Promise<TaskAccepted>;
  actOnAsset(input: AssetAction): Promise<TaskAccepted>;
  getStorageUsage(userId: string | null): Promise<UserStorageUsageResponse>;
  getMedia(assetId: string, request: Request): Promise<Response>;
  getThumbnail(assetId: string, request: Request): Promise<Response>;
}

let installedService: ApiV1Service | undefined;

export function installApiV1Service(service: ApiV1Service | undefined) {
  installedService = service;
}

export function getApiV1Service() {
  return installedService ?? defaultApiV1Service;
}
