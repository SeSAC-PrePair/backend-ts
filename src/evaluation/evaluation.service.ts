import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GenerateResponse, Ollama } from "ollama";
import { Env } from "@/config/env.config";

@Injectable()
export class EvaluationService {
  constructor(
    private readonly ollama: Ollama,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  async ollamaResponseTest() {
    try {
      const response: GenerateResponse = await this.ollama.generate({
        model: `${this.configService.get("OLLAMA_MODEL", { infer: true })}`,
        prompt: "테스트",
        stream: false,
      });

      return response;
    } catch (e) {
      console.error("Error: ", e);
    }
  }
}
