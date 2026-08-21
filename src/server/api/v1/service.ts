import type {
  ApiV1AssetDetail,
  AssetQuery,
  AssetQueryResponse,
  CreateUploadTask,
  MutationContext,
  TaskAccepted,
  TaskStatusResponse,
  UpdateAssetTask,
  UserMediaListQuery,
  UserMediaListResponse,
  UserScope,
  UserStorageUsageResponse,
} from "@/shared/contracts";
import { defaultApiV1Service } from "@/server/api/v1/default-service";
import type {
  ListTasksInput,
  TaskListResponse,
} from "@/server/modules/tasks/task-service";

export interface ReceiveUploadItemInput {
  taskId: string;
  itemId: string;
  body: ReadableStream<Uint8Array>;
  contentLength: number | null;
  contentType: string | null;
}

export interface ApiV1Service {
  createUploadTask(input: CreateUploadTask): Promise<TaskStatusResponse>;
  receiveUploadItem(input: ReceiveUploadItemInput): Promise<TaskStatusResponse>;
  sealUploadTask(taskId: string): Promise<TaskStatusResponse>;
  getTask(taskId: string, expectedUserId?: string): Promise<TaskStatusResponse>;
  listTasks(userId: string, input: ListTasksInput): Promise<TaskListResponse>;
  queryAssets(input: AssetQuery): Promise<AssetQueryResponse>;
  getUserStorageUsage(userId: string): Promise<UserStorageUsageResponse>;
  listUserMedia(
    userId: string,
    input: UserMediaListQuery,
    origin: string,
  ): Promise<UserMediaListResponse>;
  getAsset(assetId: string, scope: UserScope): Promise<ApiV1AssetDetail>;
  listUsers(): Promise<
    Array<{
      user_id: string;
      display_name: string | null;
      email: string | null;
      department: string | null;
      first_seen_at: string;
      last_seen_at: string;
      asset_count: number;
    }>
  >;
  updateAsset(assetId: string, input: UpdateAssetTask): Promise<TaskAccepted>;
  publishAsset(assetId: string, input: MutationContext): Promise<TaskAccepted>;
  retryAsset(assetId: string, input: MutationContext): Promise<TaskAccepted>;
  deleteAsset(assetId: string, input: MutationContext): Promise<TaskAccepted>;
  getMedia(assetId: string, scope: UserScope, request: Request): Promise<Response>;
  getThumbnail(
    assetId: string,
    scope: UserScope,
    request: Request,
  ): Promise<Response>;
}

let installedService: ApiV1Service | undefined;

export function installApiV1Service(service: ApiV1Service | undefined) {
  installedService = service;
}

export function getApiV1Service() {
  return installedService ?? defaultApiV1Service;
}
