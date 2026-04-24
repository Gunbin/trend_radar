# TrendRadar v2.5 — 최종 통합 개선 가이드 v3
## prompts_ko.yml + server.js 코드 기반 심층 분석 + 애드센스 승인 거절 대응

---

## 시스템 전체 흐름

```
[트렌드 수집]
Google/Nate/Namu/FSS/Policy/Ppomppu/Instiz 크롤링
        ↓
[기획 — trend_analysis / manual_analysis]
Gemini Flash → JSON 기획안 생성 (painScore, viralTitles, FAQ 등)
        ↓
[본문 생성 — post_writing_expose/guide/compare]
Gemini Flash → Markdown 본문 생성
        ↓
[후처리 파이프라인]
① References URL 검증 & 도메인 루트 축약
② 이미지 플레이스홀더 → Pixabay/Pexels/Openverse 실제 이미지 치환
③ 인터널 링크 자동 삽입 (published-index.json 기반)
④ 쿠팡 파트너스 박스 삽입
⑤ Hugo frontmatter 생성
        ↓
[배포]
GitHub REST API → Hugo 정적 사이트 빌드 → Google Indexing API 즉시 색인 요청
```

---

## 개선 1 — ANALYSIS_RESPONSE_SCHEMA 필드 필수화

### 문제

서버의 `ANALYSIS_RESPONSE_SCHEMA`에서 신생 블로그 SEO 4종 필드가 optional로 선언돼 있다.

```js
// 현재: optional 처리 (주석으로 명시됨)
// "[v2.7] 신생 블로그 SEO 보강용 4종 (optional — 모델이 빼먹어도 본문 생성은 그대로 진행)"
painScore: { type: "integer", minimum: 3, maximum: 15 },
serpDifferentiation: { type: "string" },
searchBehaviorQueries: { type: "array", items: { type: "string" } },
queryConfidence: { type: "string", enum: ["High", "Medium", "Low"] }
```

Gemini Flash는 schema에서 optional인 필드를 적극적으로 생략한다. 결과적으로 프롬프트에서 아무리 "필수"라고 지시해도 모델은 해당 필드를 빠뜨리고, `annotateAnalysisPriority()`에서 `priority: 'review'`(필드 누락 기본값)로 떨어져 경고 로그만 찍히고 넘어간다. **painScore/queryConfidence 기반 품질 필터가 실제로는 작동하지 않는 상태**다.

### 수정 내용

```js
required: [
    "trafficStrategy", "category", "mainKeyword", "angleType", "searchIntent",
    "contentDepth", "conclusionType", "coreFact", "viralTitles", "metaDescription",
    "slug", "faq", "subTopics", "coreEntities", "seoKeywords", "lsiKeywords",
    "imageSearchKeywords", "coreMessage",
    // 추가
    "painScore", "serpDifferentiation", "searchBehaviorQueries", "queryConfidence"
]
```

---

## 개선 2 — 이미지 번역 레이어 최적화

### 문제

본문 이미지 플레이스홀더 치환 시 `imageSearchKeywords` 배열을 이미지 순서와 명시적으로 매핑하지 않아 번역 API로 fallback되는 경로가 남아 있다.

### 수정 내용

```js
const engKeywords = Array.isArray(postPlan.imageSearchKeywords)
    ? postPlan.imageSearchKeywords : [];
let placeholderIndex = 0;

for (const match of bodyMatches) {
    if (placeholderUrl.includes('IMAGE_PLACE')) {
        const searchKeyword =
            englishKeyword                    // 1순위: 마크다운 title 속성
            || engKeywords[placeholderIndex]  // 2순위: 기획안 imageSearchKeywords[n]
            || await translateToEnglish(postPlan.mainKeyword); // 최후 fallback
        placeholderIndex++;
    }
}
```

이미지 3장 기준 번역 대기 시간 최대 9초 제거, Gemini API quota 절감.

---

## 개선 3 — 프롬프트 규칙 순서 재배치

### 문제

`pw_common_rules` 22개 규칙 중 가장 중요한 신뢰도 규칙(출처 위조 방지, 팩트 허수 생성 금지)이 후반부에 배치돼 있다. Gemini Flash는 컨텍스트가 길어질수록 후반부 규칙 이행률이 낮아진다.

### 수정 내용

```yaml
pw_common_rules:
  # ── TIER 1: 절대 규칙 — 위반 즉시 재생성 ──────────────────
  - 이모지(그림 유니코드) 0개
  - 변수 리터럴({{ }}) 본문 노출 금지
  - 출처 URL은 도메인 루트만 (deep-link 금지)
  - 쿠팡 마커 최대 1회

  # ── TIER 2: 구조 규칙 ───────────────────────────────────
  - 도입부 Hook/BLUF
  - SERP Differentiation 활용
  - H2 첫 시작 금지 (도입부 텍스트 선행)
  - FAQ 형식
  - 이미지 플레이스홀더 형식 (영문 title 속성 포함)

  # ── TIER 3: 스타일 규칙 — 이행률 낮음, 모니터링 후 제거 검토 ─
  - Visual Rhythm Randomizer
  - Micro-typography (span 아사이드)
  - 형광펜 mark 태그
  - 커뮤니티 여론 인용
```

---

## 개선 4 — useSearch=false 경로 coreFact 규칙 명확화

### 문제

`useSearch` 기본값이 `false`인 상태에서 Flash는 coreFact에 필요한 수치·통계를 추론으로 생성한다. 이것이 coreFact 허수 생성의 구조적 원인이다.

### 수정 내용

```yaml
■ coreFact 생성 원칙 (실시간 검색 미사용 시 — 기본 동작):
  - 입력 트렌드 데이터에 명시적으로 포함된 정보만 사용할 것
  - 데이터에 없는 수치·통계·가격·기관 발표를 추론으로 생성하는 것은 이 시스템에서 가장 심각한 오류다
  - 수치를 뒷받침할 데이터가 없으면 없다고 인정하고, 키워드 순위와 출처 채널명만으로 구성할 것
  - 허용: "뽐뿌 정보게시판 상위 노출 — 절세 ETF 관련 커뮤니티 관심 급증"
  - 금지: "국내 ETF 투자자 수 전년 대비 32% 증가 (금융위원회 발표)" ← 입력 데이터에 없는 AI 생성 수치
```

---

## 개선 5 — 트렌드 소스 재평가 및 신규 소스 추가

### 현재 소스별 신생 블로그 적합도

| 소스 | 성격 | 적합도 | 권고 |
|------|------|--------|------|
| Google Trends KR | 급상승 원형 키워드 | 하 | 롱테일 파생 후 사용, 원형 그대로 금지 |
| Nate 실시간 | 연예/가십 | 하 | 수명 1~3일, 에버그린 불가 |
| 나무위키(아카) | 밈/서브컬처 | 하 | 거의 모든 글이 에버그린 불가 |
| FSS 소비자경보 | 금융 사기 경보 | **최상** | 에버그린 + 손실회피 조합 |
| 정책브리핑 | 정부 정책/지원금 | **상** | 에버그린, 경쟁 강도 중 |
| 뽐뿌 정보게시판 | 꿀팁/재테크 | **상** | 에버그린, 롱테일 발굴 최적 |
| 인스티즈 핫게시판 | 10~20대 바이럴 | 하 | 수명 짧고 타겟 좁음 |

### 기획 소스 배분 규칙 수정

```yaml
기획안 1 (에버그린 우선):
  fss/policy/ppomppu 소스 우선.
  이 소스들이 빈약할 때만 google 진입 허용 —
  단, 원형 키워드 그대로 mainKeyword 사용 금지.
  반드시 롱테일 행동 파생 키워드로 변환 후 사용.
  (예: "탄핵" → 금지 / "탄핵 이후 부동산 시장 어떻게 되나" → 허용)

기획안 3 (창의적 융합):
  에버그린 소스 2개 융합을 1순위로 시도.
  signal/namu/instiz 기반 단독 기획은 글 100개 미만 단계에서 금지.
```

### 추가 권장 소스

**단기 도입 추천 — 네이버 DataLab 쇼핑인사이트 API (무료)**

AI 추론에 의존하던 serpDifferentiation(경쟁 강도 판단)을 실제 검색량 데이터로 대체할 수 있는 유일한 무료 소스. 검색량이 꾸준하지만 낮은 키워드 = 경쟁 강도 LOW 키워드를 기계적으로 필터링 가능하다.

```js
async function getNaverDatalab(keyword) {
    const res = await axios.post('https://openapi.naver.com/v1/datalab/search', {
        startDate: '2024-01-01',
        endDate: new Date().toISOString().slice(0, 10),
        timeUnit: 'month',
        keywordGroups: [{ groupName: keyword, keywords: [keyword] }]
    }, {
        headers: {
            'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
            'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET
        }
    });
    return res.data;
}
```

**중기 도입 검토:**
- 국민건강보험공단 보도자료 (`nhis.or.kr`) — 건강검진/급여 관련, 에버그린 수요 탄탄
- 한국소비자원 피해주의보 (`kca.go.kr`) — FSS 보완, 생활용품/서비스 카테고리
- 고용노동부 보도자료 — 최저임금/청년 지원금, 수요 안정적
- 공공데이터포털 OpenAPI (`data.go.kr`) — 정부 발표 수치 직접 활용으로 coreFact 허수 구조적 해소

---

## 개선 6 — 미사용 필드 프롬프트 연결

### 수정 내용

```js
// generate-post API 추가
searchBehaviorQueries: Array.isArray(postPlan.searchBehaviorQueries)
    ? postPlan.searchBehaviorQueries.join('\n') : '',
```

```yaml
# pw_common_rules 추가
- "FAQ 질문 문체 최적화:
   {{searchBehaviorQueries}} 값이 제공된 경우,
   FAQ 질문 문체를 이 구어체 패턴에 최대한 가깝게 작성하라.
   AI 검색 엔진(SGE, Perplexity 등)이 이 글을 답변 소스로 채택할 가능성이 높아진다."
```

---

## 개선 7 — 프롬프트 중복 규칙 정리

서버 후처리가 이미 처리하는 규칙은 프롬프트에서 제거한다. 프롬프트가 짧아질수록 Flash의 핵심 규칙 이행률이 올라간다.

| 프롬프트 규칙 | 서버 처리 위치 | 조치 |
|-------------|-------------|------|
| 출처 URL 도메인 루트 원칙 | `verifyAndFixReferences()` | 제거 → "시스템 자동 검증" 주석으로 대체 |
| 쿠팡 마커 최대 1회 | `buildCoupangBox()` | 동일 |
| 이미지 404 방지 | `verifyUrl()` | 동일 |

---

## 개선 8 — 애드센스 승인 대응 (콘텐츠 가치 저평가 문제)

애드센스로부터 "가치 없는 콘텐츠" 판정을 받았다. 아래는 외부 자료를 검토한 뒤 이견을 포함해 정리한 대응 방향이다.

### 8-1. AI Footprint 제거 — HTML 기교 전면 삭제 ✅ 동의

현재 프롬프트의 Tier 3 스타일 규칙들(`<span>` 아사이드, `<mark>` 형광펜, 강제 구두점 변주)은 **글 하나만 보면 사람처럼 보이지만, 수십 개 글에서 동일한 패턴이 반복되면 구글 SpamBrain에게 프로그래밍된 템플릿 Footprint로 인식**된다.

```yaml
# 삭제 대상 규칙
- [Micro-typography] span 아사이드 규칙 → 전면 삭제
- [형광펜 마크업] mark 태그 규칙 → 전면 삭제
- [구두점 강제 변주] ...과 — 사용 규칙 → 삭제
- 대체: 기본 Bold/Italic만 문맥에 맞게 자연스럽게 사용
```

### 8-2. FAQ/JSON-LD 스키마 조건부 전환 ✅ 부분 동의 (이견 반영)

외부 자료는 FAQ와 JSON-LD 스키마를 전면 삭제하라고 권고하지만, **JSON-LD 스키마 자체는 구글이 공식 권장하는 구조화 데이터**다. 삭제하면 오히려 손해다. 문제는 "모든 글에 기계적으로 동일한 스키마가 찍힌다"는 패턴이다.

```yaml
# 수정 방향
FAQ:
  - 현재: 모든 글에 고정 2개 강제 생성
  - 변경: contentDepth에 따라 동적 결정
    - Snack: FAQ 생략 가능 (스키마 미삽입)
    - Normal: FAQ 2~3개
    - Deep-Dive: FAQ 4~5개
  - 질문 문체는 searchBehaviorQueries 구어체 패턴 활용 (개선 6과 연계)

JSON-LD 스키마:
  - FAQ가 2개 이상인 글에만 조건부 삽입 (Snack 글 제외)
  - 유지하되 기계적 반복 패턴 차단
```

### 8-3. 포맷 동적 할당 (Dynamic Templating) ✅ 강하게 동의

현재 expose/guide/compare 3종 고정 구조가 가장 명확한 Footprint다. 모든 글이 동일한 골격을 가지면 구글이 템플릿 기반 대량 생성 사이트로 인식한다.

```js
// server.js — generate-post API 수정
// 고정된 promptKey 대신, 글마다 포맷 구조를 랜덤하게 할당

const FORMAT_TEMPLATES = [
    { key: 'list_guide',      label: '단계별 리스트형' },
    { key: 'compare_table',   label: '비교표 중심형' },
    { key: 'summary_first',   label: '핵심 요약 선행형' },
    { key: 'problem_solution',label: '문제-해결 서술형' },
    { key: 'expose',          label: '정보 폭로형 (기존)' },
];

// angleType과 contentDepth를 고려한 가중 랜덤 선택
function selectFormatTemplate(angleType, contentDepth) {
    if (angleType === 'compare') return 'compare_table';
    if (contentDepth === 'Snack') return 'summary_first';
    // 나머지는 가중 랜덤
    const pool = FORMAT_TEMPLATES.filter(t => t.key !== 'compare_table');
    return pool[Math.floor(Math.random() * pool.length)].key;
}
```

각 포맷별로 별도 프롬프트 섹션을 작성하거나, 포맷 지시를 프롬프트 변수(`{{outputFormat}}`)로 주입한다. 글마다 레이아웃이 달라지면 통계적 Footprint가 크게 줄어든다.

### 8-4. 출처 URL 파이프라인 투명화 ✅ 동의

현재 `verifyAndFixReferences()`가 출처 URL을 도메인 루트로 축약하는데, 이는 구글 입장에서 실제 출처가 불분명한 링크로 인식될 수 있다. 크롤링 단계에서 원본 URL을 수집해 프롬프트에 직접 주입하는 방식이 더 신뢰도가 높다.

```yaml
# prompts_ko.yml — references 생성 규칙 수정
■ 참고 자료 생성 원칙:
  - 제공된 {{source_urls}} 값이 있으면, 그 URL만 참고 자료로 사용할 것
  - 제공된 URL이 없으면 참고 자료 섹션 자체를 생성하지 말 것
  - 도메인을 임의로 추측하거나 URL을 창작하는 것은 이 시스템에서 가장 심각한 오류다
```

```js
// server.js — 크롤링 단계에서 summaryUrl 수집 후 프롬프트 변수로 주입
promptManager.getPrompt(promptKey, lang, {
    // ...기존 필드들...
    source_urls: trendData.sourceUrls?.join('\n') || '',  // 추가
});
```

### 8-5. FSS/정책 소스 차단 — 이견: 차단보다 품질 강화가 맞다

외부 자료는 애드센스 승인 전까지 FSS/정책 소스를 임시 차단하라고 권고하지만, **이는 신생 블로그의 가장 강력한 카드를 버리는 것**이다. FSS/정책 소스가 YMYL이라 위험하다는 건 사실이지만, 승인 거절의 직접 원인은 소스 자체가 아니라 **coreFact 허수 생성과 기계적 반복 패턴**이다. 이 두 가지를 먼저 고치는 것이 맞다.

소스를 차단하는 대신, YMYL 주제 글에 한해 coreFact 생성 기준을 더 엄격하게 적용한다.

```yaml
# YMYL 강화 규칙 (fss/policy 소스 기반 기획안에만 적용)
■ YMYL 콘텐츠 coreFact 강화 원칙:
  - 수치, 날짜, 기관명은 입력 데이터에 명시된 것만 사용
  - "~할 수 있다", "~로 알려져 있다" 등 불확실한 표현 금지
  - 결론부에 "본 정보는 참고용이며, 정확한 내용은 공식 기관에서 확인하세요" 문구 자동 삽입
```

### 8-6. 정보 밀도 최적화 — 텍스트 펌핑 억제 ✅ 동의

```yaml
# pw_common_rules 추가
■ 정보 밀도 원칙:
  - 주어진 데이터를 바탕으로 핵심만 압축하여 작성할 것
  - 불필요한 배경 설명, 억지 공감 문장, 가상의 예시 시나리오는 모두 생략
  - 글 길이가 짧아지더라도 팩트와 정보 밀도가 높으면 구글은 더 좋은 평가를 준다
  - "~라고 할 수 있습니다", "~것이 중요합니다" 같은 의미 없는 마무리 문장 금지
```

### 8-7. 신뢰 페이지 구축 — 1회성 수동 작업 필수

자동화와 별개로 애드센스 심사 봇이 가장 먼저 확인하는 페이지들이다. 한 번만 만들면 된다.

| 페이지 | 내용 | 우선순위 |
|--------|------|--------|
| About | 블로그 운영 목적, 주제 범위 | **필수** |
| Privacy Policy | 개인정보 수집 범위, 쿠키 사용 | **필수** |
| Contact | 연락 수단 (이메일 하나로 충분) | **필수** |
| Disclaimer | 외부 링크, 자동화 정보 수집 면책 | 권장 |

Hugo 기준으로 `content/about.md`, `content/privacy.md`, `content/contact.md` 파일로 정적 생성 가능하다. 템플릿을 써도 무방하나 반드시 존재해야 한다.

### 8-8. 재신청 전 기존 글 품질 기준 정리

재신청 시 구글 심사 봇은 사이트 전체의 평균 품질을 본다. 글 수를 늘리는 것보다 **평균 완성도를 높이는 것**이 승인 확률에 더 직접적인 영향을 미친다.

**최소 기준 (재신청 전 충족 필수):**

| 항목 | 기준 |
|------|------|
| 발행 글 수 | 독립적 주제 기준 최소 15~20개 이상 |
| 글당 분량 | 1,500자 이상 (Snack 글은 이 기준 적용 제외) |
| 중복 주제 | 동일 주제 중복 발행 없음 |
| 외부 복붙 | 타 사이트 콘텐츠 복제 없음 |
| 카테고리 구조 | 명확한 주제 분류 존재 |

**비공개 처리 기준 — 재신청 전 아래 해당 글은 드래프트로 전환:**

- coreFact에 검증 불가한 수치·기관 발표가 포함된 글
- 글 길이가 1,000자 미만인 Snack 글 중 정보 밀도가 낮은 것
- 동일 주제를 각도만 달리해 중복 발행한 글 (카니발리제이션 대상)
- HTML 기교(span 아사이드, mark 태그)가 과도하게 삽입된 초기 발행 글

비공개 처리는 글을 삭제하는 것이 아니므로, 개선 후 다시 공개할 수 있다. 양보다 질이 먼저다.

---

## 개선 9 — 콘텐츠 차별화 및 문체 품질 강화

### 9-1. 클리셰 금지어 목록 확장 및 문장 패턴 다양화

현재 프롬프트에 문장 호흡 변주와 클리셰 블랙리스트가 존재하지만 목록이 얕다. "AI가 쓴 것처럼 보이지 않게 해줘"식의 메타 지시는 Flash가 오히려 더 기계적으로 반응하는 부작용이 있다. 효과적인 방식은 **구체적인 금지 표현 목록을 확장**하고, 문장 구조 다양화 규칙을 명시적으로 강화하는 것이다.

```yaml
# pw_common_rules — 클리셰 블랙리스트 확장
■ 절대 사용 금지 표현 (확장):
  # 기존 항목 유지 +
  - "결론적으로 말씀드리자면"
  - "최근 떠오르고 있는"
  - "많은 분들이 궁금해하시는"
  - "이 글에서는 ~에 대해 알아보겠습니다"
  - "~에 대해 자세히 살펴보도록 하겠습니다"
  - "~라고 할 수 있습니다"
  - "다양한 측면에서"
  - "중요한 것은"
  - "주목할 만한"

■ 문장 구조 다양화 규칙 (강화):
  - 단문(10자 이내)과 장문(50자 이상)을 의도적으로 혼용할 것
  - 같은 문장 시작 패턴이 3번 이상 연속되면 반드시 변환할 것
    (예: "~입니다"로 끝나는 문장 3개 연속 금지)
  - 첫 문장은 단정적 사실 또는 반문으로 시작할 것
    (예: "대부분이 모른다." / "왜 이게 지금 터졌을까.")
```

### 9-2. Information Gain 강제 — 차별화 앵글 의무화

현재 `serpDifferentiation` 필드가 이 역할을 담당해야 하지만 실시간 검색 없이는 허수로 채워진다. 프롬프트 레벨에서 **차별화 앵글 3종 중 하나를 기획 단계에서 반드시 선택하도록** 강제하면 serpDifferentiation의 허수 문제를 구조적으로 보완할 수 있다.

```yaml
# trend_analysis / manual_analysis — angleType 선택 규칙 강화
■ Information Gain 앵글 의무화:
  기획안의 angleType과 별개로, 아래 3종 중 하나를 'infoGainAngle'로 반드시 선택하라.
  단순 사실 전달이나 뻔한 원인 분석은 infoGainAngle이 될 수 없다.

  [A] 숨겨진 부작용 / 2차 파급 효과:
      이슈의 표면 아래에 있는 영향, 대중이 놓치는 리스크
      예: "카카오페이 수수료 인상" → 소상공인 결제 회피 시나리오

  [B] 의외의 사실 / 통념 반박:
      일반적으로 알려진 것과 다른 데이터 또는 논리적 반전
      예: "탄산음료가 건강에 나쁘다" → 특정 조건에서 반박되는 연구

  [C] 과거 유사 사건 비교 분석:
      현재 이슈와 구조적으로 유사한 과거 사례를 찾아 패턴 비교
      예: "현재 부동산 규제" → 2011년 규제 사이클과의 유사점/차이점

  선택한 앵글을 'infoGainAngle' 필드에 기재하고,
  본문 생성 시 이 앵글이 H2 섹션 1개 이상으로 구현되어야 한다.
```

```js
// ANALYSIS_RESPONSE_SCHEMA에 필드 추가
infoGainAngle: {
    type: "object",
    properties: {
        type: { type: "string", enum: ["hidden_risk", "counter_intuitive", "historical_comparison"] },
        description: { type: "string" }  // 구체적으로 어떤 앵글인지 1줄 설명
    },
    required: ["type", "description"]
}
// required 배열에도 추가
```

```js
// generate-post API에 추가 전달
infoGainAngle: postPlan.infoGainAngle
    ? `[차별화 앵글: ${postPlan.infoGainAngle.type}]\n${postPlan.infoGainAngle.description}`
    : '',
```

```yaml
# pw_common_rules — 본문 생성 규칙 추가
■ Information Gain 구현 의무:
  - 제공된 {{infoGainAngle}} 값을 본문 H2 섹션 1개 이상으로 반드시 구현할 것
  - 이 섹션은 기존 뉴스·블로그에서 흔하게 다루는 내용과 명확히 달라야 한다
  - 독자가 "이건 다른 데서 못 본 시각"이라고 느낄 수 있는 서술이어야 한다
  - 단, 입력 데이터에 없는 수치나 사례를 창작하는 것은 금지 (개선 4 coreFact 원칙 준수)
```

### 9-3. 전문가 어조 강화 — 가상 경험담 없이 인사이트로

"5년 경험 전문가 페르소나"나 "직접 분석해보니"식의 1인칭 가상 경험담은 구글 Quality Rater가 사람이 직접 검토할 때 가장 먼저 잡히는 허위 E-E-A-T 신호다. 단기적으로 통과하더라도 이후 수동 품질 평가에서 역효과가 크다.

대신 **입력 데이터에서 실제로 추론 가능한 인사이트를 전문가 어조로 표현**하는 방식으로 전환한다. 경험을 창작하는 것이 아니라, 데이터에서 도출되는 판단을 단호하게 서술하는 것이 핵심이다.

```yaml
# pw_common_rules — 전문가 어조 규칙 추가
■ 전문가 어조 원칙:
  - 페르소나: "이 분야를 오래 지켜본 사람이 핵심만 정리해준다"는 톤
  - 허용: 데이터에서 도출된 판단을 단호하게 서술
    예: "이번 조치는 실효성이 낮다. 이유는 세 가지다."
  - 허용: 독자에게 직접 말을 거는 단정적 어조
    예: "대부분이 이 부분을 놓친다."
  - 금지: 가상의 1인칭 경험담 창작
    예: "직접 분석해보니", "내가 이 이슈를 처음 접했을 때" ← 입력 데이터에 없는 경험 창작 금지
  - 금지: 불확실한 완화 표현
    예: "~라고 할 수 있을 것 같습니다", "~인 것으로 보입니다"
```

---

## 개선 10 — 기획-본문 사이 팩트 보강 파이프라인 (Fact Enrichment Layer)

### 배경 및 설계 의도

현재 구조의 근본적 한계는 AI가 실시간 검색 없이 coreFact를 생성한다는 것이다. 개선 4에서 "없는 수치는 창작하지 말라"고 프롬프트로 제한했지만, 이는 허수를 막는 소극적 해결책이다. 근본 해결은 **서버가 실제 팩트를 긁어다 AI에게 넘겨주는 것**이다.

```
[현재]
기획(JSON) ──────────────────────→ 본문 생성 → 배포
           (AI가 팩트를 추론으로 채움)

[개선 후]
기획(JSON) → [Fact Enrichment] → 본문 생성 → 배포
               서버가 실제 데이터    검증된 팩트
               크롤링/검색 후        기반으로 작성
               AI로 필터링
```

이 레이어가 들어오면 개선 4(coreFact 허수), 개선 8-4(source_urls 파이프라인), 개선 9-2(Information Gain)가 동시에 구조적으로 해결된다.

---

### 문제 1 — 단순 키워드 검색의 노이즈 문제

`mainKeyword`만으로 검색하면 전혀 다른 맥락의 결과가 섞인다.

```
mainKeyword: "금리" 로 검색 시 혼재되는 결과:
- 한국은행 기준금리 결정
- 미국 Fed 금리 인상
- 시중은행 예금 금리 비교
- 대출 금리 인하 소식
→ 기획안이 원하는 "주담대 변동금리 전환 타이밍"과 무관한 결과 다수
```

### 해결 — 기획안 복합 필드로 정밀 쿼리 생성

기획안 JSON에는 `mainKeyword` 외에도 검색 정밀도를 높일 수 있는 필드들이 이미 있다.

```json
{
    "mainKeyword": "금리",
    "searchIntent": "금리 인하 이후 대출 갈아타기 타이밍",
    "coreEntities": ["한국은행", "주담대", "변동금리"],
    "category": "finance",
    "infoGainAngle": {
        "type": "hidden_risk",
        "description": "금리 인하 시 고정→변동 전환 시 놓치는 중도상환수수료 리스크"
    }
}
```

이 필드들을 조합하면 검색 쿼리 정밀도가 크게 올라간다.

```js
function buildSearchQuery(postPlan) {
    // coreEntities 중 핵심 2개 + searchIntent 조합
    const entities = (postPlan.coreEntities || []).slice(0, 2).join(' ');
    const intent   = postPlan.searchIntent || postPlan.mainKeyword;

    // 결과: "주담대 변동금리 금리 인하 이후 대출 갈아타기 타이밍"
    // → mainKeyword 단독보다 훨씬 구체적인 쿼리
    return `${entities} ${intent}`.trim().slice(0, 80);
}
```

가져온 결과를 정제하여 본문 생성에 필요한 핵심 팩트로 전달한다.

---

### 구현 — enrichPostPlan 함수

`generate-post` API에서 본문 생성 직전에 호출하는 중간 단계 함수다.

```js
// server.js — enrichPostPlan 함수 추가

async function searchNaverNews(query) {
    const res = await axios.get('https://openapi.naver.com/v1/search/news.json', {
        params: { query, display: 8, sort: 'date' },
        headers: {
            'X-Naver-Client-Id':     process.env.NAVER_CLIENT_ID,
            'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET
        }
    });
    return res.data.items.map(item => ({
        title:   item.title.replace(/<[^>]+>/g, ''),   // HTML 태그 제거
        summary: item.description.replace(/<[^>]+>/g, ''),
        url:     item.originallink || item.link,
        pubDate: item.pubDate
    }));
}

async function enrichPostPlan(postPlan) {
    try {
        const query      = buildSearchQuery(postPlan);
        const rawResults = await searchNaverNews(query);

        if (!rawResults || rawResults.length === 0) {
            logger.warn(`[Enrich] 검색 결과 없음 — query: ${query}`);
            return postPlan; // 결과 없으면 원본 기획안 그대로 반환
        }

        // Flash에게 필터링 + 팩트 추출 위임
        // 본문 생성보다 훨씬 단순한 작업이라 Flash가 정확하게 처리함
        const filterPrompt = `
아래는 블로그 포스팅 기획안과 뉴스 검색 결과입니다.

[기획 의도]
- 메인 키워드: ${postPlan.mainKeyword}
- 검색 의도: ${postPlan.searchIntent}
- 핵심 앵글: ${postPlan.infoGainAngle?.description || '없음'}
- 핵심 엔티티: ${(postPlan.coreEntities || []).join(', ')}

[뉴스 검색 결과]
${JSON.stringify(rawResults, null, 2)}

위 검색 결과 중 기획 의도와 직접 관련된 항목만 골라,
아래 JSON 형식으로만 응답하세요. 관련 없는 항목은 제외하세요.
관련 항목이 하나도 없으면 빈 배열 []을 반환하세요.

[
  {
    "fact": "핵심 팩트 1줄 (수치나 날짜가 있으면 포함)",
    "url": "원본 기사 URL",
    "pubDate": "발행일"
  }
]
        `.trim();

        const raw      = await callGemini(filterPrompt); // 기존 Gemini 호출 함수 재사용
        const cleaned  = raw.replace(/```json|```/g, '').trim();
        const filtered = JSON.parse(cleaned);

        if (!Array.isArray(filtered) || filtered.length === 0) {
            logger.warn(`[Enrich] 관련 팩트 없음 — keyword: ${postPlan.mainKeyword}`);
            return postPlan;
        }

        // enrichedFacts 필드로 기획안에 추가
        return {
            ...postPlan,
            enrichedFacts: {
                facts:      filtered.map(f => f.fact),
                sourceUrls: filtered.map(f => f.url).filter(Boolean),
                fetchedAt:  new Date().toISOString()
            }
        };

    } catch (err) {
        // 보강 실패 시 원본 기획안으로 fallback — 본문 생성은 중단하지 않음
        logger.error(`[Enrich] 팩트 보강 실패: ${err.message}`);
        return postPlan;
    }
}
```

---

### 호출 위치 — generate-post API

```js
// 현재
const body = await generatePost(postPlan, lang, promptKey);

// 변경 후 — enrichPostPlan 한 줄 추가
const enrichedPlan = await enrichPostPlan(postPlan);
const body         = await generatePost(enrichedPlan, lang, promptKey);
```

---

### 프롬프트 연결 — enrichedFacts 활용

보강된 팩트를 본문 생성 프롬프트에 전달한다.

```js
// generate-post API — promptManager.getPrompt() 호출 시 추가
enrichedFacts: enrichedPlan.enrichedFacts
    ? enrichedPlan.enrichedFacts.facts.map((f, i) =>
        `${i + 1}. ${f}`
      ).join('\n')
    : '',

source_urls: enrichedPlan.enrichedFacts
    ? enrichedPlan.enrichedFacts.sourceUrls.join('\n')
    : (trendData.sourceUrls?.join('\n') || ''),
```

```yaml
# pw_common_rules — enrichedFacts 활용 규칙 추가
■ 보강 팩트 활용 원칙:
  - {{enrichedFacts}} 값이 제공된 경우, coreFact 및 본문 서술에 이 팩트를 우선 활용할 것
  - 제공된 팩트는 실제 뉴스에서 추출된 것이므로 수치·날짜·기관명을 그대로 사용 가능
  - 제공된 팩트 외의 수치·통계를 추론으로 생성하는 것은 여전히 금지
  - {{source_urls}} 값이 있으면 참고 자료 섹션에 해당 URL을 사용할 것
```

---

### 소스 확장 — category별 분기 크롤링

네이버 뉴스 검색이 기본이지만, `category`에 따라 더 정확한 소스를 추가로 조회할 수 있다.

```js
async function enrichPostPlan(postPlan) {
    const results = [];

    // 공통: 네이버 뉴스 검색 (항상 실행)
    const newsResults = await searchNaverNews(buildSearchQuery(postPlan));
    results.push(...newsResults);

    // category별 추가 소스
    switch (postPlan.category) {
        case 'finance':
            // FSS 소비자경보 — 이미 크롤링 중이므로 캐시 활용
            const fssData = await getFssAlerts(postPlan.mainKeyword);
            results.push(...fssData);
            break;

        case 'policy':
            // 정책브리핑 — 이미 크롤링 중이므로 캐시 활용
            const policyData = await getPolicyBriefings(postPlan.mainKeyword);
            results.push(...policyData);
            break;

        case 'life':
        case 'tech':
            // 네이버 뉴스만으로 충분
            break;
    }

    // 이하 팩트 조합 로직 동일
    // ...
}
```

기존에 이미 크롤링하고 있는 FSS, 정책브리핑 데이터를 **기획 단계뿐 아니라 본문 생성 직전에도 재활용**하는 구조다. 추가 API 호출 없이 기존 크롤링 결과를 keyword 매칭으로 가져오면 된다.

---

### 기대 효과 및 한계

**해결되는 문제:**

| 기존 문제 | 해결 방식 |
|----------|---------|
| coreFact 허수 생성 (개선 4) | 실제 뉴스 팩트로 대체 |
| source_urls 도메인 루트만 사용 (개선 8-4) | 실제 기사 URL 주입 |
| serpDifferentiation 허수 (개선 1) | 실제 기사 내용 기반 정보 격차 파악 가능 |

**남아 있는 한계:**

- 네이버 뉴스 API 일일 할당량(25,000건) 초과 시 enrichment 스킵 — fallback으로 원본 기획안 사용
- 검색 쿼리가 너무 구체적이면 오히려 결과가 0건이 될 수 있음 — 이 경우 `mainKeyword` 단독 쿼리로 재시도하는 로직 추가 권장
- Flash 필터링 단계에서 추가 API quota 소모 발생 — 글 1개당 Gemini 호출이 기획 1회 + 필터링 1회 + 본문 1회로 늘어남

```js
// 쿼리 재시도 로직 예시
async function searchWithFallback(postPlan) {
    // 1차: 정밀 쿼리
    let results = await searchNaverNews(buildSearchQuery(postPlan));
    
    // 결과 없으면 2차: mainKeyword 단독
    if (results.length === 0) {
        results = await searchNaverNews(postPlan.mainKeyword);
    }
    
    return results;
}
```



### Phase 0 — 재신청 전 즉시 (수동 1회)

- [x] 신뢰 페이지(About/Privacy/Contact) 생성 (개선 8-7) (✅완료)
- [x] 기존 발행 글 품질 기준 점검 후 미달 글 비공개 처리 (개선 8-8) (✅완료)
  - coreFact 허수 포함 글, 1,000자 미만 저밀도 글, 중복 주제 글, HTML 기교 과다 글
- [x] 발행 글 수가 15개 미만이면 Phase 1 완료 후 추가 발행하여 기준 충족 후 재신청 (✅완료)

### Phase 1 — 즉시 (프롬프트만 수정)

1. [x] **HTML 기교 전면 삭제** (개선 8-1): Tier 3 스타일 규칙 삭제, Footprint 제거 (✅완료)
2. [x] **정보 밀도 원칙 추가** (개선 8-6): 텍스트 펌핑 억제 (✅완료)
3. [x] **coreFact 생성 원칙 명확화** (개선 4): 허수 팩트 금지 (✅완료)
4. [x] **FAQ 조건부 전환** (개선 8-2): contentDepth 기반 동적 결정 (✅완료)
5. [x] **출처 참고 자료 원칙 수정** (개선 8-4): 없으면 섹션 생성 금지 (✅완료)
6. [x] **규칙 순서 재배치 + 중복 제거** (개선 3, 7) (✅완료)
7. [x] **소스 배분 재조정 + searchBehaviorQueries 연결** (개선 5, 6) (✅완료)
8. [x] **클리셰 금지어 확장 + 전문가 어조 규칙 추가** (개선 9-1, 9-3) (✅완료)
9. **Phase 1 완료 후 2주 정도 자동화 재가동** → 개선된 프롬프트로 글 누적 후 재신청

### Phase 2 — 단기 (서버 코드 수정)

10. [x] **Dynamic Templating** (개선 8-3): expose/guide/compare 고정 구조 해체 (✅완료)
11. [x] **source_urls 파이프라인** (개선 8-4): 크롤링 원본 URL → 프롬프트 직접 주입 (✅완료)
12. [x] **ANALYSIS_RESPONSE_SCHEMA required 추가** (개선 1): painScore 등 4종 + infoGainAngle 필수화 (개선 9-2) (✅완료)
13. [x] **이미지 번역 레이어 최적화** (개선 2) (✅완료)
14. [x] **Fact Enrichment Layer 구현** (개선 10): 네이버 뉴스 API 연동 + 단일 키워드 검색 Fallback 적용 및 직접 팩트 반환 (✅완료)

### Phase 3 — 중장기 (신규 소스 도입)

15. **네이버 DataLab API 연동** (개선 5): 실제 검색량 데이터로 경쟁 강도 필터링
16. **공공 기관 RSS 추가** (개선 5): nhis, kca, 고용노동부 보도자료
17. [x] **enrichPostPlan category별 소스 확장** (개선 10): FSS/정책브리핑 캐시 재활용 (✅완료), 공공데이터포털 연동 (보류)

---

*분석 기준: TrendRadar v2.5 (prompts_ko.yml) + server.js / 2026년 4월*