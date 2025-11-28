import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "@/app.module";
import { Env } from "@/config/env.config";

async function bootstrap() {
  const app: INestApplication = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService<Env, true>);
  const port: number = configService.get("PORT", { infer: true });
  const feDomain: string = configService.get("FE_DOMAIN", { infer: true });
  const prepairDomain: string = configService.get("PREPAIR_DOMAIN", {
    infer: true,
  });

  app.enableCors({
    origin: [feDomain, prepairDomain],
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(port);
}

bootstrap();
