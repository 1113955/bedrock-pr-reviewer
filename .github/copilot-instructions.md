# AI Review Comment Generation Logic

이 프로젝트는 PR 리뷰 자동화를 위해 AI(예: Bedrock 등)를 활용하여 코드 리뷰 코멘
트를 생성합니다. 아래는 주요 동작 방식과 참고할 만한 구현 포인트입니다.

## 주요 동작 흐름

1. **PR 변경 파일 및 diff 분석**

   - `src/review.ts`의 `codeReview` 함수에서 PR의 변경 파일 목록과 diff를 수집합
     니다.
   - 변경된 각 파일/patch에 대해 리뷰가 필요한지 판단합니다.

2. **AI를 통한 요약 및 리뷰 생성**

   - 각 파일/patch에 대해 프롬프트를 생성하고, `lightBot.chat`, `heavyBot.chat`
     등으로 AI에게 요약/리뷰를 요청합니다.
   - AI가 생성한 코멘트에는 반드시
     `<!-- This is an auto-generated comment by AI reviewer -->` 등 태그가 포함
     되어, 자동 생성 코멘트임을 명확히 합니다.

3. **코멘트 등록 및 관리**

   - AI가 생성한 리뷰 코멘트는 `src/commenter.ts`의 `Commenter` 클래스를 통해
     GitHub PR에 등록됩니다.
   - 이미 등록된 AI 코멘트, reply, resolved 상태 등은 태그와 체인 분석을 통해 중
     복/불필요 코멘트 생성을 방지합니다.
   - 코멘트 등록 시, `create`, `replace` 등 모드를 지원하며, 기존 코멘트가 있으
     면 업데이트, 없으면 새로 생성합니다.

4. **코멘트 체인 및 유사도 판단**

   - 동일 위치에 기존 코멘트가 있는 경우, `shouldResolveComment` 로직을 통해 새
     patch와 기존 코멘트의 유사도를 계산하여 자동 resolve 처리할 수 있습니다.
   - 유사도 평가는 텍스트 정제, 키워드 추출, Levenshtein 거리, Jaccard 유사도 등
     을 활용합니다.

5. **리뷰 진행 상태 및 커밋 관리**
   - 리뷰 진행 중에는 `IN_PROGRESS_START_TAG`/`IN_PROGRESS_END_TAG`로 상태를 표
     시합니다.
   - 리뷰가 완료된 커밋 ID는 `COMMIT_ID_START_TAG`/`COMMIT_ID_END_TAG`로 관리하
     여, 중복 리뷰를 방지합니다.

## 참고 파일 및 주요 함수

- 리뷰 전체 흐름: `src/review.ts`의 `codeReview`
- 코멘트 등록/업데이트/체인 관리: `src/commenter.ts`의 `Commenter` 클래스
- AI 프롬프트/응답 처리: `lightBot.chat`, `heavyBot.chat` 등

## 태그 예시

- 리뷰 코멘트: `<!-- This is an auto-generated comment by AI reviewer -->`
- 요약 코멘트:
  `<!-- This is an auto-generated comment: summarize by AI reviewer -->`
- 진행중 표시:
  `<!-- This is an auto-generated comment: summarize review in progress by AI reviewer -->`
- 커밋 ID 관리:
  `<!-- commit_ids_reviewed_start --> ... <!-- commit_ids_reviewed_end -->`

---

## ⚠️ Flutter 최신 API 관련 프롬프트 개선 안내

AI가 Flutter 코드 리뷰 시 최신 API(`withValues(alpha: ...)` 등)를 올바르게 인식
하지 못하고, 구버전 방식(`withAlpha`)을 강제하는 코멘트가 반복된다면, 다음과 같
이 프롬프트(지침)를 수정해야 합니다.

- **수정 대상 파일:** `src/prompts.ts`
- **수정 위치:** 리뷰 기준, 허용/비허용 API, 예외, 금지 코멘트, Flutter/Dart 최
  신 API 사용 가이드라인 등 프롬프트 텍스트(예: `reviewFileDiff` 등)에 명확히 안
  내
- **예시:**
  - "Flutter의 최신 API(`withValues(alpha: ...)` 등)는 공식 문서 기준으로 올바른
    사용법이므로, 구버전 API(`withAlpha`)로의 강제 변경을 요구하는 코멘트는 생성
    하지 않도록 하세요."
  - "Flutter/Dart의 최신 API 사용을 권장하며, 이미 최신 API가 사용된 경우 불필요
    한 변경을 요구하지 않습니다."

이와 같이 프롬프트를 보완하면, AI가 더 이상 잘못된 Flutter API 코멘트를 생성하지
않도록 할 수 있습니다.

---

이 문서는 AI 기반 리뷰 자동화 로직을 이해하거나, 관련 코드를 확장/수정할 때 참고
용으로 활용하세요.
