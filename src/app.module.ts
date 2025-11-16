import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { validateEnv } from "@/config/env.config";
import { PrismaModule } from "@/shared/prisma/prisma.module";
import { EvaluationModule } from "./evaluation/evaluation.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      envFilePath: [".env"],
    }),
    EvaluationModule,
    PrismaModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
