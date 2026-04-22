# Gemini API에 들어가는 수집 데이터 형태 (현재 로직 기준)

이 문서는 **샘플 시나리오가 아니라**, `server.js` / `public/script.js` / `PromptManager.js`에서 실제로 조립되는 **데이터 구조·치환 키**를 기준으로 정리한 것이다.  
프롬프트 본문은 `prompts_ko.yml` 또는 `prompts_en.yml`의 해당 `task` 템플릿에 아래 값이 **`{{키}}` → 문자열 치환**으로 들어간다 (`PromptManager.getPrompt`).

---

## 1. 공통: 프롬프트 조립 방식

- **파일**: `PromptManager.js`
- **순서**: `[Persona]` + `[Instruction]` + (선택 `[Rules]`, `[Format]`) + `[Content]`(YAML `template`) 전체에 대해, `data` 객체의 각 키를 `{{키}}`와 매칭해 **전역 치환**한다.
- **주의**: YAML 안에 `{{키}}`가 없으면, 서버가 넘겨도 **프롬프트에 반영되지 않는다** (아래 6절 참고).

---

## 2. 트렌드 분석: `POST /api/analyze` (실시간 수집 데이터 사용)

### 2.1 서버 호출 (참고: `server.js` `trend_analysis` 분기)

```js
promptManager.getPrompt('trend_analysis', lang, {
  trends_data: JSON.stringify(trends),
  topic_count: topicCount,
});
```

- **`trends`**: 클라이언트가 보낸 **그대로**의 객체. 브라우저에서는 `currentTrendsData` (`script.js`).
- **`topic_count`**: 설정의 기획안 개수 (기본 `APP_CONFIG.topicCount`, 예: `3`).

### 2.2 클라이언트가 보내는 `trends`의 실제 형태

`fetch('/api/trends?...')` 응답을 출처별로 **필터만 한 객체**가 `currentTrendsData`로 저장되고, 분석 버튼 클릭 시 `trends: currentTrendsData`로 전송된다.

**한국(KR) — 키 목록 (전부 배열 또는 빈 배열)**

| 키 | `server.js` 수집 함수 | 배열 원소 필드 (요약) |
|----|------------------------|-------------------------|
| `google` | `getGoogleTrends('KR')` | `rank`, `keyword`, `traffic`, `image`, `newsItems[]` (`title`, `url`, `source`) |
| `signal` | `getSignalTrends` (Nate) | `rank`, `keyword`, `status`, `change` |
| `namu` | `getNamuwikiTrends` (Arca Live) | `rank`, `keyword`, `status`, `summaryUrl` |
| `fss` | `getFssAlerts` | `rank`, `keyword`, `url`, `pubDate` |
| `policy` | `getPolicyBriefing` | `rank`, `keyword`, `url`, `pubDate` |
| `ppomppu` | `getPpomppuHotDeals` | `rank`, `keyword`, `url` |
| `instiz` | `getInstizHot` | `rank`, `keyword`, `url` |

공통: 최상단에 **`timestamp`** (ISO 문자열).

**미국(US) — 키 목록**

| 키 | 출처 요약 |
|----|-----------|
| `google` | 동일 RSS, `geo=US` |
| `reddit` | 제목·점수·permalink 등 |
| `redditScams`, `redditPoverty`, `redditFrugal` | 서브레딧별 top |
| `yahoo`, `buzzfeed` | RSS 제목·링크 등 |

### 2.3 Gemini에 실제로 삽입되는 문자열: `trends_data`

`{{trends_data}}` 자리에는 **`JSON.stringify(trends)` 한 덩어리**가 그대로 들어간다.  
즉 **한국 기준**으로는 대략 아래와 같은 구조의 **문자열**이 프롬프트 `[Content]` 안에 포함된다 (값은 수집 시점·소스 설정에 따라 매번 다름).

```json
{
  "timestamp": "2026-04-19T12:34:56.789Z",
  "google": [
    {
      "rank": 1,
      "keyword": "실검에 올라온 검색어 예시",
      "traffic": "2000+",
      "image": "https://encrypted-tbn0.gstatic.com/...",
      "newsItems": [
        {
          "title": "관련 뉴스 제목",
          "url": "https://news.example.com/article/...",
          "source": "언론사명"
        }
      ]
    }
  ],
  "signal": [
    { "rank": 1, "keyword": "네이트 실시간 검색어", "status": "UP", "change": "3" }
  ],
  "namu": [
    { "rank": 1, "keyword": "나무위키 실검 키워드", "status": "NEW", "summaryUrl": "https://..." }
  ],
  "fss": [
    { "rank": 1, "keyword": "금융감독원 소비자경보 제목...", "url": "https://www.fss.or.kr/...", "pubDate": "2026-04-19T..." }
  ],
  "policy": [
    { "rank": 1, "keyword": "정책브리핑 RSS 제목", "url": "http://www.korea.kr/...", "pubDate": "..." }
  ],
  "ppomppu": [
    { "rank": 1, "keyword": "[정보] 뽐뿌 게시글 제목...", "url": "https://www.ppomppu.co.kr/zboard/..." }
  ],
  "instiz": [
    { "rank": 1, "keyword": "[인스티즈] 인티 베스트 제목...", "url": "https://www.instiz.net/pt/..." }
  ]
}
```

- UI에서 특정 소스를 끄면 해당 키는 **`[]`** 로 들어간다.
- `{{topic_count}}`에는 숫자 문자열(예: `"3"`)이 들어가, YAML에 적힌 “기획안 N개” 문구와 맞춘다.

---

## 3. 수동 입력 분석: `POST /api/analyze` (`manualText` 있을 때)

```js
promptManager.getPrompt('manual_analysis', lang, {
  manual_text: manualText,
  topic_count: topicCount,
});
```

- **`manual_text`**: 사용자가 모달에 입력한 **원문 전체**가 그대로 문자열로 치환된다.
- **`topic_count`**: 위와 동일.

`{{manual_text}}` / `{{topic_count}}`가 `trend_analysis`와 다른 task이므로, **수집 트렌드 JSON은 들어가지 않는다.**

---

## 4. 포스트 본문 생성: `POST /api/generate-post`

### 4.1 서버가 `getPrompt`에 넘기는 객체 (`server.js`)

`postPlan`은 분석 결과 JSON의 `blogPosts[i]` 한 건 + 클라이언트가 그대로 전달.  
`promptKey`는 `post_writing_${angle}` → `expose` | `guide` | `compare`.

```js
promptManager.getPrompt(promptKey, lang, {
  mainKeyword: postPlan.mainKeyword,
  searchIntent: postPlan.searchIntent,
  contentDepth: postPlan.contentDepth || 'Normal',
  conclusionType: postPlan.conclusionType || 'Q&A',
  coreFact: postPlan.coreFact || '최신 트렌드 데이터',
  coreEntities: /* 배열이면 join(', ') */,
  subTopics: /* 배열이면 join(', ') */,
  seoKeywords: tags.join(', '),  // 태그용 키워드 문자열
  lsiKeywords: /* 배열이면 join(', ') */,
  coreMessage: postPlan.coreMessage,
  context_url_1: "IMAGE_PLACEHOLDER_1",
  context_url_2: "IMAGE_PLACEHOLDER_2",
  context_url_3: "IMAGE_PLACEHOLDER_3",
});
```

### 4.2 YAML `post_writing_*` 템플릿에 **실제로 치환되는 키**

`prompts_ko.yml` 기준, 본문용 템플릿에서 사용하는 플레이스홀더는 다음과 같다.

| 치환 키 | 들어가는 값의 의미 (실제 데이터 출처) |
|---------|--------------------------------------|
| `mainKeyword` | 기획안 `mainKeyword` |
| `contentDepth` | `Snack` / `Normal` / `Deep-Dive` 등 |
| `conclusionType` | `Q&A`, `핵심 한 줄 요약` 등 |
| `coreFact` | 기획안 `coreFact` (없으면 서버 기본문구) |
| `coreEntities` | 배열이면 쉼표로 이어 붙인 문자열 |
| `subTopics` | 동일 |
| `lsiKeywords` | 동일 |
| `coreMessage` | 기획안 `coreMessage` |
| `context_url_1` ~ `_3` | 항상 `"IMAGE_PLACEHOLDER_1"` 등 고정 문자열 |

**분석 단계에서 모델이 만든 JSON 예시 한 건**이 `postPlan`으로 들어오면, 치환 후 `[포스팅 기획안]` 블록은 개념적으로 아래와 같이 읽힌다 (값은 매번 다름).

```text
[포스팅 기획안]
- 키워드: 비트코인 급락 시 대처법
- 볼륨/결론 방향성: Normal / Q&A
- 핵심 팩트: 최근 24시간 변동률 -3.2% (예시)
- 핵심 엔티티: 업비트, 김치 프리미엄, 스테이블코인
- 소주제 방향성: 손절 기준, 분할 매수, 세금
- 연관 키워드: 알트코인, 레버리지, 리스크 관리
- 전달 메시지: ...
- 제공 이미지: IMAGE_PLACEHOLDER_1, IMAGE_PLACEHOLDER_2, IMAGE_PLACEHOLDER_3
```

---

## 5. 트렌드와 무관한 Gemini 호출 (참고)

### 5.1 이미지 검색용 번역 `translateToEnglish` (`server.js`)

YAML이 아니라 **코드에 박힌 영문 프롬프트** 한 줄로, 인자는 사용자/기획 키워드뿐이다.

```text
Translate the following Korean blog keyword into a simple, clear English search term ...
Keyword: "${keyword}"
```

### 5.2 썸네일·본문 이미지

Pexels / Pixabay / Openverse 등은 **HTTP API**로만 연결되며, 트렌드 JSON 전체가 Gemini로 가지 않는다. 검색어는 제목·`imageSearchKeywords`·번역 결과 등에서 온다.

---

## 6. 서버는 넘기지만 YAML에 `{{키}}`가 없어 프롬프트에 안 보이는 값

현재 `post_writing_*` 호출 시 **`searchIntent`**, **`seoKeywords`** 는 `getPrompt`의 `data`에 포함되지만, `prompts_ko.yml` / `prompts_en.yml` 본문에 해당 플레이스홀더가 없으면 **모델 입력에 반영되지 않는다**.  
(필요하면 YAML에 `{{searchIntent}}` 등을 추가하는 방식으로 확장 가능.)

---

## 7. 파일·코드 위치 빠른 참조

| 항목 | 위치 |
|------|------|
| 치환 로직 | `trandRadar/PromptManager.js` → `getPrompt` |
| 트렌드 수집·`trends` 형태 | `trandRadar/server.js` (`getGoogleTrends` 등) |
| 클라이언트 `trends` 조립 | `trandRadar/public/script.js` (`fetchTrends`, `currentTrendsData`) |
| 분석/본문 프롬프트 정의 | `trandRadar/prompts_ko.yml`, `prompts_en.yml` |
