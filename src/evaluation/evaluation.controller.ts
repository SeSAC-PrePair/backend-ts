import { Body, Controller, Patch, Post } from "@nestjs/common";
import type { FeedbackRequestDto } from "@/evaluation/dto/feedback-request.dto";
import { EvaluationService } from "@/evaluation/evaluation.service";

@Controller("api/evaluation")
export class EvaluationController {
  constructor(private readonly evaluationService: EvaluationService) {}

  @Patch("feedback")
  async feedback(@Body() feedbackRequestDto: FeedbackRequestDto) {
    return await this.evaluationService.updateFeedback(feedbackRequestDto);
  }

  @Post("feedback")
  async feedbackRegeneration(@Body() feedbackRequestDto: FeedbackRequestDto) {
    return await this.evaluationService.createFeedback(feedbackRequestDto);
  }
}
