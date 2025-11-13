import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "@/app.module";
import { Env } from "@/config/env.config";

async function bootstrap() {
  const app: INestApplication = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService<Env, true>);
  const port: number = configService.get("PORT", { infer: true });

  await app.listen(port);
}

bootstrap();
