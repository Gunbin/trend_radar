# 🚀 TrendRadar 블로그 자동화 로드맵 (Phase 2)

## 📌 프로젝트 목표
실시간 트렌드 데이터를 수집하여, AI(Gemini)가 전문가급 블로그 포스팅을 기획하고 자동으로 Hugo 정적 사이트에 배포하는 완전 자동화 시스템 구축.

---

## 📅 단계별 실행 계획

### 1단계: 콘텐츠의 깊이 확보 (Deep Content Generation) ✅ (진행 중)
- [ ] **SEO 최적화 본문 생성:** H2, H3 태그 구조화 및 키워드 밀도 조절.
- [ ] **Hugo Front-matter 자동화:** 제목, 날짜, 태그, 카테고리, 슬러그 생성.
- [ ] **가독성 강화:** 표(Table), 리스트, 인용구(`>`) 등을 활용한 짜임새 있는 구성.

### 2단계: 비주얼 전략 (Visual & Media) 🕒 (예정)
- [ ] **AI 썸네일 생성:** 포스팅 주제에 맞는 독창적인 이미지 생성 연동.
- [ ] **이미지 SEO:** Unsplash API 연동 및 `alt` 태그 자동 생성.
- [ ] **반응형 미디어:** 본문 내 적절한 위치에 이미지 배치 로직 구현.

### 3단계: Hugo 워크플로우 통합 (Export to Hugo) 🕒 (예정)
- [ ] **자동 파일 시스템:** 생성된 마크다운을 Hugo `content/posts/` 경로에 자동 저장.
- [ ] **슬러그 최적화:** 한글 제목을 검색 친화적인 영어 슬러그로 변환.
- [ ] **로컬 빌드 테스트:** Hugo 서버에서 정상 렌더링 확인.

### 4단계: 완전 자동화 배포 (CI/CD Scheduler) 🕒 (예정)
- [ ] **배치 스케줄러:** 매일 정해진 시간(예: 오전 8시)에 자동 실행.
- [ ] **GitHub Actions 연동:** 생성된 파일을 자동으로 커밋/푸시하여 GitHub Pages 배포.
- [ ] **알림 시스템:** 포스팅 완료 후 슬랙(Slack)이나 텔레그램으로 결과 전송.

---

## 🛠 기술 스택
- **Engine:** Node.js (Express)
- **AI:** Gemini 3 Flash Preview (with Fallback to 2.5/2.0/1.5)
- **Frontend:** Vanilla JS + CSS (Cyberpunk Theme)
- **SSG:** Hugo (GitHub Pages Hosting)
- **Deployment:** GitHub Actions
