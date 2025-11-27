import { IsNotEmpty, IsString } from "class-validator";

export class FeedbackRequestDto {
  @IsString()
  @IsNotEmpty()
  question: string;

  @IsString()
  @IsNotEmpty()
  answer: string;
}
