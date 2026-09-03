import type {
  ApiV1Service,
  ReceiveUploadItemInput,
} from "@/server/api/v1/service";
import { loadConfig } from "@/server/config";
import * as mediaResponses from "@/server/media/response";
import { AssetService } from "@/server/modules/assets/asset-service";
import { MediaService } from "@/server/modules/media/media-service";
import { TaskService } from "@/server/modules/tasks/task-service";
import { UploadService } from "@/server/modules/uploads/upload-service";
import { UserService } from "@/server/modules/users/user-service";
import * as assetRepository from "@/server/repositories/assets";
import { createCompatibilityMatchTask } from "@/server/services/compatibility-match";
import type {
  AssetQuery,
  CompatibilityMatchRequest,
  CreateUploadTask,
  MutationContext,
  UpdateAssetTask,
  UserMediaListQuery,
  UserScope,
} from "@/shared/contracts";

export interface ApiV1DomainServices {
  assets: Pick<
    AssetService,
    | "deleteAsset"
    | "getAsset"
    | "publishAsset"
    | "queryAssets"
    | "retryAsset"
    | "updateAsset"
  >;
  media: Pick<MediaService, "getMedia" | "getThumbnail">;
  tasks: Pick<TaskService, "getTask" | "listTasks">;
  uploads: Pick<
    UploadService,
    "createUploadTask" | "receiveUploadItem" | "sealUploadTask"
  >;
  users: Pick<
    UserService,
    "getUserStorageUsage" | "listUserMedia" | "listUsers"
  >;
}

/** 显式组合根：所有领域服务及其基础设施依赖只在这里装配。 */
export function createApiV1DomainServices(): ApiV1DomainServices {
  const tasks = new TaskService({
    getTaskWithItems: assetRepository.getTaskWithItems,
    listTaskItemAssetIds: assetRepository.listTaskItemAssetIds,
    listUserTaskIds: assetRepository.listUserTaskIds,
  });
  return {
    tasks,
    uploads: new UploadService({
      config: loadConfig,
      repository: {
        acquireTaskItemUploadLease:
          assetRepository.acquireTaskItemUploadLease,
        createTaskWithItems: assetRepository.createTaskWithItems,
        releaseTaskItemUploadLease:
          assetRepository.releaseTaskItemUploadLease,
        sealTaskIfComplete: assetRepository.sealTaskIfComplete,
        updateTaskItemUploadProgress:
          assetRepository.updateTaskItemUploadProgress,
      },
      tasks,
    }),
    assets: new AssetService({
      config: loadConfig,
      repository: {
        createMutationTask: assetRepository.createMutationTask,
        getAssetDetail: assetRepository.getAssetDetail,
        getAssetRecord: assetRepository.getAssetRecord,
        queryAssetsPage: assetRepository.queryAssetsPage,
      },
      tasks,
    }),
    users: new UserService({
      listUserMediaPage: assetRepository.listUserMediaPage,
      listRegisteredUsers: assetRepository.listRegisteredUsers,
      summarizeUserStorage: assetRepository.summarizeUserStorage,
    }),
    media: new MediaService({
      repository: { getAssetDetail: assetRepository.getAssetDetail },
      responses: {
        mediaResponse: mediaResponses.mediaResponse,
        thumbnailResponse: mediaResponses.thumbnailResponse,
      },
    }),
  };
}

/** 稳定的 API v1 facade。路由只依赖此接口，领域实现可独立注入和测试。 */
export class DefaultApiV1Service implements ApiV1Service {
  constructor(
    private readonly services: ApiV1DomainServices =
      createApiV1DomainServices(),
  ) {}

  createCompatibilityMatchTask(
    input: CompatibilityMatchRequest,
    publicOrigin: string,
  ) {
    return createCompatibilityMatchTask(input, publicOrigin);
  }

  createUploadTask(input: CreateUploadTask) {
    return this.services.uploads.createUploadTask(input);
  }

  receiveUploadItem(input: ReceiveUploadItemInput) {
    return this.services.uploads.receiveUploadItem(input);
  }

  sealUploadTask(taskId: string) {
    return this.services.uploads.sealUploadTask(taskId);
  }

  getTask(taskId: string, expectedUserId?: string) {
    return this.services.tasks.getTask(taskId, expectedUserId);
  }

  listTasks(userId: string, input: Parameters<TaskService["listTasks"]>[1]) {
    return this.services.tasks.listTasks(userId, input);
  }

  queryAssets(input: AssetQuery) {
    return this.services.assets.queryAssets(input);
  }

  getUserStorageUsage(userId: string) {
    return this.services.users.getUserStorageUsage(userId);
  }

  listUserMedia(userId: string, input: UserMediaListQuery, origin: string) {
    return this.services.users.listUserMedia(userId, input, origin);
  }

  getAsset(assetId: string, scope: UserScope) {
    return this.services.assets.getAsset(assetId, scope);
  }

  listUsers() {
    return this.services.users.listUsers();
  }

  updateAsset(assetId: string, input: UpdateAssetTask) {
    return this.services.assets.updateAsset(assetId, input);
  }

  publishAsset(assetId: string, input: MutationContext) {
    return this.services.assets.publishAsset(assetId, input);
  }

  retryAsset(assetId: string, input: MutationContext) {
    return this.services.assets.retryAsset(assetId, input);
  }

  deleteAsset(assetId: string, input: MutationContext) {
    return this.services.assets.deleteAsset(assetId, input);
  }

  getMedia(assetId: string, scope: UserScope, request: Request) {
    return this.services.media.getMedia(assetId, scope, request);
  }

  getThumbnail(assetId: string, scope: UserScope, request: Request) {
    return this.services.media.getThumbnail(assetId, scope, request);
  }
}

export const defaultApiV1Service = new DefaultApiV1Service();
