import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { AiFeedbackRequestDto } from "@/evaluation/dto/ai-feedback-request.dto";
import { FeedbackRequestDto } from "@/evaluation/dto/feedback-request.dto";
import { EvaluationService } from "@/evaluation/evaluation.service";

@Controller("api/evaluation")
export class EvaluationController {
  constructor(private readonly evaluationService: EvaluationService) {}

  @Patch("feedback/:historyId")
  async feedback(
    @Body() feedbackRequestDto: FeedbackRequestDto,
    @Param("historyId") historyId: string,
  ) {
    return await this.evaluationService.updateFeedback(
      feedbackRequestDto,
      historyId,
    );
  }

  @Post("feedback/:historyId")
  async feedbackRegeneration(
    @Body() feedbackRequestDto: FeedbackRequestDto,
    @Param("historyId") historyId: string,
  ) {
    return await this.evaluationService.createFeedback(
      feedbackRequestDto,
      historyId,
    );
  }

  @Post("feedback")
  async aiFeedback(@Body() dto: AiFeedbackRequestDto) {
    return await this.evaluationService.aiFeedback(dto);
  }

  @Get("feedback/:userId")
  async meFeedback(@Param("userId") userId: string) {
    return await this.evaluationService.feedbackMe(userId);
  }
}
