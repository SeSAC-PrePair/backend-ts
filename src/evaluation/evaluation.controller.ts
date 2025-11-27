import {
  Body,
  Controller,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from "@nestjs/common";
import type { FeedbackRequestDto } from "@/evaluation/dto/feedback-request.dto";
import { EvaluationService } from "@/evaluation/evaluation.service";

@Controller("api/evaluation")
export class EvaluationController {
  constructor(private readonly evaluationService: EvaluationService) {}

  @Patch("feedback/:questionId")
  async feedback(
    @Body() feedbackRequestDto: FeedbackRequestDto,
    @Param("questionId", new ParseIntPipe()) questionId: number,
  ) {
    return await this.evaluationService.updateFeedback(
      feedbackRequestDto,
      questionId,
    );
  }

  @Post("feedback/:questionId")
  async feedbackRegeneration(
    @Body() feedbackRequestDto: FeedbackRequestDto,
    @Param("questionId", new ParseIntPipe()) questionId: number,
  ) {
    return await this.evaluationService.createFeedback(
      feedbackRequestDto,
      questionId,
    );
  }
}
