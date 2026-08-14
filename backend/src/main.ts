import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { ApiExceptionFilter } from "./common/api-exception.filter";
import { AppModule } from "./app.module";
import { RequestLoggingInterceptor } from "./common/request-logging.interceptor";
import { corsAllowlist } from "./common/cors-policy";
import { configureHttpServerTimeouts } from "./common/http-server-policy";
import { trustLoopbackProxy } from "./common/proxy-trust-policy";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.getHttpAdapter().getInstance().set("trust proxy", trustLoopbackProxy);
  app.setGlobalPrefix("api/v1", {
    exclude: [{ path: "health", method: RequestMethod.GET }],
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new RequestLoggingInterceptor());
  app.enableCors({
    origin: corsAllowlist(process.env.FRONTEND_ORIGIN),
    credentials: false,
  });

  const config = new DocumentBuilder()
    .setTitle("素材中枢 API")
    .setDescription("图片、视频切片、任务、素材检索与 ZOS 媒体生命周期 API。")
    .setVersion("1.0.0")
    .build();
  const documentFactory = () => SwaggerModule.createDocument(app, config, {
    operationIdFactory: (controllerKey, methodKey) =>
      `${controllerKey.replace(/Controller$/, "")}_${methodKey}`,
  });
  SwaggerModule.setup("api/docs", app, documentFactory, {
    jsonDocumentUrl: "api/v1/openapi",
    yamlDocumentUrl: "api/v1/openapi.yaml",
    customSiteTitle: "素材中枢 API",
    swaggerOptions: {
      deepLinking: true,
      displayRequestDuration: true,
    },
  });

  const port = Number(process.env.BACKEND_PORT ?? 23017);
  const server = await app.listen(port, process.env.BACKEND_HOST ?? "127.0.0.1");
  configureHttpServerTimeouts(server);
}

void bootstrap().catch((error: unknown) => {
  // `nest start --watch` runs the application in a child process.  Surface
  // bootstrap failures explicitly so start.sh can show the real cause rather
  // than only reporting a later health-check timeout.
  console.error("NestJS 启动失败：", error);
  process.exitCode = 1;
});
