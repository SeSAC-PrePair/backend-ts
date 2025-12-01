import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { question_status } from "@prisma/client";
import { Ollama } from "ollama";
import OpenAI from "openai";
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

export interface CompetencyScores {
  proactivity: number; // 적극성
  logicalThinking: number; // 논리적사고
  creativity: number; // 창의력
  careerValues: number; // 직업관
  cooperation: number; // 협동성
  coreValues: number; // 가치관
}

export interface PersonalAnalysis {
  scores: CompetencyScores;
  strengths: string;
  improvements: string;
  recommendations: string;
}

@Injectable()
export class EvaluationService {
  constructor(
    private readonly ollama: Ollama,
    private readonly openai: OpenAI,
    private readonly configService: ConfigService<Env, true>,
    private readonly prismaService: PrismaService,
  ) {}

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

    if (this.isMeaninglessAnswer(answer)) {
      return {
        score: 0,
        feedback:
          "무의미한 문자열이나 반복된 패턴만 입력되었습니다. 의미 있는 답변을 작성해주세요.",
        detectedIssues: ["무의미한 답변"],
      };
    }

    // 질문 복사 탐지
    const copyDetection = this.detectQuestionCopy(question, answer);
    if (copyDetection.isCopied) {
      return {
        score: 0,
        feedback:
          "질문을 그대로 복사하거나 약간만 변형한 답변은 인정되지 않습니다. 본인의 생각과 경험을 담은 답변을 작성해주세요.",
        detectedIssues: [copyDetection.reason],
      };
    }

    const [questionEmbedding, answerEmbedding, referenceEmbedding] =
      await Promise.all([
        this.generateEmbedding(question),
        this.generateEmbedding(answer),
        this.generateReferenceEmbedding(question),
      ]);

    const topicSimilarity = this.cosineSimilarity(
      questionEmbedding,
      answerEmbedding,
    );

    if (topicSimilarity < 0.25) {
      const score =
        topicSimilarity < 0.15 ? 0 : Math.round(topicSimilarity * 20);
      return {
        score,
        feedback:
          "답변이 질문과 무관하거나 관련성이 매우 낮습니다. 질문을 다시 읽고 관련된 답변을 작성해주세요.",
        detectedIssues: ["질문과 무관한 답변"],
      };
    }

    const questionAnswerSimilarity = this.cosineSimilarity(
      questionEmbedding,
      answerEmbedding,
    );

    const referenceAnswerSimilarity = this.cosineSimilarity(
      referenceEmbedding,
      answerEmbedding,
    );

    const relevanceScore: number = this.calculateRelevanceScore(
      question,
      answer,
      questionAnswerSimilarity,
    );

    const semanticScore: number = this.calculateSemanticScore(
      questionAnswerSimilarity,
      referenceAnswerSimilarity,
    );

    const qualityScore = this.calculateQualityScore(answer, issues);

    const penalty = this.calculatePenalty(
      answer,
      questionEmbedding,
      answerEmbedding,
      issues,
    );

    const rawScore = relevanceScore + semanticScore + qualityScore - penalty;
    let finalScore = Math.round(Math.max(0, Math.min(100, rawScore)));

    const answerLength = answer.trim().length;
    if (answerLength < 50) {
      finalScore = Math.min(finalScore, 45);
      if (!issues.includes("답변이 다소 짧습니다")) {
        issues.push("답변이 매우 짧아 점수가 제한됩니다");
      }
    } else if (answerLength < 80) {
      finalScore = Math.min(finalScore, 50);
    } else if (answerLength < 120) {
      finalScore = Math.min(finalScore, 60);
    } else if (answerLength < 150) {
      finalScore = Math.min(finalScore, 70);
    } else if (answerLength < 200) {
      finalScore = Math.min(finalScore, 80);
    }

    const missingKeywordsPenalty = this.checkRequiredKeywords(
      question,
      answer,
      issues,
    );
    finalScore = Math.max(0, finalScore - missingKeywordsPenalty);

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
          temperature: 0.5,
          num_predict: 100,
        },
      });

      return await this.generateEmbedding(response.response.trim());
    } catch (e) {
      console.error("Reference embedding generation failed:", e);

      return await this.generateEmbedding(question);
    }
  }

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
    const questionWords: string[] =
      question
        .toLowerCase()
        .match(/[\w가-힣]+/g)
        ?.filter((w: string) => w.length > 1 && !KOREAN_STOP_WORDS.has(w)) ||
      [];

    const answerWords = answer.toLowerCase().match(/[\w가-힣]+/g) || [];
    const answerWordSet = new Set(answerWords);

    const matchedKeywords: number = questionWords.filter((w) =>
      answerWordSet.has(w),
    ).length;
    const keywordMatchRatio: number =
      questionWords.length > 0 ? matchedKeywords / questionWords.length : 0;

    const keywordScore: number = keywordMatchRatio * 15;

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

    const length = answer.trim().length;
    if (length < 20) {
      score += 5;
      issues.push("답변이 다소 짧습니다");
    } else if (length < 50) {
      score += 10;
    } else if (length < 80) {
      score += 13;
    } else {
      score += 15;
    }

    const sentences = answer.split(/[.!?]/).filter((s) => s.trim().length > 0);
    if (sentences.length === 1) {
      score += 5;
      issues.push("단일 문장으로 구성됨");
    } else if (sentences.length < 3) {
      score += 8;
    } else if (sentences.length <= 5) {
      score += 10;
    } else {
      score += 9;
    }

    const hasExamples = /예를 들[어면]|예시|사례|경우/.test(answer);
    const hasNumbers = /\d+/.test(answer);
    const hasSpecificTerms = answer
      .split(/\s+/)
      .some((word) => word.length > 4);

    let specificityScore = 0;
    specificityScore += 5;
    if (hasExamples) specificityScore += 2;
    if (hasNumbers) specificityScore += 2;
    if (hasSpecificTerms) specificityScore += 3;

    score += Math.min(10, specificityScore);

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

    const words = answer.toLowerCase().match(/[\w가-힣]+/g) || [];
    const wordFreq = new Map<string, number>();
    words.forEach((w) => {
      if (w.length > 2) {
        wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
      }
    });

    const maxFreq = Math.max(...Array.from(wordFreq.values()));
    if (maxFreq > 7) {
      penalty += 5;
      issues.push("동일한 단어가 과도하게 반복됩니다");
    }

    if (words.length < 5) {
      penalty += 15;
      issues.push("답변의 내용이 부족합니다");
    }

    return penalty;
  }

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
          temperature: 0.3,
          num_predict: 10,
        },
      });

      const result = response.response.trim().toUpperCase();
      return result.includes("YES");
    } catch (e) {
      console.error("Answer completeness check failed:", e);
      return true;
    }
  }

  private checkRequiredKeywords(
    question: string,
    answer: string,
    issues: string[],
  ): number {
    let penalty = 0;
    const questionLower = question.toLowerCase();
    const answerLower = answer.toLowerCase();

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

    const requiresSpecificAnswer =
      /무엇|what|어떤|which|나열|list|설명|explain|종류|types|방법|how/.test(
        questionLower,
      );

    const questionWords =
      question
        .match(/[\w가-힣]{3,}/g)
        ?.filter((w) => !KOREAN_STOP_WORDS.has(w.toLowerCase())) || [];

    const mentionedKeywords = questionWords.filter((keyword) =>
      answerLower.includes(keyword.toLowerCase()),
    );

    const keywordCoverage =
      questionWords.length > 0
        ? mentionedKeywords.length / questionWords.length
        : 1;

    if (isComplexQuestion) {
      if (answer.trim().length < 150) {
        penalty += 10;
        issues.push("복합 질문에 대한 답변이 불충분합니다");
      }

      if (keywordCoverage < 0.3) {
        penalty += 15;
        issues.push("질문의 핵심 요구사항에 대한 답변이 부족합니다");
      }
    }

    if (requiresSpecificAnswer) {
      const hasNumbers = /\d+/.test(answer);
      const hasSpecificTerms = answer.split(/\s+/).some((w) => w.length > 5);
      const hasBulletPoints = /\n|•|·|-\s/.test(answer);

      if (!hasNumbers && !hasSpecificTerms && !hasBulletPoints) {
        penalty += 10;
        issues.push("구체적인 답변이 필요하나 일반론만 제시되었습니다");
      }
    }

    if (keywordCoverage < 0.2 && questionWords.length >= 3) {
      penalty += 5;
      issues.push("질문의 주요 개념이 답변에 충분히 포함되지 않았습니다");
    }

    return penalty;
  }

  private detectQuestionCopy(
    question: string,
    answer: string,
  ): { isCopied: boolean; reason: string; copyRatio?: number } {
    const normalizedQuestion = question
      .toLowerCase()
      .replace(/[^\w가-힣]/g, "")
      .trim();
    const normalizedAnswer = answer
      .toLowerCase()
      .replace(/[^\w가-힣]/g, "")
      .trim();

    // 1. 완전 일치 체크
    if (normalizedQuestion === normalizedAnswer) {
      return {
        isCopied: true,
        reason: "질문을 그대로 복사함",
        copyRatio: 1,
      };
    }

    // 2. 질문이 답변에 포함되어 있는지 체크 (답변이 질문보다 조금만 긴 경우)
    if (
      normalizedAnswer.includes(normalizedQuestion) &&
      normalizedAnswer.length < normalizedQuestion.length * 1.3
    ) {
      return {
        isCopied: true,
        reason: "질문을 거의 그대로 포함한 답변",
        copyRatio: normalizedQuestion.length / normalizedAnswer.length,
      };
    }

    // 3. 부분 복사 탐지 - LCS(최장 공통 부분 문자열) 기반
    const lcsLength = this.findLongestCommonSubstring(
      normalizedQuestion,
      normalizedAnswer,
    );
    const lcsRatio = lcsLength / normalizedQuestion.length;

    // 질문의 40% 이상이 연속으로 답변에 포함되어 있으면 부분 복사로 판정
    if (lcsRatio > 0.4 && lcsLength >= 15) {
      return {
        isCopied: true,
        reason: "질문의 상당 부분을 그대로 복사함",
        copyRatio: lcsRatio,
      };
    }

    // 4. N-gram 기반 부분 복사 탐지
    const ngramCopyRatio = this.calculateNgramOverlap(
      normalizedQuestion,
      normalizedAnswer,
      4, // 4-gram
    );

    if (ngramCopyRatio > 0.5) {
      return {
        isCopied: true,
        reason: "질문 문구를 여러 곳에서 복사함",
        copyRatio: ngramCopyRatio,
      };
    }

    // 5. 레벤슈타인 거리 기반 유사도 (편집 거리)
    const editDistance = this.calculateLevenshteinDistance(
      normalizedQuestion,
      normalizedAnswer,
    );
    const maxLen = Math.max(normalizedQuestion.length, normalizedAnswer.length);
    const similarity = 1 - editDistance / maxLen;

    if (similarity > 0.85) {
      return {
        isCopied: true,
        reason: "질문과 매우 유사한 답변 (약간의 변형만 있음)",
        copyRatio: similarity,
      };
    }

    // 6. 단어 집합 기반 유사도 (Jaccard) - 답변에서 질문 단어가 차지하는 비율
    const questionWords = (
      normalizedQuestion.match(/[가-힣]{2,}|[a-zA-Z]{2,}/g) || []
    ).filter((w) => !KOREAN_STOP_WORDS.has(w));
    const answerWords =
      normalizedAnswer.match(/[가-힣]{2,}|[a-zA-Z]{2,}/g) || [];

    if (questionWords.length > 0 && answerWords.length > 0) {
      const questionWordSet = new Set(questionWords);
      const matchedInAnswer = answerWords.filter((w) => questionWordSet.has(w));

      // 답변 단어 중 질문에서 온 단어의 비율
      const answerCopyRatio = matchedInAnswer.length / answerWords.length;

      // 답변의 70% 이상이 질문에서 가져온 단어로 구성되어 있으면 복사로 판정
      if (answerCopyRatio > 0.7 && answer.length < question.length * 1.8) {
        return {
          isCopied: true,
          reason: "답변 대부분이 질문의 단어로만 구성됨",
          copyRatio: answerCopyRatio,
        };
      }
    }

    return {
      isCopied: false,
      reason: "",
    };
  }

  private findLongestCommonSubstring(str1: string, str2: string): number {
    const m = str1.length;
    const n = str2.length;

    // 메모리 최적화: 두 행만 사용
    let prev = new Array(n + 1).fill(0);
    let curr = new Array(n + 1).fill(0);
    let maxLength = 0;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          curr[j] = prev[j - 1] + 1;
          maxLength = Math.max(maxLength, curr[j]);
        } else {
          curr[j] = 0;
        }
      }
      [prev, curr] = [curr, prev];
      curr.fill(0);
    }

    return maxLength;
  }

  private calculateNgramOverlap(
    str1: string,
    str2: string,
    n: number,
  ): number {
    const getNgrams = (str: string, n: number): Set<string> => {
      const ngrams = new Set<string>();
      for (let i = 0; i <= str.length - n; i++) {
        ngrams.add(str.slice(i, i + n));
      }
      return ngrams;
    };

    const ngrams1 = getNgrams(str1, n);
    const ngrams2 = getNgrams(str2, n);

    if (ngrams1.size === 0) return 0;

    let matchCount = 0;
    for (const ngram of ngrams1) {
      if (ngrams2.has(ngram)) {
        matchCount++;
      }
    }

    return matchCount / ngrams1.size;
  }

  private calculateLevenshteinDistance(str1: string, str2: string): number {
    const m = str1.length;
    const n = str2.length;

    // 최적화: 길이 차이가 너무 크면 바로 큰 값 반환
    if (Math.abs(m - n) > Math.max(m, n) * 0.5) {
      return Math.max(m, n);
    }

    const dp: number[][] = Array(m + 1)
      .fill(null)
      .map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = Math.min(
            dp[i - 1][j] + 1, // 삭제
            dp[i][j - 1] + 1, // 삽입
            dp[i - 1][j - 1] + 1, // 대체
          );
        }
      }
    }

    return dp[m][n];
  }

  private isMeaninglessAnswer(answer: string): boolean {
    const text = answer.trim();

    const charFreq = new Map<string, number>();
    for (const char of text) {
      charFreq.set(char, (charFreq.get(char) || 0) + 1);
    }
    const maxCharFreq = Math.max(...Array.from(charFreq.values()));
    if (maxCharFreq / text.length > 0.8) {
      return true;
    }

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

      if (repeatCount >= 5 && (repeatCount * patternLen) / text.length > 0.7) {
        return true;
      }
    }

    const words = text.match(/[가-힣]+|[a-zA-Z]+/g) || [];
    const meaningfulWords = words.filter((w) => w.length >= 2);
    if (meaningfulWords.length < 2 && text.length > 20) {
      return true;
    }

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

      if (retryCount < MAX_RETRIES) {
        console.log(
          `Retrying feedback generation... (${retryCount + 1}/${MAX_RETRIES})`,
        );
        return this.generateFeedback(question, answer, retryCount + 1);
      }

      const errorMessage =
        e instanceof Error ? e.message : "알 수 없는 오류가 발생했습니다.";
      throw new BadRequestException(
        `AI 피드백 생성에 실패했습니다: ${errorMessage}`,
      );
    }
  }

  private parseJsonResponse(rawResponse: string): AiFeedback {
    const trimmed = rawResponse.trim();

    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        return JSON.parse(trimmed);
      } catch {}
    }

    const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      try {
        return JSON.parse(codeBlockMatch[1].trim());
      } catch {}
    }

    const jsonMatch = trimmed.match(
      /\{[\s\S]*"good"[\s\S]*"improvement"[\s\S]*"recommendation"[\s\S]*\}/,
    );
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {}
    }

    throw new Error(
      `Failed to parse JSON from response: ${trimmed.substring(0, 100)}...`,
    );
  }

  async aiFeedback(dto: AiFeedbackRequestDto) {
    if (!dto) {
      throw new BadRequestException("질문이 없습니다.");
    }

    const prompt = `당신은 면접 전문가입니다. 다음 면접 질문에 대한 모범 답변을 작성하세요.

질문: ${dto.question}

요구사항:
- 실제 면접에서 사용할 수 있는 구체적이고 전문적인 답변
- 핵심 개념을 명확히 설명
- 실무 경험이나 예시를 포함

중요: "답변:", "모범 답변:", "Answer:" 등의 접두어 없이 답변 내용만 바로 작성하세요.`;

    const response = await this.ollama.generate({
      model: this.configService.get("OLLAMA_MODEL", { infer: true }),
      prompt: prompt,
      stream: false,
      options: {
        temperature: 0.7,
        num_predict: 400,
      },
    });

    let answer = response.response.trim();

    // "답변:", "모범 답변:", "Answer:" 등의 접두어 제거
    answer = answer.replace(/^(답변\s*[:：]?\s*|모범\s*답변\s*[:：]?\s*|Answer\s*[:：]?\s*)/i, "").trim();

    // 일본어 한자, 중국어 간체/번체 등 불필요한 문자 제거 (한글, 영문, 숫자, 기본 문장부호만 허용)
    answer = answer.replace(/[一-龯㐀-䶵]/g, "").trim();

    // 연속된 공백 정리
    answer = answer.replace(/\s{2,}/g, " ").trim();

    return {
      question: dto.question,
      answer,
    };
  }

  async feedbackMe(userId: string): Promise<PersonalAnalysis> {
    const existUser = await this.prismaService.user.findFirst({
      where: { user_id: userId },
    });

    if (!existUser) {
      throw new BadRequestException("사용자가 없습니다.");
    }

    const histories = await this.prismaService.history.findMany({
      where: {
        user_id: userId,
        status: question_status.ANSWERED,
      },
      select: {
        question: true,
        answer: true,
        score: true,
      },
      orderBy: {
        answered_at: "desc",
      },
      take: 20,
    });

    if (histories.length === 0) {
      throw new BadRequestException(
        "분석할 면접 답변이 없습니다. 먼저 면접 질문에 답변해주세요.",
      );
    }

    const minAnswersForReliableAnalysis = 3;
    const isLowConfidence = histories.length < minAnswersForReliableAnalysis;

    const avgScore =
      histories.reduce((sum, h) => sum + (h.score ?? 0), 0) / histories.length;

    const qaPairs = histories
      .map(
        (h, idx) =>
          `[답변 ${idx + 1}] (점수: ${h.score ?? "미채점"})\nQ: ${h.question}\nA: ${h.answer}`,
      )
      .join("\n\n---\n\n");

    return this.analyzePersonality(qaPairs, 0, {
      totalAnswers: histories.length,
      avgScore,
      isLowConfidence,
    });
  }

  private async analyzePersonality(
    qaPairs: string,
    retryCount = 0,
    context?: {
      totalAnswers: number;
      avgScore: number;
      isLowConfidence: boolean;
    },
  ): Promise<PersonalAnalysis> {
    const MAX_RETRIES = 2;

    try {
      const systemPrompt = `당신은 삼성, 현대, SK 등 대기업 인사팀에서 25년간 수천 명의 지원자를 면접한 엄격한 면접 전문가입니다.
지원자의 면접 답변을 분석하여 6가지 핵심 역량을 **매우 엄격하게** 평가합니다.

## 핵심 평가 원칙

1. **기본값은 0점입니다.** 평범한 답변은 5점이 아니라 3점입니다.
2. **7점 이상은 상위 20% 수준의 답변에만 부여합니다.**
3. **9-10점은 상위 5% 수준, 실제 면접에서 "이 지원자는 반드시 뽑아야 한다"는 확신이 드는 경우에만 부여합니다.**
4. **구체적 사례, 수치, 실제 경험이 없으면 높은 점수를 줄 수 없습니다.**
5. **답변이 짧거나 추상적이면 반드시 감점합니다.**

## 평가 역량 (각 10점 만점) - 엄격한 기준

1. **적극성(proactivity)**: 도전 의식, 주도성, 자기 개발 의지
   - 9-10점: 스스로 문제를 발견하고 해결한 구체적 사례 + 정량적 성과 제시 + 지속적 자기개발 증거
   - 7-8점: 주도적으로 해결한 경험이 있으나 성과가 구체적이지 않음
   - 5-6점: 주어진 일에 적극적이나, 자발적 도전 사례 부족
   - 3-4점: 수동적이며 시키는 일만 수행한 경험만 언급
   - 1-2점: 소극적 태도, 회피 성향, 또는 관련 내용 없음

2. **논리적사고(logicalThinking)**: 문제 분석력, 구조적 사고, 근거 기반 설명
   - 9-10점: MECE 원칙에 따른 체계적 분석, 명확한 인과관계, 데이터/수치 기반 설명
   - 7-8점: 논리적 구조는 있으나 근거가 다소 약함
   - 5-6점: 논리적 흐름은 있으나 깊이 부족, 일반론적 설명
   - 3-4점: 두서없는 설명, 논리적 비약, 주장만 있고 근거 없음
   - 1-2점: 감정적/즉흥적 답변, 일관성 없음

3. **창의력(creativity)**: 독창적 아이디어, 새로운 관점, 유연한 사고
   - 9-10점: 기존에 없던 참신한 해결책 + 실제 적용 경험 + 다각도 분석
   - 7-8점: 일부 독창적 요소가 있으나 실행까지 연결되지 않음
   - 5-6점: 일반적인 해결책, 교과서적 접근
   - 3-4점: 정형화된 답변, 틀에 박힌 사고, 남들과 비슷한 답변
   - 1-2점: 창의적 시도 전무, 단순 암기식 답변

4. **직업관(careerValues)**: 직업에 대한 태도, 전문성 추구, 성장 비전
   - 9-10점: 명확한 5년/10년 커리어 로드맵 + 구체적 실행 계획 + 업계 트렌드 이해
   - 7-8점: 커리어 목표는 있으나 실행 계획이 구체적이지 않음
   - 5-6점: 직업에 대한 관심은 있으나 막연함
   - 3-4점: 막연한 직업관, "열심히 하겠다" 수준의 답변
   - 1-2점: 직업에 대한 진지함 부족, 준비 없이 지원한 느낌

5. **협동성(cooperation)**: 팀워크, 소통 능력, 갈등 해결 능력
   - 9-10점: 팀에서의 구체적 역할 + 갈등 해결 사례 + 정량적 팀 성과
   - 7-8점: 협력 경험은 있으나 본인 기여도가 불명확
   - 5-6점: 협력 의지는 있으나 구체적 경험 부족
   - 3-4점: 개인 중심적 성향, 팀 경험 언급 없음
   - 1-2점: 협동 경험 없음, 갈등 회피 또는 부정적 경험만 언급

6. **가치관(coreValues)**: 윤리의식, 책임감, 일관된 신념
   - 9-10점: 명확한 가치관 + 일관된 원칙 + 실제 딜레마 상황에서의 의사결정 사례
   - 7-8점: 가치관은 있으나 구체적 실천 사례가 약함
   - 5-6점: 일반적인 가치관 언급, 차별화되지 않음
   - 3-4점: 모호한 가치관, 표면적 답변
   - 1-2점: 가치관 미정립, 일관성 없는 답변

## 추가 감점 요소 (반드시 적용)
- 답변 길이가 100자 미만: 해당 역량 -2점
- 구체적 사례/경험 없이 추상적 답변만: 해당 역량 -2점
- 질문 의도를 파악하지 못한 답변: 해당 역량 -3점
- STAR 기법 미적용 (상황-과제-행동-결과 구조 없음): -1점`;

      const contextInfo = context
        ? `\n\n## 참고 정보
- 분석 대상 답변 수: ${context.totalAnswers}개
- 평균 점수: ${context.avgScore.toFixed(1)}점
- 신뢰도: ${context.isLowConfidence ? "낮음 (답변 수 부족으로 분석의 정확도가 제한됨)" : "보통"}`
        : "";

      const userPrompt = `## 분석할 면접 답변
${contextInfo}

${qaPairs}

---

## 분석 지침 (매우 엄격하게 적용)

1. **각 답변을 개별 분석**하여 어떤 역량이 드러나는지 파악하세요.
2. **구체적인 근거**를 들어 점수를 부여하세요. 근거 없이 높은 점수를 주지 마세요.
3. 답변의 **길이, 구체성, 논리성, STAR 기법 적용 여부**를 종합적으로 고려하세요.
4. **절대 후하게 평가하지 마세요.** 대기업 면접관의 시각으로 냉정하게 평가하세요.
5. **평균 점수가 5점을 넘기 어렵습니다.** 대부분의 취준생은 3-5점 수준입니다.
6. **7점 이상은 정말 뛰어난 답변에만 부여하세요.**
7. 각 점수에 대해 **왜 그 점수를 주었는지** 강점/약점에서 반드시 설명하세요.

## 출력 형식 (JSON)

\`\`\`json
{
  "scores": {
    "proactivity": <0-10>,
    "logicalThinking": <0-10>,
    "creativity": <0-10>,
    "careerValues": <0-10>,
    "cooperation": <0-10>,
    "coreValues": <0-10>
  },
  "strengths": "지원자의 강점을 15~20문장(최소 500자 이상)으로 서술. [중요] '답변 1', '답변 3' 같은 번호 언급 절대 금지 - 사용자는 번호를 모름. 대신 '전반적으로', '대부분의 답변에서', '여러 답변을 통해' 같은 표현 사용. 전체 답변에서 나타나는 공통적인 강점 패턴과 경향을 분석. 각 강점이 실제 업무에서 어떻게 발휘될 수 있는지 설명.",
  "improvements": "개선이 필요한 약점을 15~20문장(최소 500자 이상)으로 서술. [중요] '답변 2', '답변 5' 같은 번호 언급 절대 금지 - 사용자는 번호를 모름. 대신 '전반적으로', '여러 답변에서 공통적으로', '반복적으로 나타나는' 같은 표현 사용. 전체 답변에서 반복되는 문제점을 분석하고, 구체적인 개선 방법을 단계별로 제안.",
  "recommendations": "면접 질문에서 드러난 부족한 지식/개념을 7~10개 쉼표로 구분하여 구체적으로 제시. 추상적인 '글쓰기 연습', '역량 강화' 같은 표현 금지. 반드시 '딱 이거 공부해!'라고 말할 수 있을 정도로 구체적인 주제만 작성. 예: 'REST API와 GraphQL의 차이점', '동기/비동기 처리 개념', '팀 프로젝트에서의 Git 브랜치 전략', 'SQL JOIN 종류와 사용법', '객체지향 SOLID 원칙'"
}
\`\`\`

JSON만 출력하세요.`;

      const response = await this.openai.chat.completions.create({
        model: "anthropic/claude-sonnet-4",
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: userPrompt,
          },
        ],
        temperature: 0.3,
        max_completion_tokens: 8000,
        response_format: { type: "json_object" },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("Empty response from OpenRouter");
      }

      const result = this.parsePersonalAnalysisResponse(content);
      return result;
    } catch (e) {
      console.error(`Personal analysis failed (attempt ${retryCount + 1}):`, e);

      if (retryCount < MAX_RETRIES) {
        return this.analyzePersonality(qaPairs, retryCount + 1, context);
      }

      const errorMessage =
        e instanceof Error ? e.message : "알 수 없는 오류가 발생했습니다.";
      throw new BadRequestException(
        `면접 답변 분석에 실패했습니다: ${errorMessage}`,
      );
    }
  }

  private parsePersonalAnalysisResponse(rawResponse: string): PersonalAnalysis {
    const trimmed = rawResponse.trim();

    let parsed: PersonalAnalysis;

    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new Error("Failed to parse JSON response");
      }
    } else {
      const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (codeBlockMatch) {
        parsed = JSON.parse(codeBlockMatch[1].trim());
      } else {
        const jsonMatch = trimmed.match(/\{[\s\S]*"scores"[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error("No valid JSON found in response");
        }
      }
    }

    const scores = parsed.scores;
    const clampScore = (score: number) =>
      Math.max(0, Math.min(10, Math.round(score)));

    return {
      scores: {
        proactivity: clampScore(scores.proactivity),
        logicalThinking: clampScore(scores.logicalThinking),
        creativity: clampScore(scores.creativity),
        careerValues: clampScore(scores.careerValues),
        cooperation: clampScore(scores.cooperation),
        coreValues: clampScore(scores.coreValues),
      },
      strengths: parsed.strengths || "",
      improvements: parsed.improvements || "",
      recommendations: parsed.recommendations || "",
    };
  }
}
