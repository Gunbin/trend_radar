# 📡 TrendRadar Data Sources (v2.0)

이 문서는 TrendRadar 자동화 포스팅 시스템이 수집하는 한국(KR) 및 미국(US) 지역의 데이터 소스와 파싱 방식을 정리한 문서입니다. AI 모델이 블로그 포스팅의 **"핵심 앵글(Angle)"**을 잡는 데 사용되는 원천 데이터의 속성을 파악할 수 있도록 구성되었습니다.

---

## 🇰🇷 한국 (KR) 데이터 소스 (총 7개)

### 1. 실시간 대중 관심사 (Mass Trend)
*   **[소스 1] Google Trends (KR)**
    *   **방식:** `RSS` (https://trends.google.com/trending/rss?geo=KR)
    *   **내용:** 그날 하루 한국 전체를 뒤흔든 대형 사건사고, 정치/사회 뉴스, 스포츠 이슈 등.
*   **[소스 2] Nate Trends**
    *   **방식:** `JSON API` (https://www.nate.com/js/data/jsonLiveKeywordDataV1.js)
    *   **내용:** 네이트 포털 실시간 검색어 1~10위 데이터. 포털 특성상 연예, 사건사고 키워드가 주를 이룸.
*   **[소스 3] Signal.bz (Namuwiki)**
    *   **방식:** `JSON API` (https://api.signal.bz/news/realtime)
    *   **내용:** 나무위키 기반 실시간 검색어 및 이슈 요약. 서브컬처, 게임, 유튜버, 특정 커뮤니티 이슈 포착에 유리.

### 2. 에버그린 및 실생활 정보 (Evergreen / Information)
*   **[소스 4] 금융감독원 소비자경보 (호구 방지 / Loss Aversion)**
    *   **방식:** `HTML 크롤링 (Cheerio)` (fss.or.kr 게시판)
    *   **내용:** 신종 보이스피싱, 코인 사기 수법, 중고거래 사기 등. "손해 보지 않기 위한" 자극적인 트래픽 유발 최적화.
*   **[소스 5] 정책브리핑 (내 돈 찾아먹기 / Welfare)**
    *   **방식:** `RSS` (http://www.korea.kr/rss/policy.xml)
    *   **내용:** 정부 보조금, 청년 지원금, 세금 환급 등 정책 뉴스. 높은 체류 시간과 스크랩을 유도하는 에버그린 콘텐츠.
*   **[소스 6] 뽐뿌 정보/강좌 게시판 (스마트 컨슈머)**
    *   **방식:** `HTML 크롤링 (Cheerio)` (ppomppu.co.kr/zboard/zboard.php?id=etc_info)
    *   **내용:** 핫딜이 아닌 "오래 두고 보는" 실생활 꿀팁, 가성비 노하우. (예: 스마트폰 요금제 절약법, 자동차 연비 팁)

### 3. 바이럴 & 가십 (Viral & Entertainment)
*   **[소스 7] FMKorea Best (펨코 포텐)**
    *   **방식:** `HTML 크롤링 (Cheerio)` (fmkorea.com/best2)
    *   **내용:** 현재 인터넷 커뮤니티에서 가장 많이 공유되고 있는 유머, 밈(Meme), 화제성 짤방 등.

---

## 🇺🇸 미국 (US) 데이터 소스 (총 7개)

### 1. 실시간 대중 관심사 (Mass Trend)
*   **[소스 1] Google Trends (US)**
    *   **방식:** `RSS` (https://trends.google.com/trending/rss?geo=US)
    *   **내용:** 미국 내 실시간 대규모 트래픽 발생 검색어. (스포츠, 정치, 글로벌 이슈)
*   **[소스 2] Reddit r/popular**
    *   **방식:** `JSON API` (Reddit API `/top.json?limit=10`)
    *   **내용:** 미국 최대 커뮤니티 레딧의 전체 화제글. 미국 대중의 실시간 관심사를 파악하는 핵심 소스.
*   **[소스 3] Yahoo News**
    *   **방식:** `RSS` (https://news.yahoo.com/rss/)
    *   **내용:** 미국 주요 속보, 경제 및 글로벌 헤드라인 뉴스.

### 2. 에버그린 및 실생활 정보 (Evergreen / Information)
*   **[소스 4] Reddit r/Scams (호구 방지 / Loss Aversion)**
    *   **방식:** `JSON API` (최근 24시간 내 가장 많은 추천을 받은 글)
    *   **내용:** Zelle 송금 사기, 페이스북 마켓플레이스 신종 사기, 가짜 아마존 이메일 수법 등 실생활 사기 예방 팁.
*   **[소스 5] Reddit r/povertyfinance (내 돈 찾아먹기 / Welfare)**
    *   **방식:** `JSON API` (최근 24시간 내 가장 많은 추천을 받은 글)
    *   **내용:** 마트 식비 절약법, 무료 인터넷 혜택, 정부 보조금 받는 방법 등 미국 서민들의 생존 꿀팁.
*   **[소스 6] Reddit r/Frugal (스마트 컨슈머)**
    *   **방식:** `JSON 기PI` (최근 24시간 내 가장 많은 추천을 받은 글)
    *   **내용:** 구독료 취소 팁, 오래 쓰는 물건(BIFL) 추천, 알뜰한 생활 습관 등 시간이 지나도 검색되는 스마트 소비 가이드.

### 3. 바이럴 & 가십 (Viral & Entertainment)
*   **[소스 7] BuzzFeed Trending**
    *   **방식:** `RSS` (https://www.buzzfeed.com/trending.xml)
    *   **내용:** 할리우드 가십, 틱톡에서 난리 난 생활 꿀팁, 심리 테스트 등 미국 내에서 바이럴되는 가벼운 엔터테인먼트 콘텐츠.

---

## 📌 데이터 수집 및 파싱 기술 요약

| 분류 | 사용 기술 | 비고 |
| :--- | :--- | :--- |
| **JSON API** | `axios.get` | Reddit, Nate, Signal.bz 등. 서버 부하가 적고 파싱이 빠르며 가장 안정적임. |
| **RSS Feed** | `xml2js` 파서 | Google Trends, Yahoo News, Policy Briefing 등. 구조화된 XML을 JSON 객체로 변환하여 사용. |
| **Web Crawling** | `cheerio`, `iconv-lite` | FSS, Ppomppu, FMKorea 등. API나 RSS를 제공하지 않는 사이트의 HTML DOM 구조를 직접 분석하여 긁어옴. 한글 인코딩(EUC-KR) 처리 포함. |

**💡 개발자 노트:**
* 모든 소스는 `fetchWithRetry` 헬퍼 함수를 통해 래핑되어 있어 일시적인 네트워크 오류 발생 시 자동 재시도합니다.
* Reddit 데이터의 경우 단순 최신 글이 아닌 `t=day` 파라미터를 사용하여 **최근 24시간 동안 가장 높은 추천(Score)을 받은 검증된 정보**만 선별적으로 가져오도록 설계되었습니다.