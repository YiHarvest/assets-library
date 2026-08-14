import { Global, Module } from "@nestjs/common";
import { ZosService } from "./zos.service";

@Global()
@Module({ providers: [ZosService], exports: [ZosService] })
export class ZosModule {}
