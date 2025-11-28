# PrePair Backend (NestJS)

**PrePair**는 AI 기반 맞춤형 면접 코칭 플랫폼입니다. 이 프로젝트는 멀티 백엔드 아키텍처로 구성되어 있으며, 이 서버(backend-ts)는 **AI 평가 및 피드백 생성**을 전담합니다.

```
┌─────────────────────┐     ┌─────────────────────┐
│   Backend (TS)      │     │  Backend (Java)     │
│      NestJS         │     │   Spring Boot       │
│                     │     │                     │
│  • AI 답변 평가       │     │  • 사용자 관리         │
│  • Ollama 연동       │     │  • 인증/인가          │
│  • 피드백 생성         │     │  • 비즈니스 로직       │
└──────────┬──────────┘     └──────────┬──────────┘
           │                           │
           └─────────────┬─────────────┘
                         │
              ┌──────────▼──────────┐
              │     PostgreSQL      │
              └─────────────────────┘
```

프론트엔드는 기능에 따라 두 백엔드와 통신하며, 이 서버는 Ollama를 활용한 LLM 추론 및 임베딩 기반 답변 분석을 담당합니다.

## 기술 스택

- NestJS 11
- TypeScript 5.7
- Prisma (PostgreSQL)
- Ollama (임베딩 + LLM)
- Zod (환경변수 검증)

## 시작하기

```bash
# 의존성 설치
pnpm install

# Prisma 클라이언트 생성
npx prisma generate

# 개발 서버 실행
pnpm start:dev
```

## 환경변수

`.env.dev`를 참고하여 `.env` 파일을 생성하세요.

```
PORT=3000
DATABASE_URL=postgresql://...
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=gemma3
OLLAMA_EMBEDDING_MODEL=bge-m3
FE_DOMAIN=http://localhost:5174
PREPAIR_DOMAIN=https://prepair.wisoft.dev
```

## 프로젝트 구조

```
src/
├── main.ts              # 앱 진입점
├── app.module.ts        # 루트 모듈
├── config/
│   └── env.config.ts    # 환경변수 스키마 및 검증
├── evaluation/          # 평가 기능 모듈
│   ├── evaluation.module.ts
│   ├── evaluation.controller.ts
│   ├── evaluation.service.ts
│   └── dto/
└── shared/
    └── prisma/          # DB 연결 모듈
```

## API

| Method | Endpoint | 설명 |
|--------|----------|------|
| PATCH | `/api/evaluation/feedback/:questionId` | 답변 평가 및 피드백 저장 |
| POST | `/api/evaluation/feedback/:questionId` | 피드백 재생성 |

## 스크립트

```bash
pnpm start:dev    # 개발 모드
pnpm build        # 빌드
pnpm start:prod   # 프로덕션 실행
pnpm test         # 테스트
pnpm lint         # 린트
pnpm format       # 포맷팅 (Biome)
```
