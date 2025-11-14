import { z } from "zod";

export const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  OLLAMA_HOST: z.string(),
  OLLAMA_MODEL: z.string(),
});

export type Env = z.infer<typeof envSchema>;

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
export const validateEnv: (config: Record<string, unknown>) => any = (
  config: Record<string, unknown>,
) => {
  return envSchema.parse(config);
};
