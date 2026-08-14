import { Module } from "@nestjs/common";
import { AssetsController } from "./modules/assets/assets.controller";
import { HealthController } from "./modules/health/health.controller";
import { StorageController } from "./modules/storage/storage.controller";
import { TasksController } from "./modules/tasks/tasks.controller";
import { TemporaryFilesController } from "./modules/temporary-files/temporary-files.controller";
import { UploadsController } from "./modules/uploads/uploads.controller";
import { DatabaseModule } from "./database/database.module";
import { ZosModule } from "./storage/storage.module";
import { ServicesModule } from "./services/services.module";
import { HealthService } from "./modules/health/health.service";
import { ObservabilityController } from "./modules/observability/observability.controller";

@Module({
  imports: [DatabaseModule, ZosModule, ServicesModule],
  controllers: [
    HealthController,
    TemporaryFilesController,
    UploadsController,
    TasksController,
    AssetsController,
    StorageController,
    ObservabilityController,
  ],
  providers: [HealthService],
})
export class AppModule {}
