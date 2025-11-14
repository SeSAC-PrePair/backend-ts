import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { validateEnv } from "@/config/env.config";
import { EvaluationModule } from "./evaluation/evaluation.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      envFilePath: [".env"],
    }),
    EvaluationModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
