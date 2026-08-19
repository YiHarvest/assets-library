import type { UserScope } from "@/shared/contracts";
import type * as AssetRepository from "@/server/repositories/assets";
import type * as MediaResponses from "@/server/media/response";
import { scopeForRepository } from "@/server/modules/assets/asset-service";

type MediaRepository = Pick<typeof AssetRepository, "getAssetDetail">;
type MediaResponseService = Pick<
  typeof MediaResponses,
  "mediaResponse" | "thumbnailResponse"
>;

export interface MediaServiceDependencies {
  repository: MediaRepository;
  responses: MediaResponseService;
}

export class MediaService {
  constructor(private readonly dependencies: MediaServiceDependencies) {}

  async getMedia(assetId: string, scope: UserScope, request: Request) {
    await this.dependencies.repository.getAssetDetail(
      assetId,
      scopeForRepository(scope),
    );
    return this.dependencies.responses.mediaResponse(assetId, request);
  }

  async getThumbnail(assetId: string, scope: UserScope, request: Request) {
    await this.dependencies.repository.getAssetDetail(
      assetId,
      scopeForRepository(scope),
    );
    return this.dependencies.responses.thumbnailResponse(assetId, request);
  }
}
