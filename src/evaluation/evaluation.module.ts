import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Ollama } from "ollama";
import { Env } from "@/config/env.config";
import { EvaluationController } from "./evaluation.controller";
import { EvaluationService } from "./evaluation.service";

@Module({
  providers: [
    {
      provide: Ollama,
      useFactory: (configService: ConfigService<Env, true>) => {
        const host: string = configService.get("OLLAMA_HOST", { infer: true });
        return new Ollama({ host });
      },
      inject: [ConfigService],
    },
    EvaluationService,
  ],
  controllers: [EvaluationController],
})
export class EvaluationModule {}
