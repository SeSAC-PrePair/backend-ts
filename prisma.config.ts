import { config } from "dotenv";
import { defineConfig, env } from "prisma/config";

// .env 파일 로드
config();

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  engine: "classic",
  datasource: {
    url: env("DATABASE_URL"),
  },
});
