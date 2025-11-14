import { Controller, Get } from "@nestjs/common";
import { EvaluationService } from "@/evaluation/evaluation.service";

@Controller("api/evaluation")
export class EvaluationController {
  constructor(private readonly evaluationService: EvaluationService) {}

  @Get()
  async ollamaResponseTest() {
    return this.evaluationService.ollamaResponseTest();
  }
}
