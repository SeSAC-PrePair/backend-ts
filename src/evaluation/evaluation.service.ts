import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { question_status } from "@prisma/client";
import { Ollama } from "ollama";
import { v4 as uuid } from "uuid";
import { Env } from "@/config/env.config";
import { AiFeedbackRequestDto } from "@/evaluation/dto/ai-feedback-request.dto";
import { FeedbackRequestDto } from "@/evaluation/dto/feedback-request.dto";
import { KOREAN_STOP_WORDS } from "@/shared/constants/korean-stop-words";
import { PrismaService } from "@/shared/prisma/prisma.service";

export interface AiFeedback {
  good: string;
  improvement: string;
  recommendation: string;
}

export interface FeedbackResult {
  score: number;
  feedback: AiFeedback | string;
  detectedIssues?: string[];
}

@Injectable()
export class EvaluationService {
  constructor(
    private readonly ollama: Ollama,
    private readonly configService: ConfigService<Env, true>,
    private readonly prismaService: PrismaService,
  ) {}

  /**
   * 점수와 피드백을 계산만 수행 (DB 저장 없음)
   */
  async calculateFeedback(
    feedbackRequestDto: FeedbackRequestDto,
  ): Promise<FeedbackResult> {
    const { question, answer } = feedbackRequestDto;

    const issues: string[] = [];

    if (answer.trim().length < 10) {
      return {
        score: 0,
        feedback: `답변이 너무 짧습니다. (최소 10글자 이상)`,
        detectedIssues: ["답변 길이 부족"],
      };
    }

    // 무의미한 답변 감지
    if (this.isMeaninglessAnswer(answer)) {
      return {
        score: 0,
        feedback:
          "무의미한 문자열이나 반복된 패턴만 입력되었습니다. 의미 있는 답변을 작성해주세요.",
        detectedIssues: ["무의미한 답변"],
      };
    }

    // 임베딩 생성
    const [questionEmbedding, answerEmbedding, referenceEmbedding] =
      await Promise.all([
        this.generateEmbedding(question),
        this.generateEmbedding(answer),
        this.generateReferenceEmbedding(question),
      ]);

    // 조기 주제 관련성 체크 - 무관한 답변은 0-5점 처리
    const topicSimilarity = this.cosineSimilarity(
      questionEmbedding,
      answerEmbedding,
    );

    if (topicSimilarity < 0.25) {
      // 완전히 무관한 주제
      const score =
        topicSimilarity < 0.15 ? 0 : Math.round(topicSimilarity * 20);
      return {
        score,
        feedback:
          "답변이 질문과 무관하거나 관련성이 매우 낮습니다. 질문을 다시 읽고 관련된 답변을 작성해주세요.",
        detectedIssues: ["질문과 무관한 답변"],
      };
    }

    // 임베딩 기반 의미적 유사도 계산
    const questionAnswerSimilarity = this.cosineSimilarity(
      questionEmbedding,
      answerEmbedding,
    );

    const referenceAnswerSimilarity = this.cosineSimilarity(
      referenceEmbedding,
      answerEmbedding,
    );

    // 질문에 대한 답변의 관련성 점수(0~25점)
    const relevanceScore: number = this.calculateRelevanceScore(
      question,
      answer,
      questionAnswerSimilarity,
    );

    // 의미적 유사도 점수 (0-40점)
    const semanticScore: number = this.calculateSemanticScore(
      questionAnswerSimilarity,
      referenceAnswerSimilarity,
    );

    // 품질 점수 (0-35점)
    const qualityScore = this.calculateQualityScore(answer, issues);

    // 7. 감점 요소 체크 (임베딩 재사용)
    const penalty = this.calculatePenalty(
      answer,
      questionEmbedding,
      answerEmbedding,
      issues,
    );

    // 8. 최종 점수 계산
    const rawScore = relevanceScore + semanticScore + qualityScore - penalty;
    let finalScore = Math.round(Math.max(0, Math.min(100, rawScore)));

    // 9. 답변 길이에 따른 점수 상한 적용 (더 엄격한 기준)
    const answerLength = answer.trim().length;
    if (answerLength < 50) {
      // 매우 짧은 답변: 최대 45점
      finalScore = Math.min(finalScore, 45);
      if (!issues.includes("답변이 다소 짧습니다")) {
        issues.push("답변이 매우 짧아 점수가 제한됩니다");
      }
    } else if (answerLength < 80) {
      // 짧은 답변: 최대 50점
      finalScore = Math.min(finalScore, 50);
    } else if (answerLength < 120) {
      // 다소 짧은 답변: 최대 60점
      finalScore = Math.min(finalScore, 60);
    } else if (answerLength < 150) {
      // 보통 길이: 최대 70점
      finalScore = Math.min(finalScore, 70);
    } else if (answerLength < 200) {
      // 충분한 길이: 최대 80점
      finalScore = Math.min(finalScore, 80);
    }
    // 200자 이상은 제한 없음

    // 10. 질문 복잡도에 따른 필수 키워드 체크 및 추가 감점
    const missingKeywordsPenalty = this.checkRequiredKeywords(
      question,
      answer,
      issues,
    );
    finalScore = Math.max(0, finalScore - missingKeywordsPenalty);

    // 11. LLM 이진 판단을 통한 답변 완성도 체크
    const isComplete = await this.checkAnswerCompleteness(question, answer);
    if (!isComplete) {
      finalScore = Math.max(0, finalScore - 20);
      issues.push("질문의 핵심 요구사항을 충족하지 못했습니다");
    }

    const feedback = await this.generateFeedback(question, answer);

    return {
      score: finalScore,
      feedback,
      detectedIssues: issues.length > 0 ? issues : undefined,
    };
  }

  async updateFeedback(
    feedbackRequestDto: FeedbackRequestDto,
    historyId: string,
  ) {
    const { question, answer } = feedbackRequestDto;

    const existQuestion = await this.prismaService.history.findFirst({
      where: { history_id: historyId },
    });

    if (!existQuestion) {
      throw new BadRequestException("질문이 없습니다. 다시 확인해주세요.");
    }

    const result = await this.calculateFeedback(feedbackRequestDto);

    await this.prismaService.user.update({
      where: { user_id: existQuestion.user_id },
      data: {
        points: { increment: result.score },
      },
    });

    await this.prismaService.history.update({
      where: { history_id: historyId },
      data: {
        question,
        answer,
        feedback: JSON.stringify(result.feedback),
        answered_at: new Date(Date.now() + 9 * 60 * 60 * 1000),
        score: result.score,
        status: question_status.ANSWERED,
      },
    });

    const history = await this.prismaService.history.findFirst({
      where: { history_id: historyId },
    });

    if (!history) {
      throw new Error("History not found");
    }

    return {
      ...history,
      feedback: history.feedback ? JSON.parse(history.feedback) : null,
    };
  }

  async createFeedback(
    feedbackRequestDto: FeedbackRequestDto,
    historyId: string,
  ) {
    const { question, answer } = feedbackRequestDto;

    const existHistory = await this.prismaService.history.findFirst({
      where: { history_id: historyId },
      select: {
        user_id: true,
        question_id: true,
      },
    });

    if (!existHistory) {
      throw new BadRequestException(
        "질문에 대한 답변이 없습니다. 다시 확인해주세요.",
      );
    }

    const result = await this.calculateFeedback(feedbackRequestDto);

    const newHistory = await this.prismaService.history.create({
      data: {
        history_id: uuid(),
        question_id: existHistory.question_id,
        user_id: existHistory.user_id,
        question,
        answer,
        feedback: JSON.stringify(result.feedback),
        created_at: new Date(Date.now() + 9 * 60 * 60 * 1000),
        score: result.score,
        status: question_status.ANSWERED,
      },
    });

    return {
      ...newHistory,
      feedback: newHistory.feedback ? JSON.parse(newHistory.feedback) : null,
    };
  }

  private async generateEmbedding(text: string): Promise<number[]> {
    try {
      const response = await this.ollama.embed({
        model: `${this.configService.get("OLLAMA_EMBEDDING_MODEL", { infer: true })}`,
        input: text,
      });

      return response.embeddings[0];
    } catch (e) {
      console.error(`Embedding generation failed`, e);
      return [];
    }
  }

  private async generateReferenceEmbedding(question: string) {
    try {
      const prompt = `질문: "${question}"\n\n위 질문에 대한 답변 중에서 핵심 키워드를 나열하세요 (답변 형식이 아닌 키워드만):`;

      const response = await this.ollama.generate({
        model: `${this.configService.get("OLLAMA_MODEL", { infer: true })}`,
        prompt,
        stream: false,
        options: {
          temperature: 0.5, // 0과 가까우면 가장 결정론적 -> 0.5는 어느 정도 유연선이 필요하기 떄문에 설정
          num_predict: 100, // 생성할 최대 토큰 수 -> 이는 답변이 길 필요가 없기 때문에 짧은 출력으로 비용 및 시간 절약
        },
      });

      return await this.generateEmbedding(response.response.trim());
    } catch (e) {
      console.error("Reference embedding generation failed:", e);

      return await this.generateEmbedding(question);
    }
  }

  // 코사인 유사도 계산
  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length === 0 || vecB.length === 0 || vecA.length !== vecB.length) {
      return 0;
    }

    let dotProduct: number = 0;
    let normA: number = 0;
    let normB: number = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    const denominator: number = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) {
      return 0;
    }

    return dotProduct / denominator;
  }

  private calculateRelevanceScore(
    question: string,
    answer: string,
    embeddingSimilarity: number,
  ) {
    // 질문의 핵심 키워드 추출
    const questionWords: string[] =
      question
        .toLowerCase()
        .match(/[\w가-힣]+/g)
        ?.filter((w: string) => w.length > 1 && !KOREAN_STOP_WORDS.has(w)) ||
      [];

    const answerWords = answer.toLowerCase().match(/[\w가-힣]+/g) || [];
    const answerWordSet = new Set(answerWords);

    // 키워드 매칭률
    const matchedKeywords: number = questionWords.filter((w) =>
      answerWordSet.has(w),
    ).length;
    const keywordMatchRatio: number =
      questionWords.length > 0 ? matchedKeywords / questionWords.length : 0;

    // 키워드 매칭 점수 (0-15점)
    const keywordScore: number = keywordMatchRatio * 15;

    // 임베딩 유사도 점수 (0-10점)
    // 조정된 범위: 0.2~0.5 범위를 0~10점으로 선형 매핑
    // - 0.2 미만: 0점 (거의 무관한 답변)
    // - 0.35: 5점 (중간 수준의 관련성)
    // - 0.5 이상: 10점 (매우 관련성 높음)
    const embeddingScore: number = Math.max(
      0,
      Math.min(10, (embeddingSimilarity - 0.2) * 33.33),
    );

    return Math.round(keywordScore + embeddingScore);
  }

  private calculateSemanticScore(
    _questionAnswerSimilarity: number,
    referenceAnswerSimilarity: number,
  ): number {
    // 참조 답변과의 유사도를 0-40점으로 매핑 (완화된 기준)
    // 0.3 이하: 매우 낮음 (0-10점)
    // 0.3-0.45: 보통 (10-25점)
    // 0.45-0.6: 좋음 (25-35점)
    // 0.6 이상: 매우 좋음 (35-40점)
    if (referenceAnswerSimilarity < 0.3) {
      return Math.round(referenceAnswerSimilarity * 33.33);
    } else if (referenceAnswerSimilarity < 0.45) {
      return Math.round(10 + (referenceAnswerSimilarity - 0.3) * 100);
    } else if (referenceAnswerSimilarity < 0.6) {
      return Math.round(25 + (referenceAnswerSimilarity - 0.45) * 66.67);
    } else {
      return Math.round(
        35 + Math.min(5, (referenceAnswerSimilarity - 0.6) * 12.5),
      );
    }
  }

  private calculateQualityScore(answer: string, issues: string[]) {
    let score = 0;

    // 1. 답변 길이 평가 (0-15점) - 완화된 기준
    const length = answer.trim().length;
    if (length < 20) {
      score += 5;
      issues.push("답변이 다소 짧습니다");
    } else if (length < 50) {
      score += 10;
    } else if (length < 80) {
      score += 13;
    } else {
      // 80자 이상이면 길이에 대한 만점 부여
      score += 15;
    }

    // 2. 문장 구조 평가 (0-10점) - 완화된 기준
    const sentences = answer.split(/[.!?]/).filter((s) => s.trim().length > 0);
    if (sentences.length === 1) {
      score += 5; // 5점으로 상향 (기존 3점)
      issues.push("단일 문장으로 구성됨");
    } else if (sentences.length < 3) {
      score += 8; // 8점으로 상향 (기존 6점)
    } else if (sentences.length <= 5) {
      score += 10;
    } else {
      score += 9; // 너무 길어도 9점 (기존 8점)
    }

    // 3. 구체성 평가 (0-10점) - 기준 완화
    const hasExamples = /예를 들[어면]|예시|사례|경우/.test(answer);
    const hasNumbers = /\d+/.test(answer);
    const hasSpecificTerms = answer
      .split(/\s+/)
      .some((word) => word.length > 4);

    let specificityScore = 0;
    // 기본 점수: 답변이 있으면 5점 부여 (기존 3점)
    specificityScore += 5;
    // 예시 사용: +2점
    if (hasExamples) specificityScore += 2;
    // 숫자/데이터 사용: +2점
    if (hasNumbers) specificityScore += 2;
    // 전문 용어/구체적 표현: +3점
    if (hasSpecificTerms) specificityScore += 3;

    // 최대 10점으로 제한
    score += Math.min(10, specificityScore);

    // 기본 점수(5) + 전문 용어(3) + 숫자(2) = 10점 가능
    if (specificityScore < 7) {
      issues.push("구체적인 예시나 설명이 부족합니다");
    }

    return Math.round(Math.min(35, score));
  }

  private calculatePenalty(
    answer: string,
    _questionEmbedding: number[],
    _answerEmbedding: number[],
    issues: string[],
  ) {
    let penalty = 0;

    // 주제 불일치는 feedback 메서드에서 조기 체크로 처리 (0.15 미만)
    // 여기서는 약간의 주제 이탈만 감점
    // topicSimilarity 0.15-0.25 범위는 이미 낮은 relevanceScore로 반영됨

    // 2. 반복적인 내용 (완화)
    const words = answer.toLowerCase().match(/[\w가-힣]+/g) || [];
    const wordFreq = new Map<string, number>();
    words.forEach((w) => {
      if (w.length > 2) {
        wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
      }
    });

    const maxFreq = Math.max(...Array.from(wordFreq.values()));
    if (maxFreq > 7) {
      // 기존 5 -> 7로 완화
      penalty += 5; // 기존 10점
      issues.push("동일한 단어가 과도하게 반복됩니다");
    }

    // 3. 너무 짧거나 의미 없는 답변 (완화)
    if (words.length < 5) {
      // 기존 10 -> 5로 완화
      penalty += 15; // 기존 20점
      issues.push("답변의 내용이 부족합니다");
    }

    return penalty;
  }

  /**
   * LLM을 사용하여 답변이 질문의 핵심 요구사항을 충족하는지 이진 판단
   * @returns true면 충족, false면 불충족
   */
  private async checkAnswerCompleteness(
    question: string,
    answer: string,
  ): Promise<boolean> {
    try {
      const prompt = `당신은 엄격한 면접 평가자입니다. 다음 질문과 답변을 분석하여 YES 또는 NO로만 답변하세요.

질문: ${question}

답변: ${answer}

평가 기준:
1. 질문이 요구한 구체적인 내용을 답변에 포함하고 있는가?
   - 질문이 "무엇"을 물으면 구체적인 항목/이름을 제시했는가?
   - 질문이 "어떤"을 물으면 구체적인 유형/종류를 제시했는가?
   - 질문이 "설명"을 요구하면 단순 나열이 아닌 설명을 했는가?

2. 모호한 표현으로 회피하지 않았는가?
   - "등등", "여러가지", "같은" 등으로 얼버무리지 않았는가?
   - "A, B 등등이 있습니다"처럼 불완전한 나열을 하지 않았는가?

3. 질문이 복합적이면 모든 요구사항을 다루었는가?

판정:
- 위 기준을 모두 충족하면: YES
- 하나라도 충족하지 못하면: NO

반드시 YES 또는 NO 중 하나만 출력하세요.`;

      const response = await this.ollama.generate({
        model: `${this.configService.get("OLLAMA_MODEL", { infer: true })}`,
        prompt,
        stream: false,
        options: {
          temperature: 0.3, // 일관된 판단을 위해 낮은 temperature
          num_predict: 10, // YES/NO만 받으면 되므로 최소한의 토큰
        },
      });

      const result = response.response.trim().toUpperCase();

      // YES 포함 여부로 판단
      return result.includes("YES");
    } catch (e) {
      console.error("Answer completeness check failed:", e);
      // 에러 발생 시 보수적으로 true 반환 (과도한 감점 방지)
      return true;
    }
  }

  /**
   * 질문의 복잡도와 요구사항에 따라 필수 키워드 포함 여부를 체크하고 감점 적용
   */
  private checkRequiredKeywords(
    question: string,
    answer: string,
    issues: string[],
  ): number {
    let penalty = 0;
    const questionLower = question.toLowerCase();
    const answerLower = answer.toLowerCase();

    // 1. 복합 질문 패턴 감지 (여러 가지를 물어보는 질문)
    const complexQuestionPatterns = [
      /무엇.*어떤/,
      /무엇.*왜/,
      /어떤.*왜/,
      /나열.*설명/,
      /차이.*설명/,
      /(\?|,|、|\.)\s*.*(\?)/,
    ];

    const isComplexQuestion = complexQuestionPatterns.some((pattern) =>
      pattern.test(questionLower),
    );

    // 2. 구체적 답변을 요구하는 패턴 감지
    const requiresSpecificAnswer =
      /무엇|what|어떤|which|나열|list|설명|explain|종류|types|방법|how/.test(
        questionLower,
      );

    // 3. 질문에서 핵심 기술 용어/개념 추출
    const questionWords =
      question
        .match(/[\w가-힣]{3,}/g)
        ?.filter((w) => !KOREAN_STOP_WORDS.has(w.toLowerCase())) || [];

    // 4. 답변에 질문의 핵심 단어가 얼마나 포함되어 있는지 체크
    const mentionedKeywords = questionWords.filter((keyword) =>
      answerLower.includes(keyword.toLowerCase()),
    );

    const keywordCoverage =
      questionWords.length > 0
        ? mentionedKeywords.length / questionWords.length
        : 1;

    // 5. 복합 질문인데 답변이 불충분한 경우 감점
    if (isComplexQuestion) {
      if (answer.trim().length < 150) {
        // 복합 질문인데 답변이 150자 미만
        penalty += 10;
        issues.push("복합 질문에 대한 답변이 불충분합니다");
      }

      // 복합 질문인데 키워드 커버리지가 낮은 경우
      if (keywordCoverage < 0.3) {
        penalty += 15;
        issues.push("질문의 핵심 요구사항에 대한 답변이 부족합니다");
      }
    }

    // 6. 구체적 답변을 요구하는데 일반론만 답한 경우
    if (requiresSpecificAnswer) {
      // 숫자나 구체적 용어가 거의 없는 경우
      const hasNumbers = /\d+/.test(answer);
      const hasSpecificTerms = answer.split(/\s+/).some((w) => w.length > 5);
      const hasBulletPoints = /\n|•|·|-\s/.test(answer);

      if (!hasNumbers && !hasSpecificTerms && !hasBulletPoints) {
        penalty += 10;
        issues.push("구체적인 답변이 필요하나 일반론만 제시되었습니다");
      }
    }

    // 7. 키워드 커버리지가 매우 낮은 경우 (질문 내용을 거의 언급 안함)
    if (keywordCoverage < 0.2 && questionWords.length >= 3) {
      penalty += 5;
      issues.push("질문의 주요 개념이 답변에 충분히 포함되지 않았습니다");
    }

    return penalty;
  }

  private isMeaninglessAnswer(answer: string): boolean {
    const text = answer.trim();

    // 1. 같은 문자가 80% 이상 반복되는 경우 (예: "aaaaaaaaaa")
    const charFreq = new Map<string, number>();
    for (const char of text) {
      charFreq.set(char, (charFreq.get(char) || 0) + 1);
    }
    const maxCharFreq = Math.max(...Array.from(charFreq.values()));
    if (maxCharFreq / text.length > 0.8) {
      return true;
    }

    // 2. 같은 짧은 패턴이 계속 반복되는 경우 (예: "asdfasdfasdf")
    // 2-4글자 패턴이 5번 이상 연속 반복
    for (let patternLen = 2; patternLen <= 4; patternLen++) {
      const pattern = text.slice(0, patternLen);
      let repeatCount = 0;
      let pos = 0;

      while (pos + patternLen <= text.length) {
        if (text.slice(pos, pos + patternLen) === pattern) {
          repeatCount++;
          pos += patternLen;
        } else {
          break;
        }
      }

      // 패턴이 5번 이상 반복되고, 전체 텍스트의 70% 이상을 차지하면 무의미
      if (repeatCount >= 5 && (repeatCount * patternLen) / text.length > 0.7) {
        return true;
      }
    }

    // 3. 의미 있는 단어가 거의 없는 경우
    // 한글, 영어 단어로 파싱했을 때 2글자 이상 단어가 2개 미만
    const words = text.match(/[가-힣]+|[a-zA-Z]+/g) || [];
    const meaningfulWords = words.filter((w) => w.length >= 2);
    if (meaningfulWords.length < 2 && text.length > 20) {
      return true;
    }

    // 4. 키보드 연타 패턴 감지
    const commonKeyPatterns = [
      /([qwer]{4,})\1+/i,
      /([asdf]{4,})\1+/i,
      /([zxcv]{4,})\1+/i,
      /([uiop]{4,})\1+/i,
      /([hjkl]{4,})\1+/i,
      /([123]{3,})\1+/,
    ];

    for (const pattern of commonKeyPatterns) {
      if (pattern.test(text)) {
        return true;
      }
    }

    return false;
  }

  private async generateFeedback(
    question: string,
    answer: string,
    retryCount = 0,
  ): Promise<AiFeedback> {
    const MAX_RETRIES = 2;

    try {
      const prompt = `당신은 경력 10년 이상의 시니어 면접관입니다. 다음 면접 질문과 지원자의 답변을 깊이 있게 분석하여 상세한 피드백을 제공하세요.

면접 질문: ${question}

지원자 답변: ${answer}

[필수] 아래 JSON 형식으로만 응답하세요. JSON 외의 텍스트는 절대 포함하지 마세요.
[필수] 각 필드는 하나의 긴 문자열로 작성하세요.
[필수] 한국어로 작성하세요.

{
  "good": "하나의 긴 문자열로 작성. 답변에서 잘한 점을 5~7문장으로 매우 상세하게 작성하세요. 면접 질문과의 연관성, 기술적 정확성, 구조적인 장점, 표현력, 전문성 등을 구체적인 예시와 함께 깊이 있게 평가하세요. 단순한 칭찬이 아니라 왜 그것이 좋은지 근거를 들어 설명하세요.",
  "improvement": "하나의 긴 문자열로 작성. 개선이 필요한 점을 5~7문장으로 매우 상세하게 작성하세요. 부족한 기술적 설명, 논리적 비약, 실무 관점의 미흡함, 깊이 부족 등을 구체적인 예시와 함께 지적하세요. 각 개선점마다 왜 개선이 필요한지, 어떻게 개선할 수 있는지를 함께 제시하세요.",
  "recommendation": "추가 학습이 필요한 주제 5~7개를 쉼표로 구분하여 나열만 하세요. 서두 없이 주제명만 작성하세요. 예시: REST API 설계 원칙과 Best Practices, Docker 컨테이너 오케스트레이션 기초, 데이터베이스 인덱싱 전략, 시스템 아키텍처 설계 패턴"
}

피드백 작성 기준:
- 답변이 면접 질문의 의도와 핵심을 정확히 파악했는가?
- 기술적 정확성과 깊이가 충분한가? 개념을 명확하게 설명했는가?
- 논리적 구조와 흐름이 자연스럽고 설득력이 있는가?
- 실무 관점과 경험이 반영되어 있는가?
- 구체적인 예시나 사례를 들어 설명했는가?

중요: 반드시 위의 JSON 형식으로만 응답하세요. 인사말, 설명, 마크다운 코드블록 없이 순수 JSON만 출력하세요.`;

      const response = await this.ollama.generate({
        model: `${this.configService.get("OLLAMA_MODEL", { infer: true })}`,
        prompt,
        stream: false,
        format: "json",
        options: {
          temperature: 0.7,
          num_predict: 2000,
        },
      });

      const feedback = this.parseJsonResponse(response.response);

      if (!feedback.good || !feedback.improvement || !feedback.recommendation) {
        throw new Error("Invalid feedback structure");
      }

      return feedback;
    } catch (e) {
      console.error(
        `AI feedback generation failed (attempt ${retryCount + 1}):`,
        e,
      );

      // 재시도 로직
      if (retryCount < MAX_RETRIES) {
        console.log(
          `Retrying feedback generation... (${retryCount + 1}/${MAX_RETRIES})`,
        );
        return this.generateFeedback(question, answer, retryCount + 1);
      }

      // 폴백 응답
      return {
        good: "질문에 대해 성실하게 답변해 주셨습니다. 기본적인 개념을 이해하고 있음을 보여주셨으며, 자신의 생각을 표현하려고 노력하신 점이 긍정적입니다. 답변의 구조를 갖추어 전달하려 하신 점도 좋습니다.",
        improvement:
          "답변의 깊이를 더하기 위해 구체적인 예시나 실무 경험을 추가하면 좋겠습니다. 기술적인 용어에 대한 정확한 정의와 함께 실제 적용 사례를 포함하면 더욱 설득력 있는 답변이 될 것입니다. 또한 질문의 핵심 의도를 파악하여 그에 맞는 답변 구조를 구성하는 연습이 필요합니다.",
        recommendation:
          "해당 주제에 대한 공식 문서 학습, 실무 적용 사례 분석, 기술 블로그 및 아티클 읽기, 관련 프로젝트 실습 경험 쌓기, 면접 시뮬레이션을 통한 답변 구조화 연습",
      };
    }
  }

  /**
   * Ollama 응답에서 JSON을 추출하고 파싱
   */
  private parseJsonResponse(rawResponse: string): AiFeedback {
    const trimmed = rawResponse.trim();

    // 1. 순수 JSON인 경우 바로 파싱 시도
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        // 파싱 실패 시 다음 단계로
      }
    }

    // 2. 마크다운 코드블록에서 JSON 추출 (```json ... ``` 또는 ``` ... ```)
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      try {
        return JSON.parse(codeBlockMatch[1].trim());
      } catch {
        // 파싱 실패 시 다음 단계로
      }
    }

    // 3. 텍스트 내에서 JSON 객체 추출 ({ ... } 패턴)
    const jsonMatch = trimmed.match(
      /\{[\s\S]*"good"[\s\S]*"improvement"[\s\S]*"recommendation"[\s\S]*\}/,
    );
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        // 파싱 실패 시 다음 단계로
      }
    }

    // 모든 시도 실패
    throw new Error(
      `Failed to parse JSON from response: ${trimmed.substring(0, 100)}...`,
    );
  }

  async aiFeedback(dto: AiFeedbackRequestDto) {
    if (!dto) {
      throw new BadRequestException("질문이 없습니다.");
    }

    const prompt = `당신은 면접 전문가 입니다. 다음 면접 질문에 대한 모범 답변을 작성해주세요.
    
    질문: ${dto.question}
    
    요구사항:
    - 실제 면접에서 사용할 수 있는 구체적이고 전문적인 답변
    - 핵심 개념을 명확히 설명
    - 실무 경험이나 예시를 포함하면 좋음
    `;

    const response = await this.ollama.generate({
      model: this.configService.get("OLLAMA_MODEL", { infer: true }),
      prompt: prompt,
      stream: false,
      options: {
        temperature: 0.7,
        num_predict: 400,
      },
    });

    return {
      question: dto.question,
      answer: response.response.trim(),
    };
  }
}
