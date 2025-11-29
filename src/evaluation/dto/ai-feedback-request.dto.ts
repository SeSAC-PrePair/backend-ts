import { PickType } from "@nestjs/mapped-types";
import { FeedbackRequestDto } from "@/evaluation/dto/feedback-request.dto";

export class AiFeedbackRequestDto extends PickType(FeedbackRequestDto, [
  "question",
] as const) {}
