import { Body, Controller, Param, Patch, Post } from "@nestjs/common";
import type { FeedbackRequestDto } from "@/evaluation/dto/feedback-request.dto";
import { EvaluationService } from "@/evaluation/evaluation.service";

@Controller("api/evaluation")
export class EvaluationController {
  constructor(private readonly evaluationService: EvaluationService) {}

  @Post("feedback")
  async feedback(@Body() feedbackRequestDto: FeedbackRequestDto) {
    return await this.evaluationService.feedback(feedbackRequestDto);
  }

  @Patch("feedback")
  async feedbackRegeneration(@Body() feedbackRequestDto: FeedbackRequestDto) {
    const result = await this.evaluationService.feedback(feedbackRequestDto);
    return this.evaluationService.feedbackRegeneration(
      result,
      feedbackRequestDto.questionId,
    );
  }
}
