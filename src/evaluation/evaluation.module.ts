import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Ollama } from "ollama";
import OpenAI from "openai";
import { Env } from "@/config/env.config";
import { PrismaModule } from "@/shared/prisma/prisma.module";
import { EvaluationController } from "./evaluation.controller";
import { EvaluationService } from "./evaluation.service";

@Module({
  imports: [PrismaModule],
  providers: [
    {
      provide: Ollama,
      useFactory: (configService: ConfigService<Env, true>) => {
        const host: string = configService.get("OLLAMA_HOST", { infer: true });
        return new Ollama({ host });
      },
      inject: [ConfigService],
    },
    {
      provide: OpenAI,
      useFactory: (configService: ConfigService<Env, true>) => {
        return new OpenAI({
          baseURL: "https://openrouter.ai/api/v1",
          apiKey: configService.get("OPENROUTER_API_KEY", { infer: true }),
        });
      },
      inject: [ConfigService],
    },
    EvaluationService,
  ],
  controllers: [EvaluationController],
})
export class EvaluationModule {}
