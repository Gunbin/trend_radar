import express from 'express';
import cors from 'cors';
import axios from 'axios';
import * as cheerio from 'cheerio';
import xml2js from 'xml2js';
import iconv from 'iconv-lite';
import { GoogleGenerativeAI } from "@google/generative-ai";
import 'dotenv/config';
import promptManager from './PromptManager.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import logger from './logger.js';
import { exec } from 'child_process';
import util from 'util';
import { v2 as cloudinary } from 'cloudinary';
import { gotScraping } from 'got-scraping';
import { google } from 'googleapis';

// Cloudinary Configuration: 폴백 시크릿 제거. 환경변수 누락 시 기동 단계에서 명확히 종료.
if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    logger.error('[Cloudinary] CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET 환경변수가 모두 필요합니다. .env 파일을 확인하세요.');
    process.exit(1);
}
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// === [v2.4] 운영 상수 ===
const COUPANG_AFFILIATE_ID = 'AF7891014';
const COUPANG_ELIGIBLE_CATEGORIES = ['Tech and IT', 'Finance', 'Life and Health'];
const PUBLISHED_INDEX_FILE = path.join(process.cwd(), 'published-index.json');
const PUBLISHED_INDEX_TTL_DAYS = 365;
const MODELS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6시간

// angleType 허용 값 (post_writing_* 템플릿 키 조회에 직접 사용되므로 화이트리스트 필수)
const ALLOWED_ANGLES = new Set(['expose', 'guide', 'compare']);
const DEFAULT_ANGLE = 'guide';

const FORMAT_MAP = {
    'expose-Snack':      '단문 팩트 나열 → 핵심 경고 → 행동지침 1~2개',
    'expose-Normal':     '[참고 방향] 리스크 원인 → 피해 시나리오 → 회피법 → FAQ. 순서 변경/섹션 통합/새 H2 이름 허용.',
    'expose-Deep-Dive':  '[참고 방향] 배경 → 심층 리스크 분석 → 케이스별 대응 → FAQ. 주제에 맞는 섹션 재구성 권장.',
    'guide-Snack':       '핵심 단계만 번호 목록 3~5개',
    'guide-Normal':      '[참고 방향] 준비물/전제 → 단계 가이드 → 막히는 지점 → FAQ. 단계 수/순서 유동 조정 가능.',
    'guide-Deep-Dive':   '[참고 방향] 개요 → 상세 단계 → 오류 대처법 → 고급 팁 → FAQ. 완수 가능성 기준으로 구조 설계.',
    'compare-Snack':     '비교표 1개 + 한줄 결론',
    'compare-Normal':    '[참고 방향] 평가기준 → 비교표 → 상황별 추천 → FAQ. 비교 기준 수/순서는 주제 맞춤.',
    'compare-Deep-Dive': '[참고 방향] 평가기준 가중치 → 항목별 비교 → 상황별 결론 → FAQ. 기계적 나열 금지.',
};

// === [v2.6] trend_analysis / manual_analysis 공통 응답 스키마 ===
// - 프롬프트의 format_rules(enum/ JSON 포맷 잔소리) 를 프롬프트에서 걷어내고 여기서 enforce
// - Google Search Grounding(useSearch=true)과는 동시 사용 제약이 있으므로 useSearch=false 경로에서만 적용
const ANALYSIS_RESPONSE_SCHEMA = {
    type: "object",
    properties: {
        blogPosts: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    trafficStrategy: {
                        type: "object",
                        properties: {
                            lifecycle: { type: "string", enum: ["Burst", "Evergreen"] },
                            targetAudience: { type: "string" }
                        },
                        required: ["lifecycle", "targetAudience"]
                    },
                    category: { type: "string", enum:["Tech and IT", "Finance", "Life and Health", "Entertainment"] },
                    targetKeyword: { type: "string" },
                    mainKeyword: { type: "string" },
                    searchQueries: {
                        type: "object",
                        properties: {
                            news_main: { type: "string" },
                            news_sub: { type: "string" },
                            kin: { type: "string" }
                        },
                        required: ["news_main", "news_sub", "kin"]
                    },
                    angleType: { type: "string", enum:["expose", "guide", "compare"] },
                    searchIntent: { type: "string" },
                    contentDepth: { type: "string", enum:["Snack", "Bite-sized", "Normal", "Deep-Dive"] },
                    conclusionType: { type: "string", enum:["Q&A", "Summary", "CTA", "Thought"] },
                    shoppableKeyword: { type: "string", nullable: true },
                    coreFact: { type: "string" },
                    painScore: { type: "integer", minimum: 3, maximum: 15 },
                    viralTitles: {
                        type: "object",
                        properties: {
                            curiosity: { type: "string" },
                            dataDriven: { type: "string" },
                            solution: { type: "string" }
                        },
                        required: ["curiosity", "dataDriven", "solution"]
                    },
                    metaDescription: { type: "string" },
                    faq: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                q: { type: "string" },
                                a: { type: "string" }
                            },
                            required: ["q", "a"]
                        }
                    },
                    subTopics: { type: "array", items: { type: "string" } },
                    coreEntities: { type: "array", items: { type: "string" } },
                    seoKeywords: { type: "array", items: { type: "string" } },
                    lsiKeywords: { type: "array", items: { type: "string" } },
                    imageSearchKeywords: { type: "array", items: { type: "string" } },
                    coreMessage: { type: "string" }
                },
                required:[
                    "trafficStrategy", "category", "targetKeyword", "mainKeyword", "searchQueries", "angleType", "searchIntent",
                    "contentDepth", "conclusionType", "coreFact", "painScore", "viralTitles", "metaDescription",
                    "faq", "subTopics", "coreEntities", "seoKeywords", "imageSearchKeywords", "coreMessage"
                ]
            }
        }
    },
    required: ["blogPosts"]
};

// [v3.0] 검색 생존 점수: 측정 가능한 수치(searchVolume/competitionIndex/documentCount)만 사용
// 캘리브레이션 결과:
// - searchVolume=0 하드 게이트(유입 불가) 유지
// - known-good(예: 낮은 competitionIndex + 높은 searchVolume) 구조를 과도하게 강등하지 않도록 보정
function calcSeoViabilityScore(searchVolume, competitionIndex, documentCount) {
    const sv = typeof searchVolume === 'number' ? searchVolume : 0;
    const dc = typeof documentCount === 'number' ? documentCount : 0;
    const ci = typeof competitionIndex === 'number' ? competitionIndex : null;

    // Hard gate: 유입 0이면 어떤 경우에도 생존점수 0
    if (!sv || sv <= 0) return 0;

    let score = 0;

    // 수요(demand) 가중치 (max ~6)
    if (sv >= 300000) score += 6;
    else if (sv >= 100000) score += 5;
    else if (sv >= 50000) score += 4;
    else if (sv >= 10000) score += 3;
    else if (sv >= 1000) score += 2;
    else score += 1;

    // 경쟁 강도 절대값(문서수) (max ~5)
    if (dc < 3000) score += 5;
    else if (dc < 10000) score += 4;
    else if (dc < 50000) score += 3;
    else if (dc < 200000) score += 2;
    else if (dc < 600000) score += 1;

    // 비율(competitionIndex)은 보조로만(보너스/패널티)
    if (ci !== null) {
        if (ci < 0.2 && sv >= 50000) score += 2;         // rescue (known-good 패턴)
        else if (ci < 0.35) score += 1.5;
        else if (ci < 0.7) score += 1;
        else if (ci < 1.5) score += 0.5;
        else if (ci >= 20) score -= 2;
        else if (ci >= 10) score -= 1;

        // [v3.1] 저볼륨인데 고경쟁(비율 과열)인 경우 추가 패널티 (저볼륨+고경쟁 secondary 누수 방지)
        if (sv < 2000 && ci > 3.0) score -= 2;
    }

    return Math.max(0, score);
}

// [v2.9] 기획안 품질 분류 — 하드게이트 + seoViabilityScore 기반 태깅
function annotateAnalysisPriority(analysisResult, options = {}) {
    if (!analysisResult || !Array.isArray(analysisResult.blogPosts)) return analysisResult;
    const COMPETITION_HARD_LIMIT = 3.0;
    const burstHardFilterEnabled = options?.burstHardFilterEnabled !== false;

    for (const post of analysisResult.blogPosts) {
        const painScore = Number.isInteger(post.painScore) ? post.painScore : null;
        const compIdx = typeof post.competitionIndex === 'number' ? post.competitionIndex : null;
        const searchVolume = typeof post.searchVolume === 'number' ? post.searchVolume : null;
        const documentCount = typeof post.documentCount === 'number' ? post.documentCount : null;
        const sv = typeof searchVolume === 'number' ? searchVolume : 0;
        const seoViabilityScore = calcSeoViabilityScore(sv, compIdx, documentCount);

        let priority = 'review';
        let reason = '';

        if (sv === 0) {
            priority = 'review';
            reason = '⚠️ 검색량 0 — 가짜 0(Fake Zero)일 수 있으나 검토 요망';
            logger.warn(`[Analysis] ⚠ "${post.mainKeyword || '(no keyword)'}" — searchVolume=0`);
        } else if (burstHardFilterEnabled && post.trafficStrategy?.lifecycle === 'Burst') {
            priority = 'review';
            reason = '🚫 Burst — 신생 블로그 노출 지연으로 자동 제외';
        } else if (painScore === null) {
            priority = 'review';
            reason = 'painScore 누락';
        } else if (compIdx !== null && compIdx > COMPETITION_HARD_LIMIT) {
            if (seoViabilityScore >= 7) {
                priority = 'secondary';
                reason = `⚠️ 경쟁 과열 선행 차단 (competitionIndex ${compIdx})`;
            } else {
                priority = 'review';
                reason = `⚠️ 경쟁 과열 선행 차단 + 생존점수 낮음 (competitionIndex ${compIdx})`;
            }
        } else if (seoViabilityScore >= 8) {
            priority = 'primary';
            reason = `✅ SEO 생존 점수 우수 (seoViabilityScore ${seoViabilityScore})`;
        } else if (seoViabilityScore >= 5) {
            priority = 'secondary';
            reason = `ℹ️ SEO 생존 점수 보통 (seoViabilityScore ${seoViabilityScore})`;
        } else if ((painScore ?? 0) < 6) {
            priority = 'review';
            reason = `painScore=${painScore} — 페인 약함`;
        } else {
            priority = 'review';
            reason = `seoViabilityScore=${seoViabilityScore} — 유입 잠재력 낮음`;
        }

        post._meta = {
            priority,
            reason,
            painScore,
            modelPainScore: painScore,
            seoViabilityScore,
            competitionIndex: compIdx,
            searchVolume,
            documentCount
        };
    }

    return analysisResult;
}

const execPromise = util.promisify(exec);

const app = express();
app.use(cors());
app.use(express.json()); 
app.use(express.static('public'));

// Request Logger
app.use((req, res, next) => {
    logger.api(`${req.method} ${req.originalUrl}`);
    next();
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- Dynamic Model Fetcher ---
let cachedModels = null;
let cachedModelsAt = 0;
async function getBestModels() {
    if (cachedModels && (Date.now() - cachedModelsAt) < MODELS_CACHE_TTL_MS) return cachedModels;

    const apiKey1 = process.env.GEMINI_API_KEY;
    const apiKey2 = process.env.GEMINI_API_KEY_2;
    const keysToTry = [apiKey1, apiKey2].filter(Boolean);

    for (const key of keysToTry) {
        try {
            const response = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
            
            let models = response.data.models
                .map(m => m.name.replace('models/', ''))
                // 텍스트/채팅을 지원하는 모델만 필터링 (음성, 임베딩, 이미지, 특정 목적 모델 제외)
                .filter(name => name.startsWith('gemini') || name.startsWith('gemma'))
                .filter(name => !name.includes('tts') && !name.includes('embedding') && !name.includes('audio') && 
                                !name.includes('vision') && !name.includes('image') && !name.includes('robotics') && 
                                !name.includes('computer-use') && !name.includes('research'));

            // 똑똑한 순서(지능 및 버전)로 정렬하기 위한 휴리스틱 스코어링
            const getScore = (name) => {
                let score = 0;
                
                // 1. 모델 등급 (Pro > Flash > Gemma)
                if (name.includes('pro')) score += 1000;
                else if (name.includes('flash')) score += 500;
                else if (name.includes('gemma')) score += 100;
                
                // Lite는 동일 등급에서 약간 감점
                if (name.includes('lite')) score -= 50;
                
                // 2. 버전 넘버링 (예: 3.1, 3.0, 2.5, 2.0) - 높을수록 가점
                const vMatch = name.match(/(\d+\.\d+|\d+)/);
                if (vMatch) {
                    score += parseFloat(vMatch[1]) * 10;
                }
                
                // 3. 안정성 (latest 우대, preview 약간 감점)
                if (name.includes('latest')) score += 5;
                if (name.includes('preview')) score -= 2;

                return score;
            };

            // 점수 내림차순(가장 똑똑한 모델이 0번 인덱스) 정렬
            models.sort((a, b) => getScore(b) - getScore(a));
            
            // 모든 가용 모델 캐싱 (slice 제거)
            cachedModels = models;
            cachedModelsAt = Date.now();
            logger.info(`[System] Dynamically loaded ${cachedModels.length} models (TTL 6h). Highest intelligence: ${cachedModels[0]}`);
            return cachedModels.slice(0, 10);

        } catch (error) {
            logger.warn(`[System] Failed to fetch models dynamically with a key: ${error.message}`);
            continue;
        }
    }
    
    logger.error("[System] Failed to fetch models dynamically with all API keys. Failing explicitly.");
    return [];
}

// [Step 1용] 가벼운 모델 우선 추출
async function getLiteModels() {
    const top10 = await getBestModels(); 
    const models = cachedModels || top10;
    // lite 가 포함되거나 8b(가장 가벼운 체급), gemma(경량 모델) 필터링
    const liteList = models
        .filter(name => name.includes('lite') || name.includes('8b') || name.includes('gemma'))
        .reverse(); // 뒤에 있는 것들이 보통 더 가벼움
    
    // 만약 리스트가 비어있으면 상위 모델 중 뒤에 있는 것들 폴백
    return liteList.length > 0 ? liteList : [...top10].reverse();
}

const shouldSkipModel = (apiName, modelName) => {
    if (apiName !== 'API_1') return false;
    const vMatch = modelName.match(/(\d+\.\d+|\d+)/);
    return vMatch && parseFloat(vMatch[1]) < 3 && modelName.includes('flash');
};

// --- Translation Helper (For better image search) ---
async function translateToEnglish(keyword) {
  if (!keyword || keyword.trim() === '') return 'abstract';
  
  // Rate Limit (429) 에러 방지를 위해 번역 시도 전 3초 대기
  await new Promise(resolve => setTimeout(resolve, 3000));

  const prompt = `Translate the following Korean blog keyword into a simple, clear English search term for an image database (like Pexels/Pixabay). Output ONLY the English words, no punctuation or extra text. Keyword: "${keyword}"`;
  
  // getBestModels()를 통해 가용한 최적의 모델 목록을 가져와 순회
  const models = await getBestModels();
  
  const apiKey1 = process.env.GEMINI_API_KEY;
  const apiKey2 = process.env.GEMINI_API_KEY_2;
  const apis = [
      { name: 'API_1', key: apiKey1 },
      { name: 'API_2', key: apiKey2 }
  ].filter(api => api.key);

  for (const api of apis) {
      const currentGenAI = new GoogleGenerativeAI(api.key);
      let success = false;
      
      for (const modelName of models) {
        if (shouldSkipModel(api.name, modelName)) {
            logger.process(`[Translation] [${api.name}] Model ${modelName} is flash and version < 3. Switching to API_2 after 3s...`);
            await new Promise(r => setTimeout(r, 3000));
            break; // Skip to next API
        }
        
        try {
          const model = currentGenAI.getGenerativeModel({ 
              model: modelName,
              generationConfig: {
                  temperature: 0.7,
                  topP: 0.85
              }
          });
          const result = await model.generateContent(prompt);
          const response = await result.response;
          let translated = response.text().trim().replace(/["'.]/g, '');
          
          if (translated) {
            return translated;
          }
        } catch (error) {
          logger.error(`[Translation] [${api.name}] Model ${modelName} failed: ${error.message}`);
          // 실패 시 다음 모델로 넘어가서 재시도
        }
      }
  }

  // 모든 모델이 실패한 경우 원본 키워드를 반환
  logger.error('Translation Error: All dynamic models failed to translate.');
  return keyword;
}

// --- Image Fetchers ---

// 1. Pexels (Photos)
async function getPexelsImage(keyword) {
  logger.api(`[Fetch] Requesting Pexels Image for "${keyword}"`);
  const startTime = Date.now();
  try {
    const res = await axios.get(`https://api.pexels.com/v1/search?query=${encodeURIComponent(keyword)}&per_page=10`, {
      headers: { 'Authorization': process.env.PEXELS_API_KEY }
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    if (res.data.photos && res.data.photos.length > 0) {
      const randomIndex = Math.floor(Math.random() * Math.min(res.data.photos.length, 5));
      logger.success(`[Fetch] Completed Pexels Image (${elapsed}s)`);
      return res.data.photos[randomIndex].src.landscape;
    }
    logger.warn(`[Fetch] Completed Pexels Image (${elapsed}s) - No results`);
  } catch (error) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.error(`[Fetch] Pexels API Error (${elapsed}s)`, error.message);
  }
  return null;
}

// 2. Pixabay (Photos, Illustrations, Vectors)
async function getPixabayImage(keyword, type = 'all', usedUrls = new Set()) {
  if (!process.env.PIXABAY_API_KEY) return null;
  logger.api(`[Fetch] Requesting Pixabay Image (${type}) for "${keyword}"`);
  const startTime = Date.now();
  try {
    const res = await axios.get(`https://pixabay.com/api/`, {
      params: {
        key: process.env.PIXABAY_API_KEY,
        q: keyword,
        image_type: type,
        per_page: 30, // 후보군을 30개로 확장하여 중복 확률을 낮춤
        safesearch: 'true'
      }
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    if (res.data.hits && res.data.hits.length > 0) {
      // 섞인 후보군 생성
      const candidates = [...res.data.hits].sort(() => Math.random() - 0.5);
      for (const hit of candidates) {
        const url = hit.webformatURL;
        // 아직 본문에 사용되지 않은 신선한 URL만 선택
        if (!usedUrls.has(url)) {
          usedUrls.add(url); // 선택됨과 동시에 사용 목록에 기록
          logger.success(`[Fetch] Completed Pixabay Image (${elapsed}s)`);
          return url;
        }
      }

      // 만약 30장이 전부 다 쓰였다면 (극히 드문 경우), 어쩔 수 없이 첫 번째 이미지를 반환
      const fallbackUrl = res.data.hits[0].webformatURL;
      usedUrls.add(fallbackUrl);
      logger.success(`[Fetch] Completed Pixabay Image (${elapsed}s) - Fallback Used`);
      return fallbackUrl;
    }

    logger.warn(`[Fetch] Completed Pixabay Image (${elapsed}s) - No results`);
    // Fallback: If no results, try searching with only the first two words
    const simplified = keyword.split(' ').slice(0, 2).join(' ');
    if (simplified !== keyword) {
      return await getPixabayImage(simplified, type, usedUrls);
    }
  } catch (error) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.error(`[Fetch] Pixabay API Error (${elapsed}s)`, error.message);
  }
  return null;
}

// 3. Openverse (Creative Commons)
async function getOpenverseImage(keyword) {
  logger.api(`[Fetch] Requesting Openverse Image for "${keyword}"`);
  const startTime = Date.now();
  try {
    const res = await axios.get(`https://api.openverse.org/v1/images/`, {
      params: { 
        q: keyword, 
        categories: 'illustration,digitized_artwork', // Cartoons, illustrations, and digital art
        extension: 'jpg,png',       // Only common web formats
        page_size: 10 
      },
      headers: { 'User-Agent': 'TrendRadar/1.0' }
    });
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    if (res.data.results && res.data.results.length > 0) {
      // Shuffle the results to get a random one, but try multiple if some are broken
      const results = res.data.results.sort(() => Math.random() - 0.5);
      
      for (const item of results) {
        const imageUrl = item.thumbnail;
        if (!imageUrl) continue;
        
        try {
          // Verify if the image is actually accessible
          await axios.head(imageUrl, { 
            timeout: 3000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
          });
          logger.success(`[Fetch] Completed Openverse Image (${elapsed}s)`);
          return imageUrl; // Valid image found
        } catch (imgError) {
          logger.warn(`[Fetch] Openverse Image Broken (Skipping): ${imageUrl}`);
          continue; // Try the next one
        }
      }
    }
    logger.warn(`[Fetch] Completed Openverse Image (${elapsed}s) - No valid results`);
  } catch (error) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.error(`[Fetch] Openverse API Error (${elapsed}s)`, error.message);
  }
  return null;
}

// === [v2.6] References URL 검증 & 도메인 루트 자동 축약 ===
// - Gemini 가 상상으로 생성한 deep-link (예: article id 가 있는 긴 URL) 가 404 를 내는 것을 방지.
// - <small>...<i>[References] ...</i></small> 블록 안의 마크다운 링크만 대상으로 한다 (본문 링크는 건드리지 않음).
// - 동작 규칙:
//     1) URL 에 HEAD 요청 → 2xx/3xx 면 그대로 유지
//     2) 실패하면 도메인 루트(`new URL(url).origin`) 로 축약 후 재검증
//     3) 도메인 루트도 실패하면 마크다운 링크를 제거하고 표시명 텍스트만 남김
//     4) 한 참조에 들어가는 시간은 최대 ~ (HEAD timeout + root timeout) 이며, 모든 참조 검증은 Promise.all 병렬
async function verifyUrl(url, timeoutMs = 5000) {
    try {
        // HEAD 시도 (가장 빠름, 일부 서버는 405 반환)
        const res = await axios.head(url, {
            timeout: timeoutMs,
            maxRedirects: 5,
            validateStatus: s => s >= 200 && s < 400,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TrendRadar/2.6; +https://github.com/)' }
        });
        return res.status >= 200 && res.status < 400;
    } catch (headErr) {
        // HEAD 차단/405 인 경우 GET 으로 한 번 더 시도 (응답 본문은 안 받음)
        try {
            const res = await axios.get(url, {
                timeout: timeoutMs,
                maxRedirects: 5,
                validateStatus: s => s >= 200 && s < 400,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; TrendRadar/2.6; +https://github.com/)'
                }
            });
            return res.status >= 200 && res.status < 400;
        } catch {
            return false;
        }
    }
}

async function verifyAndFixReferences(markdown) {
    if (!markdown || typeof markdown !== 'string') return markdown;

    // 1) [References] 섹션 추출 (<small>...<i>...</i></small> 형태)
    //    - 모델이 <br> 위치를 살짝 다르게 쓸 수 있으므로 유연하게 매칭
    const refBlockRegex = /(?:<small>[\s\S]*?<i>[\s\S]*?\[References\][\s\S]*?<\/i>[\s\S]*?<\/small>|###\s*\[References\][\s\S]*?(?=\n#|$))/i;
    const match = markdown.match(refBlockRegex);
    if (!match) return markdown; // References 섹션 없음 → 원본 그대로

    const originalBlock = match[0];
    const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

    const linkMatches = [...originalBlock.matchAll(linkRegex)];
    if (linkMatches.length === 0) return markdown;

    // 2) 각 URL 병렬 검증 후 치환 계획 수립
    const resolutions = await Promise.all(linkMatches.map(async (m) => {
        const [whole, label, url] = m;
        try {
            const okOriginal = await verifyUrl(url);
            if (okOriginal) {
                return { whole, replacement: whole, status: 'kept' };
            }

            // 도메인 루트로 축약 후 재검증
            let rootUrl;
            try {
                rootUrl = new URL(url).origin;
            } catch {
                rootUrl = null;
            }

            if (rootUrl && rootUrl !== url) {
                const okRoot = await verifyUrl(rootUrl);
                if (okRoot) {
                    return { whole, replacement: `[${label}](${rootUrl})`, status: 'shrunk-to-root', from: url, to: rootUrl };
                }
            }

            // 도메인 루트도 실패해도 링크는 유지 (false negative 방지)
            // 사용자가 브라우저에서 접근 가능한 경우가 있어 링크 삭제 대신 원본 보존
            return { whole, replacement: whole, status: 'kept-on-fail', from: url };
        } catch (err) {
            // 예기치 못한 오류는 원본 유지
            return { whole, replacement: whole, status: 'error', error: err.message };
        }
    }));

    // 3) 블록 내에서만 치환 (본문 링크는 절대 건드리지 않도록 블록 단위 replace)
    let fixedBlock = originalBlock;
    for (const r of resolutions) {
        // whole 이 동일 블록 안에 유일하도록 마크다운 특성상 거의 문제 없음.
        // 그래도 안전을 위해 첫 1회만 치환.
        fixedBlock = fixedBlock.replace(r.whole, r.replacement);
    }

    // 4) 로그 남기기 (변경된 것만)
    const changed = resolutions.filter(r => r.status !== 'kept' && r.status !== 'error');
    if (changed.length > 0) {
        for (const r of changed) {
            if (r.status === 'shrunk-to-root') {
                logger.warn(`[References] Dead deep-link → 도메인 루트 축약: ${r.from} → ${r.to}`);
            } else if (r.status === 'kept-on-fail') {
                logger.warn(`[References] URL 검증 실패 (루트도 실패) → 원본 링크 유지: ${r.from}`);
            }
        }
    } else {
        logger.process(`[References] 모든 URL 검증 통과 (${resolutions.length}건)`);
    }

    // 5) 전체 마크다운에서 블록 교체
    return markdown.replace(originalBlock, fixedBlock);
}

// [v2.9] Mermaid/Markmap shortcode 오출력 자동 교정
// 모델이 {{< sequenceDiagram >}} ... {{< /sequenceDiagram >}} 형태를 내보내면
// Hugo가 shortcode로 해석해 빌드가 깨지므로 fenced code block으로 강제 변환한다.
function normalizeDiagramShortcodes(markdown) {
    if (!markdown || typeof markdown !== 'string') return markdown;

    const diagramTypes = new Set([
        'flowchart',
        'sequenceDiagram',
        'stateDiagram-v2',
        'gantt',
        'timeline',
        'pie',
        'journey',
        'classDiagram',
        'erDiagram',
        'gitGraph'
    ]);

    const shortcodeRegex = /\{\{<\s*([a-zA-Z0-9_-]+)\s*>\}\}\s*([\s\S]*?)\s*\{\{<\s*\/\s*\1\s*>\}\}/g;
    return markdown.replace(shortcodeRegex, (_full, rawType, rawBody) => {
        const type = String(rawType || '').trim();
        const body = String(rawBody || '').trim();

        if (type === 'markmap') {
            return `\`\`\`markmap\n${body}\n\`\`\``;
        }

        if (!diagramTypes.has(type)) {
            return _full; // tip/warning/info 등 기존 shortcode는 그대로 유지
        }

        if (body.startsWith(type)) {
            return `\`\`\`mermaid\n${body}\n\`\`\``;
        }
        return `\`\`\`mermaid\n${type}\n${body}\n\`\`\``;
    });
}

// [v2.9] Mermaid sequence 문법 안전화
// 운영 중 모델 출력 편차로 인한 syntax error를 줄이기 위해
// sequenceDiagram 블록의 민감 토큰을 보수적으로 정규화한다.
function sanitizeMermaidBlocks(markdown) {
    if (!markdown || typeof markdown !== 'string') return markdown;

    const mermaidBlockRegex = /```mermaid\s*\n([\s\S]*?)```/g;
    return markdown.replace(mermaidBlockRegex, (_full, rawBody) => {
        let body = String(rawBody || '').trim();
        if (!body) return _full;

        if (body.startsWith('sequenceDiagram')) {
            const lines = body.split('\n').map((line) => {
                let l = line;

                // cross arrow는 런타임 파서 에러를 자주 유발해 안전한 dashed arrow로 교체
                l = l.replace(/--x/g, '-->>');

                // participant 별칭은 특수문자를 제거해 파서 안정성 강화
                l = l.replace(/^(\s*participant\s+\w+\s+as\s+)(.+)$/u, (_m, prefix, label) => {
                    const safeLabel = String(label)
                        .replace(/^["']|["']$/g, '')
                        .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                    return `${prefix}${safeLabel || 'Participant'}`;
                });

                // message 텍스트의 고위험 특수문자 축소
                l = l.replace(/^(\s*\w+\s*[-.]+>{1,2}\s*\w+\s*:\s*)(.+)$/u, (_m, prefix, msg) => {
                    const safeMsg = String(msg)
                        .replace(/[^\p{L}\p{N}\s.,!?-]/gu, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                    return `${prefix}${safeMsg || 'message'}`;
                });

                return l;
            });
            body = lines.join('\n');
        }

        return `\`\`\`mermaid\n${body}\n\`\`\``;
    });
}

// --- Cloudinary Upload Helper ---
async function uploadToCloudinary(url) {
  if (!url) return null;
  logger.api(`[Cloudinary] Upload 요청: ${url.substring(0, 50)}...`);
  const startTime = Date.now();
  try {
      // 1. Download image to buffer to avoid Cloudinary fetching it directly and hitting Rate Limits (429)
      const response = await axios.get(url, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data, 'binary');

      // 2. Upload to Cloudinary via stream
      const uploadResult = await new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
              { folder: 'blogAutoPosting' },
              (error, result) => {
                  if (error) reject(error);
                  else resolve(result);
              }
          );
          uploadStream.end(buffer);
      });

      const optimizeUrl = stripCloudinaryQuery(cloudinary.url(uploadResult.public_id, {
          fetch_format: 'auto',
          quality: 'auto'
      }));
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      logger.success(`[Cloudinary] Upload 완료 (${elapsed}s) -> ${optimizeUrl}`);
      return optimizeUrl;
  } catch (error) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      logger.error(`[Cloudinary] Upload 실패 (${elapsed}s)`, error.message);
      return url; // 실패 시 원본 URL 폴백
  }
}

// --- Master Image Dispatcher ---
async function getRandomImage(keyword, isThumbnail = false, skipTranslation = false, usedUrls = new Set()) {
  // 포스팅 생성 시에는 원본 CDN URL을 반환하여 Cloudinary 용량을 아낍니다.
  // 실제 업로드(save local, push to github) 시점에 일괄 변환합니다.
  const rawUrl = await getRawRandomImage(keyword, isThumbnail, skipTranslation, usedUrls);
  return rawUrl;
}

async function getRawRandomImage(keyword, isThumbnail = false, skipTranslation = false, usedUrls = new Set()) {
  let searchQuery = keyword;
  if (Array.isArray(keyword)) {
    searchQuery = keyword[Math.floor(Math.random() * keyword.length)];
  }
  
  // 번역 추가! (skipTranslation이 true면 건너뜀)
  if (!skipTranslation) {
    searchQuery = await translateToEnglish(searchQuery);
  }

  logger.process(`[Image Search] Query: ${searchQuery} (${isThumbnail ? 'Thumbnail' : 'Body'})`);

  let imageUrl = null;
  
  // 1순위: 카툰풍/일러스트 이미지 (Pixabay, Openverse)
  const primarySources = [
    () => getPixabayImage(searchQuery, 'illustration', usedUrls),
    () => getPixabayImage(searchQuery, 'vector', usedUrls),
    () => getOpenverseImage(searchQuery)
  ];

  const shuffledPrimary = primarySources.sort(() => Math.random() - 0.5);

  for (const fetcher of shuffledPrimary) {
    imageUrl = await fetcher();
    if (imageUrl) {
      logger.success(`[Illustration Found] for "${searchQuery}"`);
      return imageUrl;
    }
  }

  // 2순위 폴백: 일러스트를 찾지 못했을 때 Pexels 실사 이미지 사용
  logger.warn(`[Image Search] No illustration found for "${searchQuery}". Trying Pexels (Photo)...`);
  imageUrl = await getPexelsImage(searchQuery);
  if (imageUrl) {
      logger.success(`[Photo Found] Pexels fallback successful for "${searchQuery}"`);
      return imageUrl;
  }

  // 3순위 폴백: 특정 키워드로 모든 API 실패 시, 범용적인 추상 배경(일러스트) 검색
  logger.warn(`[Image Search] No specific image found. Trying generic illustration fallback...`);
  const fallbackSources = [
    () => getPixabayImage('abstract pattern', 'vector', usedUrls),
    () => getOpenverseImage('abstract')
  ];

  for (const fetcher of fallbackSources.sort(() => Math.random() - 0.5)) {
    imageUrl = await fetcher();
    if (imageUrl) {
      logger.success(`[Image Found] Generic illustration fallback retrieved successfully.`);
      return imageUrl;
    }
  }

  // Final Fallback: 모든 API 실패 (Rate Limit, Network Error 등) 시 사용할 최후의 하드코딩 URL
  logger.error(`[Image Search] All API fetchers failed. Using hardcoded fallback URL.`);
  return 'https://images.unsplash.com/photo-1557682250-33bd709cbe85?w=640&q=80';
}

// === [v2.4] Slug / Index / Internal Link / Coupang / Tag Helpers ===

function sanitizeSlug(input) {
    if (!input) return '';
    return String(input)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);
}

function makeUniqueSlug(slugCandidate, fallbackCandidate, contextSeed) {
    const cleaned = sanitizeSlug(slugCandidate) || sanitizeSlug(fallbackCandidate) || 'post';
    // published-index 에 동일 slug 가 없으면 깔끔한 슬러그 그대로 사용
    try {
        const existing = readPublishedIndex().map(e => e && e.slug).filter(Boolean);
        if (!existing.includes(cleaned)) return cleaned;
    } catch (_) { /* 인덱스 조회 실패 시엔 fallback 로 내려감 */ }
    // 충돌 시에만 날짜 suffix (YYYYMMDD) 부여. 같은 날 두 번 이상 발생하면 md5 hash 로 최후 fallback.
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const withDate = `${cleaned}-${datePart}`;
    try {
        const existing = readPublishedIndex().map(e => e && e.slug).filter(Boolean);
        if (!existing.includes(withDate)) return withDate;
    } catch (_) { /* noop */ }
    const hash = crypto
        .createHash('md5')
        .update(`${contextSeed || ''}|${Date.now()}|${Math.random()}`)
        .digest('hex')
        .slice(0, 4);
    return `${cleaned}-${hash}`;
}

function readPublishedIndex() {
    try {
        if (!fs.existsSync(PUBLISHED_INDEX_FILE)) return [];
        const raw = fs.readFileSync(PUBLISHED_INDEX_FILE, 'utf8').trim();
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch (e) {
        logger.warn(`[Index] Read failed: ${e.message}`);
        return [];
    }
}

function prunePublishedIndex(arr) {
    const cutoff = Date.now() - PUBLISHED_INDEX_TTL_DAYS * 24 * 60 * 60 * 1000;
    return arr.filter(item => {
        const t = item && item.publishedAt ? new Date(item.publishedAt).getTime() : NaN;
        return Number.isFinite(t) && t >= cutoff;
    });
}

function writePublishedIndex(arr) {
    try {
        fs.writeFileSync(PUBLISHED_INDEX_FILE, JSON.stringify(arr, null, 2), 'utf8');
    } catch (e) {
        logger.error(`[Index] Write failed: ${e.message}`);
    }
}

function appendPublishedIndex(entry) {
    let arr = readPublishedIndex();
    arr = prunePublishedIndex(arr);
    // 동일 slug 중복 방지: 기존 항목 제거 후 새로 append
    arr = arr.filter(it => it.slug !== entry.slug);
    arr.push(entry);
    writePublishedIndex(arr);
    logger.success(`[Index] Saved (${arr.length} entries, pruned >${PUBLISHED_INDEX_TTL_DAYS}d)`);
}

function buildRecentKeywordsContext(lang) {
    const arr = prunePublishedIndex(readPublishedIndex()).filter(it => it.lang === lang);
    if (!arr.length) return '';
    // 슬러그를 포함하여 어떤 맥락으로 쓰여졌는지 AI가 유추할 수 있도록 힌트 제공
    const lines = arr.slice(-50).map(it => `- 키워드: ${it.mainKeyword} / 앵글: ${it.angleType || '미상'} (주제 힌트: ${it.slug})`).join('\n');
    return lang === 'ko'
        ? `\n\n[최근 30일 발행 이력 (중복 및 유사 주제 절대 금지)]\n${lines}\n`
        : `\n\n[Published in the last 30 days (STRICTLY DO NOT repeat or paraphrase these topics)]\n${lines}\n`;
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 지역명/광의 단어 블랙리스트 — 이런 단어로는 절대 인터널 링크 걸지 않음
// (예: '경기도' 가 '청년 월세 지원 가이드' 글에 링크되는 엉뚱한 매칭 방지)
const INTERNAL_LINK_BLACKLIST = new Set([
    // 광역 지역명
    '서울', '부산', '인천', '대구', '대전', '광주', '울산', '세종',
    '경기도', '경기', '강원도', '강원', '충청북도', '충청남도', '충북', '충남',
    '전라북도', '전라남도', '전북', '전남', '경상북도', '경상남도', '경북', '경남', '제주도', '제주',
    // 정부/기관 총칭
    '정부', '국가', '대한민국', '한국', '금융위원회', '금융감독원', '과학기술정보통신부',
    '문화체육관광부', '환경부', '기상청', '국세청', '보건복지부', '행정안전부',
    // 추상/광의 단어
    '정책', '뉴스', '정보', '이슈', '가이드', '방법', '추천', '소식', '최신'
]);

function injectInternalLinks(markdown, currentSlug, lang, baseUrl, currentTags = []) {
    const candidates = prunePublishedIndex(readPublishedIndex()).filter(it =>
        it.lang === lang &&
        it.slug !== currentSlug &&
        it.mainKeyword // 핵심 키워드 존재 여부 확인
    );
    if (!candidates.length) return markdown;

    // 상단 50% 분리
    const paragraphs = markdown.split(/\n\n+/);
    const splitIdx = Math.ceil(paragraphs.length / 2);
    const topHalf = paragraphs.slice(0, splitIdx).join('\n\n');
    const botHalf = paragraphs.slice(splitIdx).join('\n\n');

    const currentTagsLower = (Array.isArray(currentTags) ? currentTags : []).map(t => String(t).toLowerCase().trim());

    // 관련성 점수: 후보의 tags/mainKeyword 와 현재 글의 tags/mainKeyword 가 얼마나 겹치는지
    const scoreCandidate = (cand) => {
        let score = 0;
        const candTagsLower = (Array.isArray(cand.tags) ? cand.tags : []).map(t => String(t).toLowerCase().trim());
        // 태그 교집합 (1개당 +2점, 최대 6점)
        const tagOverlap = candTagsLower.filter(t => currentTagsLower.includes(t)).length;
        score += Math.min(tagOverlap, 3) * 2;
        // coreEntities 교집합은 작은 가중치
        const candEnt = (Array.isArray(cand.coreEntities) ? cand.coreEntities : []).map(s => String(s).toLowerCase().trim());
        const entOverlap = candEnt.filter(e => currentTagsLower.includes(e)).length;
        score += entOverlap;
        return score;
    };

    // 코드블록 / 인라인코드 / 이미지 / 기존 링크 / 마크다운 헤더(TOC 훼손 방지) 보호
    const protections = [];
    const stash = (str) => {
        const idx = protections.length;
        protections.push(str);
        return `\u0000P${idx}\u0000`;
    };
    let working = topHalf
        .replace(/```[\s\S]*?```/g, m => stash(m))
        .replace(/`[^`\n]+`/g, m => stash(m))
        .replace(/!\[[^\]]*\]\([^)]+\)/g, m => stash(m))
        .replace(/\[[^\]]+\]\([^)]+\)/g, m => stash(m))
        .replace(/^#+\s.+$/gm, m => stash(m)); // 헤더 보호 추가

    let injected = 0;
    const MAX_LINKS = 3;
    const linked = new Set();
    // 관련성 점수 내림차순 → 동점은 랜덤으로 섞어 다양성 확보
    const ranked = [...candidates]
        .map(c => ({ c, s: scoreCandidate(c), r: Math.random() }))
        .sort((a, b) => (b.s - a.s) || (a.r - b.r))
        .map(x => ({ ...x.c, _score: x.s }));

    for (const cand of ranked) {
        if (injected >= MAX_LINKS) break;

        // [의미 매칭 최소 조건]
        //  - 후보 글에 tags 가 저장돼 있으면: 현재 글의 태그와 최소 1개 교집합 필수
        //  - 후보 글에 tags 가 없으면(과거 데이터 하위호환): mainKeyword 완전 일치만 허용
        const candTagsLower = (Array.isArray(cand.tags) ? cand.tags : []).map(t => String(t).toLowerCase().trim());
        const hasTagOverlap = candTagsLower.some(t => currentTagsLower.includes(t));
        const mainKwMatch = currentTagsLower.includes(String(cand.mainKeyword || '').toLowerCase().trim());
        if (candTagsLower.length > 0) {
            if (!hasTagOverlap) continue;
        } else {
            if (!mainKwMatch) continue;
        }

        // 길이가 긴 단어부터 매칭하여 부분 치환 최소화 (형태소 분리 포함)
        const rawKeywords = [cand.mainKeyword, ...(cand.coreEntities || []), ...(cand.tags || [])]
            .filter(Boolean)
            .map(String)
            .map(s => s.trim());
            
        const expandedKeywords = [];
        for (const kw of rawKeywords) {
            expandedKeywords.push(kw);
            const parts = kw.split(' ');
            if (parts.length > 1) {
                expandedKeywords.push(...parts.filter(p => p.trim().length >= 2));
            }
        }

        const keywordsToTry = Array.from(new Set(expandedKeywords))
            .filter(s => s.length >= 2) // 형태소 2글자 이상 허용
            .filter(s => !INTERNAL_LINK_BLACKLIST.has(s)) // 광의/지역명 블랙리스트 차단
            .sort((a, b) => b.length - a.length);

        for (const ent of keywordsToTry) {
            if (injected >= MAX_LINKS) break;
            const ek = ent;
            if (linked.has(ek)) continue;

            // 한글/영문 등 텍스트 경계 고려: 단어의 시작부분에서만 매칭
            const re = new RegExp(`(^|[^가-힣a-zA-Z0-9])(${escapeRegex(ek)})`, 'i');
            if (!re.test(working)) continue;

            const langSegment = cand.lang === 'en' ? '/en' : '/ko';
            const url = `${baseUrl.replace(/\/$/, '')}${langSegment}/blog/${cand.slug}/`;

            working = working.replace(re, `$1[$2](${url})`);
            linked.add(ek);
            injected++;
            break; // 한 문서당 하나의 링크만 걸기
        }
    }

    // 보호 블록 복원
    working = working.replace(/\u0000P(\d+)\u0000/g, (_, i) => protections[Number(i)] || '');
    if (injected > 0) logger.success(`[InternalLinks] Injected ${injected} link(s) in top half`);
    
    return working + (botHalf ? '\n\n' + botHalf : '');
}

function buildCoupangBox(shoppableKeyword, category, lang) {
    if (lang !== 'ko') return '';
    if (!shoppableKeyword || shoppableKeyword.trim() === '' || shoppableKeyword.toLowerCase() === 'null') return '';
    if (!COUPANG_ELIGIBLE_CATEGORIES.includes(category)) return '';
    const q = encodeURIComponent(shoppableKeyword.trim());
    const url = `https://www.coupang.com/np/search?q=${q}&channel=affiliate&trackingCode=${COUPANG_AFFILIATE_ID}`;
    return [
        '',
        '---',
        '',
        '### 관련 상품 한눈에 보기',
        '',
        `[**쿠팡에서 "${shoppableKeyword.trim()}" 관련 상품 보러가기 →**](${url})`,
        '',
        '> 이 포스팅은 쿠팡 파트너스 활동의 일환으로, 일정액의 수수료를 제공받습니다.',
        ''
    ].join('\n');
}

function buildExpandedTags(postPlan) {
    const collected = [];
    const push = (v) => {
        if (!v) return;
        const s = String(v).trim().replace(/\s+/g, ' ');
        if (s.length < 2 || s.length > 30) return;
        if (collected.includes(s)) return;
        // 너무 일반적인 단어 차단 (확장 블랙리스트)
        if (/^(한국|오늘|뉴스|정보|이슈|정책|행사|이벤트|추천|가이드|정리|방법|최신|소식)$/i.test(s)) return;
        // substring 중복 제거: 이미 수집된 태그를 포함하거나, 그 태그에 포함되는 경우 skip
        // (예: '거문고자리 유성우' 이미 있는데 '4월 거문고자리 유성우' 들어오면 skip)
        if (collected.some(c => c.includes(s) || s.includes(c))) return;
        collected.push(s);
    };
    push(postPlan?.mainKeyword);
    if (Array.isArray(postPlan?.seoKeywords)) postPlan.seoKeywords.forEach(push);
    if (Array.isArray(postPlan?.lsiKeywords)) postPlan.lsiKeywords.slice(0, 3).forEach(push);
    if (Array.isArray(postPlan?.coreEntities)) postPlan.coreEntities.slice(0, 3).forEach(push);
    return collected.slice(0, 5);
}

function stripCloudinaryQuery(url) {
    if (!url || typeof url !== 'string') return url;
    if (!url.includes('res.cloudinary.com')) return url;
    return url.split('?')[0];
}

// 본문에서 Q&A 패턴 추출 → frontmatter faq: 배열 후보
function extractFaqFromMarkdown(markdown) {
    if (!markdown) return [];
    const faqs = [];
    // 패턴: "**Q. ...**" 다음 줄들에 "**A.** ..." 형태
    const re = /\*\*Q\.\s*([^*\n]+?)\*\*\s*\n+\*\*A\.\*\*\s*([\s\S]*?)(?=\n\s*\n\*\*Q\.|\n\s*\n#{1,6}\s|\n\s*---|\n*$)/g;
    let m;
    while ((m = re.exec(markdown)) !== null) {
        const q = m[1].trim();
        const a = m[2].trim().replace(/\s+/g, ' ');
        if (q && a) faqs.push({ q, a });
        if (faqs.length >= 6) break;
    }
    return faqs;
}

// --- API Fetch Retry Helper ---
async function fetchWithRetry(name, fetchFn, retries = 2) {
  logger.api(`[Fetch] Requesting: ${name}`);
  const startTime = Date.now();
  for (let i = 0; i <= retries; i++) {
    try {
      const data = await fetchFn();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      // 배열 형태면 length를, 아니면 success를 찍음
      const dataInfo = Array.isArray(data) ? `Extracted ${data.length} items` : 'Success';
      logger.success(`[Fetch] Completed: ${name} (Took ${elapsed}s, ${dataInfo})`);
      return data;
    } catch (error) {
      if (i < retries) {
        logger.warn(`[Fetch] Retry ${i+1}/${retries} for ${name}: ${error.message}`);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.error(`[Fetch] Failed: ${name} after ${elapsed}s`, error.message);
        return [];
      }
    }
  }
}

const SOURCE_ITEM_COUNTS = {
  ppomppu: 7,
  aha: 7,
  fss: 5,
  policy: 5,
  gNewsLabor: 7,
  gNewsBiz: 7,
  signal: 10,
  google: 10,
  reddit: 10,
  redditScams: 10,
  redditPoverty: 10,
  redditFrugal: 10,
  yahoo: 10,
  buzzfeed: 10
};

const GOOGLE_NEWS_BIZ_URL = 'https://news.google.com/rss/search?q=(자영업자+OR+소상공인)+(지원금+OR+혜택+OR+주의점+OR+세금)+-주가+-특징주+-주식+when:7d&hl=ko&gl=KR&ceid=KR:ko';
const GOOGLE_NEWS_LABOR_URL = 'https://news.google.com/rss/search?q=(근로기준법+OR+실업급여+OR+퇴직금)+(어떻게+OR+방법+OR+궁금증+OR+알아두면)+-주가+-특징주+-주식+when:7d&hl=ko&gl=KR&ceid=KR:ko';

function clampItemScale(raw) {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return 1.0;
  return Math.min(1.5, Math.max(0.5, n));
}

function getSourceLimit(sourceName, itemScale = 1.0) {
  const base = SOURCE_ITEM_COUNTS[sourceName] || 7;
  return Math.max(1, Math.round(base * itemScale));
}

function formatMetricsLine(kw, data, lang = 'ko') {
  const suggestions = (data.suggestions || []).join(', ') || (lang === 'en' ? 'none' : '없음');
  if (lang === 'en') {
    return `- keyword: ${kw} / searchVolume: ${data.searchVolume} / documentCount: ${data.documentCount} / competitionIndex: ${data.competitionIndex} / competitionLabel: ${data.competitionLabel || '⚪ Unmeasurable'} / relatedQueries(reference): ${suggestions}`;
  }
  return `- 키워드: ${kw} / 월간검색량: ${data.searchVolume} / 발행문서수: ${data.documentCount} / 경쟁지수: ${data.competitionIndex} / 경쟁강도: ${data.competitionLabel || '⚪ 측정불가'} / 연관검색어(참고): ${suggestions}`;
}

function attachCompetitionLabel(metric, lang = 'ko') {
  const idx = typeof metric?.competitionIndex === 'number' ? metric.competitionIndex : null;
  const sv = typeof metric?.searchVolume === 'number' ? metric.searchVolume : 0;

  if (idx === null || sv === 0) {
    metric.competitionLabel = lang === 'en' ? '⚪ Unmeasurable' : '⚪ 측정불가';
  } else if (idx < 0.5) {
    metric.competitionLabel = lang === 'en' ? '🟢 Blue Ocean' : '🟢 블루오션';
  } else if (idx < 2.0) {
    metric.competitionLabel = lang === 'en' ? '🟡 Moderate' : '🟡 경쟁보통';
  } else {
    metric.competitionLabel = lang === 'en' ? '🔴 Red Ocean' : '🔴 레드오션';
  }
  return metric;
}

// 1. Google Trends (US 전용)
async function getGoogleTrends(geo = 'US', limit = 10) {
  return fetchWithRetry('Google Trends', async () => {
    const res = await axios.get(`https://trends.google.com/trending/rss?geo=${geo}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(res.data);
    const items = (result.rss.channel[0].item || []).slice(0, limit);
    return items.map((item, i) => ({
      rank: i + 1,
      keyword: item.title[0],
      traffic: item['ht:approx_traffic'] ? item['ht:approx_traffic'][0] : 'N/A',
      image: item['ht:picture'] ? item['ht:picture'][0] : null,
      newsItems: item['ht:news_item'] ? item['ht:news_item'].map(ni => ({
        title: ni['ht:news_item_title'][0],
        url: ni['ht:news_item_url'][0],
        source: ni['ht:news_item_source'] ? ni['ht:news_item_source'][0] : 'News'
      })).slice(0, 2) : []
    }));
  });
}

// 2. Nate (한국 전용)
async function getSignalTrends(limit = 10) {
  return fetchWithRetry('Nate Trends', async () => {
    const res = await axios.get('https://www.nate.com/js/data/jsonLiveKeywordDataV1.js?v=' + new Date().getTime(), {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 3000
    });
    let text = iconv.decode(res.data, 'euc-kr');
    const match = text.match(/\[\[.*\]\]/);
    if (match) {
        const data = JSON.parse(match[0]); 
        return data.slice(0, limit).map((item, i) => ({
            rank: i + 1, keyword: item[1],
            status: item[2] === 's' ? 'SAME' : (item[2] === '+' ? 'UP' : 'DOWN'),
            change: item[3]
        }));
    }
    return [];
  });
}

// Google News RSS: 동일 피드(Biz 또는 Labor) 안에서만 제목 기준 중복 제거 (두 피드 간 교차 제거는 하지 않음)
function normalizeGoogleNewsTitleKey(rawTitle) {
  if (!rawTitle || typeof rawTitle !== 'string') return '';
  return rawTitle
    .replace(/ - .+$/, '')
    .replace(/[\s\u00a0\u3000]+/g, ' ')
    .replace(/[""''`]/g, '')
    .trim()
    .toLowerCase();
}

function dedupeGoogleNewsRssItems(sortedItems, limit) {
  const seen = new Set();
  const out = [];
  for (const item of sortedItems) {
    const key = normalizeGoogleNewsTitleKey(item.title?.[0] || '');
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

// 3. Google News (자영업/소상공인/세금)
async function getGoogleNewsBiz(limit = 7) {
  return fetchWithRetry('Google News Biz', async () => {
    const res = await axios.get(GOOGLE_NEWS_BIZ_URL, {
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(res.data);
    const items = result.rss?.channel?.[0]?.item || [];
    if (items.length === 0) throw new Error('Google News Biz returned 0 items');

    items.sort((a, b) => new Date(b.pubDate?.[0] || 0) - new Date(a.pubDate?.[0] || 0));
    const uniqueItems = dedupeGoogleNewsRssItems(items, limit);
    if (uniqueItems.length === 0) throw new Error('Google News Biz returned 0 items after dedupe');

    return uniqueItems.map((item, i) => ({
      rank: i + 1,
      keyword: `[뉴스/경제] ${(item.title?.[0] || '').replace(/ - .+$/, '')}`,
      url: item.link?.[0] || '',
      pubDate: item.pubDate?.[0] || new Date().toISOString()
    }));
  });
}

// 4. Google News (노동법/실업급여/퇴직금)
async function getGoogleNewsLabor(limit = 7) {
  return fetchWithRetry('Google News Labor', async () => {
    const res = await axios.get(GOOGLE_NEWS_LABOR_URL, {
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(res.data);
    const items = result.rss?.channel?.[0]?.item || [];
    if (items.length === 0) throw new Error('Google News Labor returned 0 items');

    items.sort((a, b) => new Date(b.pubDate?.[0] || 0) - new Date(a.pubDate?.[0] || 0));
    const uniqueItems = dedupeGoogleNewsRssItems(items, limit);
    if (uniqueItems.length === 0) throw new Error('Google News Labor returned 0 items after dedupe');

    return uniqueItems.map((item, i) => ({
      rank: i + 1,
      keyword: `[뉴스/노동] ${(item.title?.[0] || '').replace(/ - .+$/, '')}`,
      url: item.link?.[0] || '',
      pubDate: item.pubDate?.[0] || new Date().toISOString()
    }));
  });
}

// 5. Aha 전문가 Q&A
async function getAhaTrends(limit = 7) {
  return fetchWithRetry('Aha Q&A', async () => {
    const { body } = await gotScraping({
      url: 'https://www.a-ha.io/questions',
      headerGeneratorOptions: {
        browsers: [{ name: 'chrome', minVersion: 110 }],
        devices: ['desktop'],
        locales: ['ko-KR']
      },
      timeout: { request: 10000 }
    });

    const $ = cheerio.load(body);
    const seen = new Set();
    const questions = [];

    $('a[href^="/questions/"]').each((_, el) => {
      if (questions.length >= limit) return false;

      const title = $(el).find('h3, .title, .q-title').first().text().trim() || $(el).text().trim();
      let link = $(el).attr('href') || '';
      if (link && !link.startsWith('http')) link = `https://www.a-ha.io${link}`;
      const key = `${title}|${link}`;

      if (title && title.length > 5 && !seen.has(key)) {
        seen.add(key);
        questions.push({
          rank: questions.length + 1,
          keyword: `[Aha 질문] ${title}`,
          url: link
        });
      }
    });

    if (questions.length > 0) return questions;

    // Fallback: /questions 가 /topic 으로 리다이렉트되는 경우 sitemap 기반으로 최신 질문 URL을 수집
    const sitemapRes = await axios.get('https://www.a-ha.io/sitemapindex1.xml', {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const parser = new xml2js.Parser();
    const sitemap = await parser.parseStringPromise(sitemapRes.data);
    const locs = (sitemap.urlset?.url || [])
      .map((u) => u.loc?.[0])
      .filter((u) => typeof u === 'string' && u.includes('/questions/'))
      .slice(0, limit * 3); // 일부 URL 실패를 고려해 여유 샘플 확보

    const fallback = [];
    for (const url of locs) {
      if (fallback.length >= limit) break;
      try {
        const qRes = await axios.get(url, {
          timeout: 8000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const q$ = cheerio.load(qRes.data);
        const title =
          q$('meta[property="og:title"]').attr('content') ||
          q$('meta[name="twitter:title"]').attr('content') ||
          q$('title').text().trim();
        if (!title) continue;

        const cleanTitle = title
          .replace(/\s*\|\s*a-ha.*$/i, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (!cleanTitle || seen.has(`${cleanTitle}|${url}`)) continue;
        seen.add(`${cleanTitle}|${url}`);
        fallback.push({
          rank: fallback.length + 1,
          keyword: `[Aha 질문] ${cleanTitle}`,
          url
        });
      } catch (_e) {
        // 개별 질문 페이지 실패는 건너뛰고 계속 수집
      }
    }

    return fallback;
  });
}

// 6. Reddit Trends (영미권 전용 - 인기 게시물 기반)
async function getRedditTrends(limit = 10) {
  return fetchWithRetry('Reddit Trends', async () => {
    const res = await axios.get(`https://www.reddit.com/r/popular/top.json?limit=${limit}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    return res.data.data.children.map((child, i) => ({
      rank: i + 1,
      keyword: child.data.title,
      score: child.data.score,
      url: `https://reddit.com${child.data.permalink}`,
      subreddit: child.data.subreddit
    }));
  });
}

// 6-1. Reddit Scams (영미권 전용 - Loss Aversion)
async function getRedditScams(limit = 10) {
  return fetchWithRetry('Reddit Scams', async () => {
    const res = await axios.get(`https://www.reddit.com/r/Scams/top.json?limit=${limit}&t=day`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Bot/1.0' },
      timeout: 5000
    });
    return res.data.data.children.map((child, i) => ({
      rank: i + 1,
      keyword: child.data.title,
      score: child.data.score,
      url: `https://reddit.com${child.data.permalink}`,
      subreddit: child.data.subreddit
    }));
  });
}

// 6-2. Reddit Poverty Finance (영미권 전용 - Welfare)
async function getRedditPoverty(limit = 10) {
  return fetchWithRetry('Reddit PovertyFinance', async () => {
    const res = await axios.get(`https://www.reddit.com/r/povertyfinance/top.json?limit=${limit}&t=day`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Bot/1.0' },
      timeout: 5000
    });
    return res.data.data.children.map((child, i) => ({
      rank: i + 1,
      keyword: child.data.title,
      score: child.data.score,
      url: `https://reddit.com${child.data.permalink}`,
      subreddit: child.data.subreddit
    }));
  });
}

// 6-3. Reddit Frugal & LifeProTips (영미권 전용 - Smart Consumer)
async function getRedditFrugal(limit = 10) {
  return fetchWithRetry('Reddit Frugal', async () => {
    const res = await axios.get(`https://www.reddit.com/r/Frugal/top.json?limit=${limit}&t=day`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Bot/1.0' },
      timeout: 5000
    });
    return res.data.data.children.map((child, i) => ({
      rank: i + 1,
      keyword: child.data.title,
      score: child.data.score,
      url: `https://reddit.com${child.data.permalink}`,
      subreddit: child.data.subreddit
    }));
  });
}

// 6-4. BuzzFeed Trending (영미권 전용 - Viral & Entertainment)
async function getBuzzFeedTrending(limit = 10) {
  return fetchWithRetry('BuzzFeed Trending', async () => {
    const res = await axios.get('https://www.buzzfeed.com/trending.xml', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 5000
    });
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(res.data);
    const items = (result.rss.channel[0].item || []).slice(0, limit);
    return items.map((item, i) => ({
      rank: i + 1,
      keyword: item.title[0],
      url: item.link[0],
      pubDate: item.pubDate ? item.pubDate[0] : ''
    }));
  });
}

// 7. Yahoo News (영미권 전용 - RSS)
async function getYahooNewsRSS(limit = 10) {
  return fetchWithRetry('Yahoo News', async () => {
    const res = await axios.get('https://news.yahoo.com/rss/', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 5000
    });
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(res.data);
    const items = (result.rss.channel[0].item || []).slice(0, limit);
    return items.map((item, i) => ({
      rank: i + 1,
      keyword: item.title[0],
      url: item.link[0],
      pubDate: item.pubDate ? item.pubDate[0] : ''
    }));
  });
}

// 8. 금융감독원 소비자경보 (한국 전용 - RSS 대신 HTML 스크래핑)
async function getFssAlerts(limit = 5) {
  return fetchWithRetry('FSS Alerts', async () => {
    const res = await axios.get('https://www.fss.or.kr/fss/bbs/B0000188/list.do?menuNo=200213', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 5000
    });
    const $ = cheerio.load(res.data);
    const alerts = [];
    $('.bd-list .title a').each((i, el) => {
        if (alerts.length >= limit) return false;
        const title = $(el).text().trim();
        let link = $(el).attr('href') || '';
        if (link.startsWith('?')) {
            link = 'https://www.fss.or.kr/fss/bbs/B0000188/list.do' + link;
        } else if (link.startsWith('/')) {
            link = 'https://www.fss.or.kr' + link;
        }
        
        if (title) {
            alerts.push({
                rank: alerts.length + 1,
                keyword: title,
                url: link,
                pubDate: new Date().toISOString() // HTML 목록에 날짜가 파싱하기 까다로우므로 현재 날짜로 대체
            });
        }
    });
    return alerts;
  });
}

// 9. 정책브리핑 (한국 전용 - RSS)
async function getPolicyBriefing(limit = 5) {
  return fetchWithRetry('Policy Briefing', async () => {
    // https 연결 리셋(ECONNRESET) 방지를 위해 http 사용
    const res = await axios.get('http://www.korea.kr/rss/policy.xml', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 5000
    });
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(res.data);
    const items = (result.rss.channel[0].item || []).slice(0, limit);
    return items.map((item, i) => ({
      rank: i + 1,
      keyword: item.title[0],
      url: item.link[0],
      pubDate: item.pubDate ? item.pubDate[0] : ''
    }));
  });
}

// 10. 뽐뿌 정보/강좌 게시판 (한국 전용 - 핫딜 대신 정보성 글 크롤링)
async function getPpomppuHotDeals(limit = 7) {
  return fetchWithRetry('Ppomppu Info', async () => {
    const res = await axios.get('https://www.ppomppu.co.kr/zboard/zboard.php?id=etc_info', {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 5000
    });
    let text = iconv.decode(res.data, 'euc-kr');
    const $ = cheerio.load(text);
    const deals = [];
    
    // 정보게시판(etc_info)의 게시글 목록 추출
    $('.baseList-title').each((i, el) => {
        if (deals.length >= limit) return false;
        
        const title = $(el).text().replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim();
        let link = $(el).attr('href') || '';
        
        // 공지사항 등 제외 (view.php?id=etc_info 포함하는 링크만)
        if (!link.includes('id=etc_info')) return true; // continue
        
        if (!link.startsWith('http')) {
            link = 'https://www.ppomppu.co.kr/zboard/' + link;
        }
        
        // 카테고리 추출
        let category = $(el).closest('.baseList-box').find('.baseList-small').text().replace(/[\[\]]/g, '').trim() || '정보';
        
        if (title && !title.includes('공지')) {
            deals.push({
                rank: deals.length + 1,
                keyword: `[${category}] ${title}`, // AI가 판단하기 쉽도록 카테고리 부착
                url: link
            });
        }
    });
    
    return deals;
  });
}

// --- Google Indexing API Helper ---
async function triggerGoogleIndexing(urlToindex) {
  const keyPath = path.join(process.cwd(), 'blog-auto-posting-493814-55523dd2b0a8.json');
  if (!fs.existsSync(keyPath)) {
      logger.warn(`[Indexing API] Service account key not found at ${keyPath}. Skipping Google Indexing.`);
      return;
  }

  logger.api(`[Indexing API] Indexing 요청: ${urlToindex}`);
  const startTime = Date.now();

  try {
      const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
      const jwtClient = new google.auth.JWT({
          email: key.client_email,
          key: key.private_key,
          scopes: ["https://www.googleapis.com/auth/indexing"]
      });

      // 토큰 획득 대기
      const tokens = await new Promise((resolve, reject) => {
          jwtClient.authorize((err, tokens) => {
              if (err) reject(err);
              else resolve(tokens);
          });
      });

      // API 쏘기
      const response = await axios.post("https://indexing.googleapis.com/v3/urlNotifications:publish", {
          url: urlToindex,
          type: "URL_UPDATED"
      }, {
          headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${tokens.access_token}` 
          }
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      logger.success(`[Indexing API] Indexing 성공 (${elapsed}s) -> ${urlToindex}`);
  } catch (error) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      logger.error(`[Indexing API Error] Indexing 실패 (${elapsed}s) - ${urlToindex}: ${error.response?.data?.error?.message || error.message}`);
  }
}

app.get('/api/config/prompts', (req, res) => {
  const lang = req.query.lang || 'ko';
  const fileName = lang === 'en' ? './prompts_en.yml' : './prompts_ko.yml';
  try {
    const fileContent = fs.readFileSync(fileName, 'utf8');
    res.json({ yaml: fileContent });
  } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/trends', async (req, res) => {
  const region = req.query.region || 'KR';
  const sources = req.query.sources ? req.query.sources.split(',') : [];
  const itemScale = clampItemScale(req.query.itemScale);

  const checkSource = (name) => sources.length === 0 || sources.includes(name);

  if (region === 'US') {
    const usLimits = {
      google: getSourceLimit('google', itemScale),
      reddit: getSourceLimit('reddit', itemScale),
      yahoo: getSourceLimit('yahoo', itemScale),
      redditScams: getSourceLimit('redditScams', itemScale),
      redditPoverty: getSourceLimit('redditPoverty', itemScale),
      redditFrugal: getSourceLimit('redditFrugal', itemScale),
      buzzfeed: getSourceLimit('buzzfeed', itemScale)
    };
    const [google, reddit, yahoo, redditScams, redditPoverty, redditFrugal, buzzfeed] = await Promise.all([
      checkSource('google') ? getGoogleTrends('US', usLimits.google) : Promise.resolve([]),
      checkSource('reddit') ? getRedditTrends(usLimits.reddit) : Promise.resolve([]),
      checkSource('yahoo') ? getYahooNewsRSS(usLimits.yahoo) : Promise.resolve([]),
      checkSource('redditScams') ? getRedditScams(usLimits.redditScams) : Promise.resolve([]),
      checkSource('redditPoverty') ? getRedditPoverty(usLimits.redditPoverty) : Promise.resolve([]),
      checkSource('redditFrugal') ? getRedditFrugal(usLimits.redditFrugal) : Promise.resolve([]),
      checkSource('buzzfeed') ? getBuzzFeedTrending(usLimits.buzzfeed) : Promise.resolve([])
    ]);
    res.json({
        timestamp: new Date().toISOString(),
        region,
        google, reddit, yahoo, redditScams, redditPoverty, redditFrugal, buzzfeed,
        sourceDescriptions: {
            google: "Google Trends. Massive societal issues, news, and sports trends experiencing explosive search volume across the region.",
            reddit: "Reddit r/popular. Real-time overall popular posts, memes, and hot issues from the largest English-speaking community.",
            yahoo: "Yahoo News. Trends centered around major current affairs, economy, and political news in the English-speaking world.",
            redditScams: "Reddit r/Scams. Information to prevent financial loss (Loss Aversion) for readers, such as the latest scam methods and scam warnings.",
            redditPoverty: "Reddit r/povertyfinance. Welfare and survival information such as financial tips, government subsidies, and survival strategies for low-income individuals.",
            redditFrugal: "Reddit r/Frugal. Practical life tips for smart consumers, including extreme money-saving tips and cost-effective product recommendations.",
            buzzfeed: "BuzzFeed Trending. Light entertainment, Hollywood gossip, TikTok life hacks, and psychological tests going viral in the US."
        }
    });
    } else {
    const krLimits = {
      ppomppu: getSourceLimit('ppomppu', itemScale),
      aha: getSourceLimit('aha', itemScale),
      fss: getSourceLimit('fss', itemScale),
      policy: getSourceLimit('policy', itemScale),
      gNewsLabor: getSourceLimit('gNewsLabor', itemScale),
      gNewsBiz: getSourceLimit('gNewsBiz', itemScale),
      signal: getSourceLimit('signal', itemScale)
    };
    const [ppomppu, aha, fss, policy, gNewsLabor, gNewsBiz, signal] = await Promise.all([
      checkSource('ppomppu') ? getPpomppuHotDeals(krLimits.ppomppu) : Promise.resolve([]),
      checkSource('aha') ? getAhaTrends(krLimits.aha) : Promise.resolve([]),
      checkSource('fss') ? getFssAlerts(krLimits.fss) : Promise.resolve([]),
      checkSource('policy') ? getPolicyBriefing(krLimits.policy) : Promise.resolve([]),
      checkSource('gNewsLabor') ? getGoogleNewsLabor(krLimits.gNewsLabor) : Promise.resolve([]),
      checkSource('gNewsBiz') ? getGoogleNewsBiz(krLimits.gNewsBiz) : Promise.resolve([]),
      checkSource('signal') ? getSignalTrends(krLimits.signal) : Promise.resolve([])
    ]);
    res.json({
        timestamp: new Date().toISOString(),
        region,
        ppomppu, aha, fss, policy, gNewsLabor, gNewsBiz, signal,
        sourceDescriptions: {
            ppomppu: "뽐뿌 정보/강좌 게시판. 재테크, 핫딜, 가성비에 매우 민감한 스마트 컨슈머들이 공유하는 생활 밀착형 꿀팁 및 유용한 정보.",
            aha: "Aha(아하) 전문가 Q&A. 사용자의 구체적이고 현실적인 질문과 전문가 답변.",
            fss: "금융감독원 소비자경보. 신종 보이스피싱, 코인 사기 수법, 불법 사금융 등 독자의 금전적 손실(Loss Aversion)을 방지하기 위한 경고성 정보.",
            policy: "대한민국 정책브리핑. 정부 보조금, 청년 지원금, 세금 환급 등 독자의 금전적 이득과 실생활에 직결되는 정책 정보(Welfare).",
            gNewsLabor: "구글 뉴스 (노동법/실업급여). 직장인 권리 및 실업급여 관련 팩트.",
            gNewsBiz: "구글 뉴스 (자영업/세금). 소상공인 지원금, 세금 관련 최신 뉴스.",
            signal: "네이트 실시간 검색어. 포털 기반의 시의성 신호를 빠르게 반영."
        }
    });
    }
});

// --- Naver SearchAd API Helpers ---
function generateSearchAdSignature(method, uri, secretKey, apiKey) {
    const timestamp = Date.now().toString();
    const message = `${timestamp}.${method}.${uri}`;
    const hash = crypto.createHmac('sha256', secretKey).update(message).digest('base64');
    return { timestamp, hash };
}

async function getNaverKeywordMetrics(keywords, lang = 'ko', country = 'KR') {
    if (!process.env.SEARCHAD_ACCESS_LICENSE || !process.env.SEARCHAD_SECRET_KEY || !process.env.SEARCHAD_CUSTOMER_ID) {
        logger.warn('[Metrics] Naver SearchAd API keys missing. Skipping metrics.');
        return {};
    }

    const customerId = process.env.SEARCHAD_CUSTOMER_ID;
    const license = process.env.SEARCHAD_ACCESS_LICENSE;
    const secretKey = process.env.SEARCHAD_SECRET_KEY;
    
    // 1. 월간 검색량 (SearchAd API)
    // 한 번에 최대 5개 키워드 조회 가능
    // [v3.2] 공백 포함 키워드가 SearchAd에서 0으로 떨어지는 문제를 완화하기 위해
    //        토큰 분리(노이즈 제외) 확장 조회 후, 원본 키워드에 최대 searchVolume을 역매핑한다.
    const NOISE_TOKENS = new Set([
        '방법', '신청', '이용', '안내', '정보', '확인', '조회', '방식', '절차',
        '가이드', '정리', '후기', '추천', '가격', '조건', '대상', '기간'
    ]);

    function expandKeywordsForMetrics(inputKeywords) {
        const expanded = new Set();
        for (const kw of inputKeywords) {
            const raw = String(kw ?? '').trim();
            if (!raw) continue;
            expanded.add(raw);
            const parts = raw
                .split(/\s+/)
                .map(p => p.trim())
                .filter(p => p.length >= 3)
                .filter(p => !NOISE_TOKENS.has(p));
            if (parts.length > 1) {
                parts.forEach(p => expanded.add(p));
            }
        }
        return [...expanded];
    }

    const expandedKeywords = expandKeywordsForMetrics(keywords);
    const kChunks = [];
    for (let i = 0; i < expandedKeywords.length; i += 5) {
        kChunks.push(expandedKeywords.slice(i, i + 5));
    }

    const metrics = {};

    for (let i = 0; i < kChunks.length; i++) {
        const chunk = kChunks[i];
        try {
            // [Fix] 네이버 검색광고 API는 키워드 내 공백(띄어쓰기)을 절대 허용하지 않음 (Invalid Parameter 오류 방지)
            //       단, 공백 포함 원본 키워드는 토큰으로 분리(expandKeywordsForMetrics)해두었으므로
            //       여기서는 "공백 제거"를 파라미터 안전장치로만 적용한다.
            const sanitizedChunk = chunk.map(k => String(k).replace(/\s+/g, '').trim()).filter(Boolean);
            if (sanitizedChunk.length === 0) continue;

            const uri = '/keywordstool';
            const requestSearchAdChunk = async () => {
                const { timestamp, hash } = generateSearchAdSignature('GET', uri, secretKey, license);
                return axios.get(`https://api.searchad.naver.com${uri}`, {
                    params: { hintKeywords: sanitizedChunk.join(','), showDetail: '1' },
                    headers: {
                        'X-Timestamp': timestamp,
                        'X-API-KEY': license,
                        'X-Customer': customerId,
                        'X-Signature': hash
                    }
                });
            };

            let res;
            try {
                res = await requestSearchAdChunk();
            } catch (firstErr) {
                if (firstErr?.response?.status === 429) {
                    logger.warn(`[Metrics] SearchAd 429 on chunk ${i + 1}/${kChunks.length}. Retrying after 1500ms...`);
                    await new Promise(r => setTimeout(r, 1500));
                    res = await requestSearchAdChunk();
                } else {
                    throw firstErr;
                }
            }

            if (res.data && res.data.keywordList) {
                res.data.keywordList.forEach(item => {
                    const pc = parseInt(item.monthlyPcQcCnt) || 0;
                    const mo = parseInt(item.monthlyMobileQcCnt) || 0;
                    metrics[item.relKeyword] = {
                        searchVolume: pc + mo,
                        pcVolume: pc,
                        mobileVolume: mo
                    };
                });
            }
        } catch (e) {
            logger.error(`[Metrics] SearchAd API Error (chunk ${i + 1}/${kChunks.length}): ${e.response?.data?.message || e.message}`);
        } finally {
            if (i < kChunks.length - 1) {
                const jitterMs = Math.floor(Math.random() * 300);
                await new Promise(r => setTimeout(r, 1500 + jitterMs));
            }
        }
    }

    // 2. 블로그 문서 수 (Search API) - 원본 키워드에 대해서만 조회 및 100ms 딜레이
    const originalMetrics = {};
    for (const kw of keywords) {
        // 공백 제거된 원본 키워드로 검색광고 결과 맵핑
        const sanitizedKw = String(kw).replace(/\s+/g, '').trim();
        const targetKw = kw;
        
        const foundKey = Object.keys(metrics).find(k => k.replace(/\s+/g, '') === sanitizedKw);
        if (foundKey && metrics[foundKey]) {
             originalMetrics[targetKw] = { ...metrics[foundKey] };
        } else {
             originalMetrics[targetKw] = { searchVolume: 0, pcVolume: 0, mobileVolume: 0 };
        }

        try {
            const blogRes = await axios.get('https://openapi.naver.com/v1/search/blog.json', {
                params: { query: targetKw, display: 1 },
                headers: {
                    'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
                    'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET
                }
            });
            const total = blogRes.data.total || 0;
            originalMetrics[targetKw].documentCount = total;
            // 경쟁 지수 연산 (문서 수 / 검색량)
            const vol = originalMetrics[targetKw].searchVolume || 1;
            originalMetrics[targetKw].competitionIndex = parseFloat((total / vol).toFixed(2));
            
            // 429 방지를 위한 딜레이
            await new Promise(r => setTimeout(r, 100));
        } catch (e) {
            logger.warn(`[Metrics] Naver Search API Error for "${targetKw}": ${e.message}`);
            originalMetrics[targetKw].documentCount = 0;
            originalMetrics[targetKw].competitionIndex = null;
        }
    }

    // [v3.2] 원본 키워드가 SearchAd에서 0/미매칭인 경우,
    //        공백 토큰(노이즈 제외) 중 최대 searchVolume으로 보완하고 competitionIndex를 재계산한다.
    for (const kw of keywords) {
        const base = originalMetrics[kw];
        if (!base) continue;
        if (typeof base.searchVolume === 'number' && base.searchVolume > 0) continue;

        const parts = String(kw ?? '')
            .split(/\s+/)
            .map(p => p.trim())
            .filter(p => p.length >= 3)
            .filter(p => !NOISE_TOKENS.has(p));
        if (parts.length < 2) continue;

        let bestPart = null;
        let bestVol = 0;
        for (const p of parts) {
            const m = metrics[p];
            const v = typeof m?.searchVolume === 'number' ? m.searchVolume : 0;
            if (v > bestVol) {
                bestVol = v;
                bestPart = p;
            }
        }

        if (bestVol > 0) {
            base.searchVolume = bestVol;
            base._resolvedFrom = bestPart;

            // [v3.3] 토큰 보완 시 documentCount도 동일 토큰 기준으로 동기화
            try {
                const tokenBlogRes = await axios.get('https://openapi.naver.com/v1/search/blog.json', {
                    params: { query: bestPart, display: 1 },
                    headers: {
                        'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
                        'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET
                    }
                });
                if (typeof tokenBlogRes.data?.total === 'number') {
                    base.documentCount = tokenBlogRes.data.total;
                }
            } catch (e) {
                logger.warn(`[Metrics] Token documentCount sync failed for "${bestPart}": ${e.message}`);
            }

            const vol = bestVol || 1;
            base.competitionIndex = parseFloat(((base.documentCount || 0) / vol).toFixed(2));
            logger.process(`[Metrics] "${kw}" → token "${bestPart}"로 검색량 보완: ${bestVol}`);
        }
    }

    const topKeywords = keywords.slice(0, 5);
    const suggestionsMap = {};
    await Promise.all(
      topKeywords.map(async (kw) => {
        suggestionsMap[kw] = await getGoogleSuggestions(kw, lang, country);
      })
    );

    Object.keys(originalMetrics).forEach((kw) => {
      originalMetrics[kw].suggestions = suggestionsMap[kw] || [];
      attachCompetitionLabel(originalMetrics[kw], lang);
    });

    return originalMetrics;
}

// [v3.0] 모델 출력의 searchVolume/documentCount/competitionIndex는 신뢰하지 않고,
//        서버에서 수집한 실측 metrics로 덮어쓴다(운영 안정성: SEARCH==DOCS 같은 패턴 방지).
function applyMeasuredMetricsToAnalysis(analysisJson, measuredMetrics) {
    if (!analysisJson || !Array.isArray(analysisJson.blogPosts)) return analysisJson;
    if (!measuredMetrics || typeof measuredMetrics !== 'object') return analysisJson;

    for (const post of analysisJson.blogPosts) {
        const key = post?.targetKeyword || post?.mainKeyword;
        if (!key) continue;
        const m = measuredMetrics[key];
        if (!m) continue;

        const sv = typeof m.searchVolume === 'number' ? m.searchVolume : 0;
        const dc = typeof m.documentCount === 'number' ? m.documentCount : 0;
        const ci =
            typeof m.competitionIndex === 'number'
                ? m.competitionIndex
                : parseFloat((dc / Math.max(sv, 1)).toFixed(2));

        post.searchVolume = sv;
        post.documentCount = dc;
        post.competitionIndex = ci;
    }

    // 길이/개수 보정 (프롬프트 지시 불이행 대비)
    for (const post of analysisJson.blogPosts || []) {
        if (Array.isArray(post.faq)) {
            post.faq = post.faq
                .map((q) => {
                    const words = String(q).trim().split(/\s+/);
                    return words.length > 15 ? `${words.slice(0, 15).join(' ')}…` : q;
                })
                .slice(0, 3);
        }
    }

    return analysisJson;
}

// [v3.0] 레거시 `searchQueries.news` → `news_main` / 빈 `news_sub` 보정 (스키마·보강 로직 정합)
function normalizeSearchQueriesV30(analysisJson) {
    if (!analysisJson || !Array.isArray(analysisJson.blogPosts)) return analysisJson;
    for (const post of analysisJson.blogPosts) {
        if (!post || typeof post !== 'object') continue;
        if (!post.searchQueries || typeof post.searchQueries !== 'object') {
            post.searchQueries = {};
        }
        const sq = post.searchQueries;
        const legacyNews = typeof sq.news === 'string' ? sq.news.trim() : '';
        const main = typeof sq.news_main === 'string' ? sq.news_main.trim() : '';
        const sub = typeof sq.news_sub === 'string' ? sq.news_sub.trim() : '';
        const kin = typeof sq.kin === 'string' ? sq.kin.trim() : '';
        post.searchQueries = {
            news_main: main || legacyNews || (post.mainKeyword || post.targetKeyword || '').trim(),
            news_sub: sub || (post.targetKeyword || post.mainKeyword || main || legacyNews || '').trim(),
            kin: kin || (post.mainKeyword || main || legacyNews || '').trim()
        };
    }
    return analysisJson;
}

async function getGoogleSuggestions(keyword, lang = 'ko', country = 'KR') {
  try {
    const res = await axios.get('http://suggestqueries.google.com/complete/search', {
      params: { client: 'chrome', q: keyword, hl: lang, gl: country },
      responseType: 'arraybuffer',
      timeout: 3000
    });

    const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
    const charset = contentType.includes('euc-kr') ? 'euc-kr' : 'utf8';
    const decoded = iconv.decode(Buffer.from(res.data), charset);
    const parsed = JSON.parse(decoded);
    return Array.isArray(parsed?.[1]) ? parsed[1].slice(0, 5) : [];
  } catch (_e) {
    return [];
  }
}

// [Step 1] Lite 모델을 이용한 검색 키워드 추출
async function extractSearchKeywords(trendsData, lang) {
    const liteModels = await getLiteModels();
    const apiKey1 = process.env.GEMINI_API_KEY;
    const apiKey2 = process.env.GEMINI_API_KEY_2;
    const apis = [{ name: 'API_1', key: apiKey1 }, { name: 'API_2', key: apiKey2 }].filter(a => a.key);

    for (const api of apis) {
        const genAI = new GoogleGenerativeAI(api.key);
        for (const modelName of liteModels) {
            try {
                logger.process(`[Keyword Extraction] Using ${modelName} to refine search terms...`);
                const model = genAI.getGenerativeModel({ 
                    model: modelName,
                    generationConfig: { responseMimeType: "application/json" } // JSON 모드 강제
                });

                const prompt = promptManager.getPrompt('keyword_extraction', lang, {
                    trends_data: JSON.stringify(trendsData)
                });

                const result = await model.generateContent(prompt);
                const text = result.response.text().trim();
                
                // 정밀한 JSON 추출 (코드 블록 및 앞뒤 쓰레기 텍스트 방어)
                const jsonMatch = text.match(/\[\s*".*"\s*\]/s);
                const cleanJson = jsonMatch ? jsonMatch[0] : text.replace(/^```json|```$/gi, "").trim();
                
                const keywords = JSON.parse(cleanJson);
                if (Array.isArray(keywords)) {
                    logger.success(`[Keyword Extraction] Successfully extracted ${keywords.length} terms: ${keywords.join(', ')}`);
                    return keywords;
                }
            } catch (e) {
                logger.warn(`[Keyword Extraction] Model ${modelName} failed: ${e.message}`);
            }
        }
    }
    return [];
}

function buildKeywordExtractionPromptInput({ trends, manualText, region = 'KR' }) {
    const lang = region === 'US' ? 'en' : 'ko';
    const trendsPayload = manualText ? { text: manualText } : (trends || {});
    const prompt = promptManager.getPrompt('keyword_extraction', lang, {
        trends_data: JSON.stringify(trendsPayload)
    });
    return { prompt, lang, trendsPayload };
}

async function buildAnalysisPromptInput({ trends, manualText, config, region = 'KR' }) {
    const topicCount = config?.topicCount || 3;
    const lang = region === 'US' ? 'en' : 'ko';
    let metricsContext = '';
    let measuredMetrics = {};
    let searchTerms = [];

    const trendsPayload = manualText ? { text: manualText } : trends;
    searchTerms = await extractSearchKeywords(trendsPayload, lang);
    if (searchTerms.length > 0) {
        const suggestLang = region === 'US' ? 'en' : 'ko';
        const suggestCountry = region === 'US' ? 'US' : 'KR';
        measuredMetrics = await getNaverKeywordMetrics(searchTerms, suggestLang, suggestCountry);
        metricsContext = Object.entries(measuredMetrics).map(([kw, data]) =>
            formatMetricsLine(kw, data, lang)
        ).join('\n');
    }

    let prompt;
    if (manualText) {
        prompt = promptManager.getPrompt('manual_analysis', lang, {
            manual_text: manualText,
            topic_count: topicCount,
            metrics_data: metricsContext
        });
    } else {
        prompt = promptManager.getPrompt('trend_analysis', lang, {
            trends_data: JSON.stringify(trends),
            topic_count: topicCount,
            metrics_data: metricsContext
        });
    }
    prompt += buildRecentKeywordsContext(lang);

    return {
        prompt,
        lang,
        topicCount,
        metricsContext,
        measuredMetrics,
        searchTerms
    };
}

async function buildPostGenerationPromptInput({ rawPostPlan, region = 'KR' }) {
    const lang = region === 'US' ? 'en' : 'ko';
    const postPlan = await enrichPostPlan(rawPostPlan, region);
    const tags = buildExpandedTags(postPlan);
    const rawAngle = String(postPlan.angleType || DEFAULT_ANGLE).toLowerCase().trim();
    const angle = ALLOWED_ANGLES.has(rawAngle) ? rawAngle : DEFAULT_ANGLE;
    if (angle !== rawAngle) {
        logger.warn(`[Post Gen] Invalid angleType "${postPlan.angleType}" → fallback to "${angle}"`);
    }
    const promptKey = `post_writing_${angle}`;
    const rawContentDepth = postPlan.contentDepth || 'Normal';
    const normalizedContentDepth = rawContentDepth === 'Bite-sized' ? 'Snack' : rawContentDepth;

    const prompt = promptManager.getPrompt(promptKey, lang, {
        mainKeyword: postPlan.mainKeyword,
        searchIntent: postPlan.searchIntent,
        contentDepth: normalizedContentDepth,
        conclusionType: postPlan.conclusionType || 'Q&A',
        coreFact: postPlan.coreFact || '[팩트 없음 — 수치·통계 창작 절대 금지. 기획안에 제공된 키워드와 맥락만 활용할 것]',
        coreEntities: postPlan.coreEntities ? (Array.isArray(postPlan.coreEntities) ? postPlan.coreEntities.join(', ') : postPlan.coreEntities) : '',
        subTopics: postPlan.subTopics ? (Array.isArray(postPlan.subTopics) ? postPlan.subTopics.join(', ') : postPlan.subTopics) : '',
        seoKeywords: tags.join(', '),
        lsiKeywords: postPlan.lsiKeywords ? (Array.isArray(postPlan.lsiKeywords) ? postPlan.lsiKeywords.join(', ') : postPlan.lsiKeywords) : '',
        coreMessage: postPlan.coreMessage,
        lifecycle: postPlan.trafficStrategy?.lifecycle || '',
        category: postPlan.category || '',
        shoppableKeyword: postPlan.shoppableKeyword || '',
        faq: Array.isArray(postPlan.faq) ? postPlan.faq.map(f => `Q: ${f.q}\nA: ${f.a}`).join('\n\n') : '',
        metaDescription: postPlan.metaDescription || '',
        targetAudience: postPlan?.trafficStrategy?.targetAudience || postPlan?.targetAudience || '일반 독자',
        source_urls: (postPlan.enrichedFacts && Array.isArray(postPlan.enrichedFacts.sourceUrls) && postPlan.enrichedFacts.sourceUrls.length > 0)
            ? postPlan.enrichedFacts.sourceUrls.join('\n')
            : (Array.isArray(postPlan.sourceUrls) ? postPlan.sourceUrls.join('\n') : ''),
        newsMain: (() => {
            const ef = postPlan.enrichedFacts || {};
            const arr =
                Array.isArray(ef.newsMain) && ef.newsMain.length
                    ? ef.newsMain
                    : Array.isArray(ef.news) && ef.news.length
                      ? ef.news
                      : [];
            return arr.length ? arr.map((f, i) => `${i + 1}. ${f}`).join('\n') : '[메인 뉴스 팩트 없음]';
        })(),
        newsSub: (() => {
            const ef = postPlan.enrichedFacts || {};
            const arr = Array.isArray(ef.newsSub) && ef.newsSub.length ? ef.newsSub : [];
            return arr.length ? arr.map((f, i) => `${i + 1}. ${f}`).join('\n') : '[보조 뉴스 팩트 없음]';
        })(),
        kinPainPoints: (postPlan.enrichedFacts && Array.isArray(postPlan.enrichedFacts.kin) && postPlan.enrichedFacts.kin.length > 0)
            ? postPlan.enrichedFacts.kin.map((f, i) => `${i + 1}. ${f}`).join('\n')
            : '[수집된 커뮤니티 실제 사례 없음]',
        outputFormat: FORMAT_MAP[`${angle}-${normalizedContentDepth}`] || '',
        context_url_1: "IMAGE_PLACEHOLDER_1",
        context_url_2: "IMAGE_PLACEHOLDER_2",
        context_url_3: "IMAGE_PLACEHOLDER_3"
    });

    return { prompt, postPlan, tags, angle, promptKey, lang };
}

// angleType 다양성 보정 (모두 동일한 경우 분산)
function diversifyAngles(blogPosts) {
    if (!Array.isArray(blogPosts) || blogPosts.length < 3) return blogPosts;
    const angles = blogPosts.map((p) => p?.angleType);
    const allSame = angles.every((a) => a === angles[0]);
    if (!allSame) return blogPosts;

    const pool = ['expose', 'guide', 'compare'];
    blogPosts.forEach((post, i) => {
        if (!post || typeof post !== 'object') return;
        post.angleType = pool[i % pool.length];
    });
    logger.warn('[Analysis] angleType 전부 동일 → 강제 분산 적용');
    return blogPosts;
}

// contentDepth 다양성 보정 (모두 Normal인 경우만 최소 분산)
function diversifyContentDepth(blogPosts) {
    if (!Array.isArray(blogPosts) || blogPosts.length < 3) return blogPosts;
    const depths = blogPosts.map((p) => p?.contentDepth);
    const allNormal = depths.every((d) => d === 'Normal');
    if (!allNormal) return blogPosts;

    blogPosts[0].contentDepth = 'Snack';
    blogPosts[blogPosts.length - 1].contentDepth = 'Deep-Dive';
    logger.warn('[Analysis] contentDepth 전부 Normal → Snack/Normal/Deep-Dive로 분산');
    return blogPosts;
}

app.post('/api/debug/prompt-preview', async (req, res) => {
    try {
        const { stage, trends, manualText, config, region = 'KR', postPlan } = req.body || {};
        if (!stage) return res.status(400).json({ error: 'stage is required' });

        if (stage === 'keyword_extraction') {
            const built = buildKeywordExtractionPromptInput({ trends, manualText, region });
            return res.json({
                stage,
                prompt: built.prompt,
                meta: { lang: built.lang }
            });
        }

        if (stage === 'analysis') {
            const built = await buildAnalysisPromptInput({ trends, manualText, config, region });
            return res.json({
                stage,
                prompt: built.prompt,
                meta: {
                    lang: built.lang,
                    topicCount: built.topicCount,
                    searchTerms: built.searchTerms,
                    metricsLines: built.metricsContext ? built.metricsContext.split('\n').length : 0
                }
            });
        }

        if (stage === 'post_generation') {
            if (!postPlan) return res.status(400).json({ error: 'postPlan is required for post_generation preview' });
            const built = await buildPostGenerationPromptInput({ rawPostPlan: postPlan, region });
            return res.json({
                stage,
                prompt: built.prompt,
                meta: {
                    lang: built.lang,
                    angle: built.angle,
                    promptKey: built.promptKey,
                    tagsCount: built.tags.length
                }
            });
        }

        return res.status(400).json({ error: `Unsupported stage: ${stage}` });
    } catch (error) {
        logger.error('[Prompt Preview] Failed', error.message);
        return res.status(500).json({ error: 'prompt preview failed', details: error.message });
    }
});

app.post('/api/analyze', async (req, res) => {
  const { trends, manualText, config, region = 'KR' } = req.body;
  const topicCount = config?.topicCount || 3;
  const useSearch = config?.useSearch === true;
  const lang = region === 'US' ? 'en' : 'ko';

  // [Step 1 & 2] 네이버 데이터 기반 블루오션 필터링 레이어
  let measuredMetrics = {};
  let analysisPrompt = '';
  try {
      const built = await buildAnalysisPromptInput({ trends, manualText, config, region });
      measuredMetrics = built.measuredMetrics;
      analysisPrompt = built.prompt;
      logger.success(`[Analysis] Successfully gathered metrics for ${built.searchTerms.length} terms.`);
  } catch (e) {
      logger.warn(`[Analysis] Blue-ocean metrics gathering failed: ${e.message}`);
  }
  if (!analysisPrompt) {
      analysisPrompt = manualText
          ? promptManager.getPrompt('manual_analysis', lang, {
              manual_text: manualText,
              topic_count: topicCount,
              metrics_data: ''
            }) + buildRecentKeywordsContext(lang)
          : promptManager.getPrompt('trend_analysis', lang, {
              trends_data: JSON.stringify(trends),
              topic_count: topicCount,
              metrics_data: ''
            }) + buildRecentKeywordsContext(lang);
  }

  const modelsToTry = await getBestModels();
  let lastError = null;

  const apiKey1 = process.env.GEMINI_API_KEY;
  const apiKey2 = process.env.GEMINI_API_KEY_2;
  const apis = [
      { name: 'API_1', key: apiKey1 },
      { name: 'API_2', key: apiKey2 }
  ].filter(api => api.key);

  for (const api of apis) {
    const currentGenAI = new GoogleGenerativeAI(api.key);
    let success = false;

    for (let i = 0; i < modelsToTry.length; i++) {
      const modelName = modelsToTry[i];

      if (shouldSkipModel(api.name, modelName)) {
              logger.process(`[Analysis] [${api.name}] Model ${modelName} is flash and version < 3. Switching to API_2 after 3s...`);
              await new Promise(r => setTimeout(r, 3000));
              break; // Skip to next API
          }
      
      try {
        logger.process(`[Analysis] [${api.name}] Attempting with ${modelName} (Count: ${topicCount}, Region: ${region}, Search: ${useSearch})`);
        
        // [Google Search Grounding] 실시간 검색 도구 활성화 조건
        // 1. 사용자 설정이 ON 이어야 함
        // 2. 모델이 도구를 지원해야 함 (lite, gemma 등은 제외)
        const supportsTools = !modelName.includes('lite') && !modelName.includes('gemma');
        const tools = (useSearch && supportsTools) ? [{ googleSearchRetrieval: {} }] : undefined;

        // [v2.6] responseSchema 는 useSearch=false 인 경로에서만 적용 (Grounding 동시 사용 제약 회피).
        //        schema 적용 시 모델이 정확한 JSON 을 반환하므로 마크다운 ```json 제거/중괄호 복구 후처리를 생략할 수 있다.
        const useSchema = !tools;
        const generationConfig = {
            temperature: 0.7,
            topP: 0.9
        };
        if (useSchema) {
            generationConfig.responseMimeType = "application/json";
            generationConfig.responseSchema = ANALYSIS_RESPONSE_SCHEMA;
        }

        const model = currentGenAI.getGenerativeModel({
            model: modelName,
            tools: tools,
            generationConfig
        });

        const prompt = analysisPrompt;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        let text = response.text().trim();

        // schema 미적용 경로(useSearch=true 등)에서만 마크다운 코드펜스/문자열 쓰레기 방어 로직 유지
        if (!useSchema) {
            text = text.replace(/^```(json)?|```$/gi, "").trim();
            const firstBrace = text.indexOf('{');
            const lastBrace = text.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1) {
                text = text.slice(firstBrace, lastBrace + 1);
            }
        }

        logger.success(`[Analysis] [${api.name}] Successful with ${modelName}${useSchema ? ' (schema)' : ''}`);
        success = true;
        const parsed = JSON.parse(text);
        // [v3.0] 실측 metrics 덮어쓰기 → 그 다음 priority 태깅
        const patched = normalizeSearchQueriesV30(applyMeasuredMetricsToAnalysis(parsed, measuredMetrics));
        if (Array.isArray(patched.blogPosts)) {
            patched.blogPosts = diversifyAngles(patched.blogPosts);
            patched.blogPosts = diversifyContentDepth(patched.blogPosts);
        }
        const analysisJson = annotateAnalysisPriority(patched, {
            burstHardFilterEnabled: config?.burstHardFilterEnabled !== false
        });
        const PRIORITY_ORDER = { primary: 0, secondary: 1, review: 2 };
        if (Array.isArray(analysisJson.blogPosts)) {
            analysisJson.blogPosts.sort((a, b) => {
                const left = PRIORITY_ORDER[a?._meta?.priority] ?? 2;
                const right = PRIORITY_ORDER[b?._meta?.priority] ?? 2;
                return left - right;
            });
        }
        return res.json(analysisJson);
      } catch (error) {
        lastError = error;
        logger.warn(`[Analysis] [${api.name}] Failed with ${modelName}: ${error.message}. Retrying immediately with next model...`);
        continue;
      }
    }
    if (success) break;
  }

  logger.error(`[Analysis] All models across all APIs failed`, lastError?.message);
  res.status(500).json({ error: 'AI 분석 실패', details: lastError?.message });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function searchNaverKin(query) {
    if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) return [];
    logger.api(`[Enrich] Naver Kin(지식인) 검색 요청: "${query}"`);
    try {
        const res = await axios.get('https://openapi.naver.com/v1/search/kin.json', {
            params: { query, display: 3, sort: 'sim' },
            headers: {
                'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
                'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET
            }
        });
        return (res.data.items || []).map((item) => ({
            title: item.title.replace(/<[^>]+>/g, ''),
            summary: item.description.replace(/<[^>]+>/g, ''),
            url: item.link
        }));
    } catch (e) {
        if (e.response?.status === 429) {
            logger.warn('[Enrich] 네이버 지식인 429 Rate Limit. 3초 대기 후 재시도...');
            await sleep(3000);
            try {
                const retry = await axios.get('https://openapi.naver.com/v1/search/kin.json', {
                    params: { query, display: 3, sort: 'sim' },
                    headers: {
                        'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
                        'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET
                    }
                });
                return (retry.data.items || []).map((item) => ({
                    title: item.title.replace(/<[^>]+>/g, ''),
                    summary: item.description.replace(/<[^>]+>/g, ''),
                    url: item.link
                }));
            } catch (retryErr) {
                return [];
            }
        }
        return [];
    }
}

async function searchNaverNews(query) {
    if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) {
        logger.warn('[Enrich] NAVER API 키 누락. 팩트 보강 검색 생략.');
        return [];
    }
    logger.api(`[Enrich] Naver News 검색 요청: "${query}"`);
    const startTime = Date.now();
    try {
        const res = await axios.get('https://openapi.naver.com/v1/search/news.json', {
            params: { query, display: 5, sort: 'date' },
            headers: {
                'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
                'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET
            }
        });
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.success(`[Enrich] Naver News 검색 완료 (${elapsed}s, ${res.data.items.length}건)`);
        return res.data.items.map(item => ({
            title: item.title.replace(/<[^>]+>/g, ''),
            summary: item.description.replace(/<[^>]+>/g, ''),
            url: item.originallink || item.link,
            pubDate: item.pubDate
        }));
    } catch (e) {
        // ★ 429 명시적 처리
        if (e.response?.status === 429) {
            logger.warn('[Enrich] 네이버 뉴스 429 Rate Limit. 3초 대기 후 1회 재시도...');
            await sleep(3000);
            try {
                const retryStartTime = Date.now();
                const retry = await axios.get('https://openapi.naver.com/v1/search/news.json', {
                    params: { query, display: 5, sort: 'date' },
                    headers: {
                        'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
                        'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET
                    }
                });
                const elapsed = ((Date.now() - retryStartTime) / 1000).toFixed(2);
                logger.success(`[Enrich] Naver News 재시도 성공 (${elapsed}s, ${retry.data.items.length}건)`);
                return retry.data.items.map(item => ({
                    title: item.title.replace(/<[^>]+>/g, ''),
                    summary: item.description.replace(/<[^>]+>/g, ''),
                    url: item.originallink || item.link,
                    pubDate: item.pubDate
                }));
            } catch (retryErr) {
                logger.error(`[Enrich] Naver News 재시도 실패`, retryErr.message);
            }
        } else {
            logger.error(`[Enrich] Naver News 검색 실패`, e.message);
        }
        return [];
    }
}

async function searchNewsAPI(query) {
    if (!process.env.NEWS_API_KEY) {
        logger.warn('[Enrich] NEWS_API_KEY 누락. 영미권 팩트 보강 검색 생략.');
        return [];
    }
    logger.api(`[Enrich] NewsAPI 검색 요청: "${query}"`);
    const startTime = Date.now();
    try {
        const res = await axios.get('https://newsapi.org/v2/everything', {
            params: {
                q: query,
                language: 'en',
                sortBy: 'publishedAt',
                pageSize: 5,
                apiKey: process.env.NEWS_API_KEY
            }
        });
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        if (res.data.status !== 'ok') {
            logger.error(`[Enrich] NewsAPI 반환 오류 (${elapsed}s)`, res.data.message);
            return [];
        }
        const articles = res.data.articles || [];
        logger.success(`[Enrich] NewsAPI 검색 완료 (${elapsed}s, ${articles.length}건)`);
        return articles.map(item => ({
            title: item.title || '',
            summary: item.description || item.content || '',
            url: item.url,
            pubDate: item.publishedAt
        })).filter(item => item.title && item.url);
    } catch (e) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.error(`[Enrich] NewsAPI 검색 실패 (${elapsed}s)`, e.message);
        return [];
    }
}

async function enrichPostPlan(postPlan, region = 'KR') {
    try {
        normalizeSearchQueriesV30({ blogPosts: [postPlan] });
        const sq = postPlan.searchQueries && typeof postPlan.searchQueries === 'object' ? postPlan.searchQueries : {};
        const legacyNews = typeof sq.news === 'string' ? sq.news.trim() : '';
        const queryMain =
            (typeof sq.news_main === 'string' && sq.news_main.trim()) ||
            legacyNews ||
            postPlan.newsSearchQuery ||
            postPlan.targetKeyword ||
            postPlan.mainKeyword;
        const querySub =
            (typeof sq.news_sub === 'string' && sq.news_sub.trim()) ||
            postPlan.targetKeyword ||
            postPlan.mainKeyword;
        const queryKin = (typeof sq.kin === 'string' && sq.kin.trim()) || postPlan.mainKeyword;

        let newsMainResults = [];
        let newsSubResults = [];
        let kinResults = [];
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

        if (region === 'US') {
            newsMainResults = await searchNewsAPI(queryMain);
            if (newsMainResults.length === 0) newsMainResults = await searchNewsAPI(postPlan.mainKeyword);
            await sleep(500);
            newsSubResults = await searchNewsAPI(querySub);
            if (newsSubResults.length === 0 && querySub !== postPlan.mainKeyword) {
                newsSubResults = await searchNewsAPI(postPlan.mainKeyword);
            }
            newsMainResults = newsMainResults.filter((r) => new Date(r.pubDate) >= oneYearAgo);
            newsSubResults = newsSubResults.filter((r) => new Date(r.pubDate) >= oneYearAgo);
        } else {
            newsMainResults = await searchNaverNews(queryMain);
            if (newsMainResults.length === 0) newsMainResults = await searchNaverNews(postPlan.mainKeyword);
            newsMainResults = newsMainResults.filter((r) => new Date(r.pubDate) >= oneYearAgo);

            const searchBase = String(queryMain || '').trim();
            const cat = (postPlan.category || '').toLowerCase();
            if (cat.includes('finance')) {
                try {
                    const fssData = await getFssAlerts();
                    const matched = fssData.filter(
                        (item) => item.keyword.includes(searchBase) || searchBase.includes(item.keyword)
                    );
                    if (matched.length > 0) {
                        logger.info(`[Enrich] FSS 소비자경보 관련 팩트 발견 — 메인 트랙에 추가됨`);
                        newsMainResults.unshift(
                            ...matched.map((r) => ({
                                title: `[금융감독원 소비자경보] ${r.keyword}`,
                                summary: '금융감독원 공식 발표자료 (신뢰도 높음)',
                                url: r.url,
                                pubDate: r.pubDate
                            }))
                        );
                    }
                } catch (e) {
                    logger.warn(`[Enrich] FSS 연동 실패: ${e.message}`);
                }
            } else if (cat.includes('life') || cat.includes('health') || cat.includes('policy')) {
                try {
                    const policyData = await getPolicyBriefing();
                    const matched = policyData.filter(
                        (item) => item.keyword.includes(searchBase) || searchBase.includes(item.keyword)
                    );
                    if (matched.length > 0) {
                        logger.info(`[Enrich] 정책브리핑 관련 팩트 발견 — 메인 트랙에 추가됨`);
                        newsMainResults.unshift(
                            ...matched.map((r) => ({
                                title: `[정책브리핑] ${r.keyword}`,
                                summary: '대한민국 정책브리핑 공식 보도자료 (신뢰도 높음)',
                                url: r.url,
                                pubDate: r.pubDate
                            }))
                        );
                    }
                } catch (e) {
                    logger.warn(`[Enrich] 정책브리핑 연동 실패: ${e.message}`);
                }
            }

            await sleep(500);
            newsSubResults = await searchNaverNews(querySub);
            if (newsSubResults.length === 0) newsSubResults = await searchNaverNews(postPlan.targetKeyword || postPlan.mainKeyword);
            newsSubResults = newsSubResults.filter((r) => new Date(r.pubDate) >= oneYearAgo);

            await sleep(500);
            kinResults = await searchNaverKin(queryKin);
            if (kinResults.length === 0) kinResults = await searchNaverKin(postPlan.mainKeyword);
        }

        if (region === 'US') {
            if (newsMainResults.length === 0 && newsSubResults.length === 0) {
                logger.warn(`[Enrich] US 뉴스 결과 없음 — keyword: ${postPlan.mainKeyword}`);
                return postPlan;
            }
        } else if (newsMainResults.length === 0 && newsSubResults.length === 0 && kinResults.length === 0) {
            logger.warn(`[Enrich] 검색 결과 없음 — keyword: ${postPlan.mainKeyword}`);
            return postPlan;
        }

        const factMain = newsMainResults.slice(0, 2).map((r) => `[메인 뉴스] ${r.title} - ${r.summary}`);
        const factSub = newsSubResults.slice(0, 2).map((r) => `[보조 뉴스] ${r.title} - ${r.summary}`);
        const factKin = kinResults.slice(0, 2).map((r) => `[실제 고민/사례] ${r.title} - ${r.summary}`);

        const officialUrls = [...newsMainResults.slice(0, 2), ...newsSubResults.slice(0, 2)]
            .filter((r) => r.url)
            .map((r) => `- [${r.title}](${r.url})`);

        logger.success(
            `[Enrich] 2:2:2 밸런스 보강 완료 (메인 ${factMain.length}건, 보조 ${factSub.length}건, 지식인 ${factKin.length}건) — ${postPlan.mainKeyword}`
        );

        return {
            ...postPlan,
            enrichedFacts: {
                newsMain: factMain,
                newsSub: factSub,
                kin: factKin,
                sourceUrls: officialUrls,
                fetchedAt: new Date().toISOString()
            }
        };
    } catch (err) {
        logger.error(`[Enrich] 팩트 보강 실패: ${err.message}`);
        return postPlan;
    }
}

app.post('/api/generate-post', async (req, res) => {
  // [v2.6] useSearch 기본값 false (opt-in). 클라이언트에서 명시적으로 true 를 넘길 때만 Grounding 활성화.
  const { postPlan: rawPostPlan, region = 'KR', useSearch = false } = req.body;
  const { prompt: prebuiltPrompt, postPlan, tags, angle, lang } = await buildPostGenerationPromptInput({ rawPostPlan, region });

  const modelsToTry = await getBestModels();
  
  let lastError = null;
  let bodyMarkdown = '';
  
  const apiKey1 = process.env.GEMINI_API_KEY;
  const apiKey2 = process.env.GEMINI_API_KEY_2;
  const apis = [
      { name: 'API_1', key: apiKey1 },
      { name: 'API_2', key: apiKey2 }
  ].filter(api => api.key);

  // 1. 본문 생성 (이미지 URL 없이 먼저 생성)
  for (const api of apis) {
    const currentGenAI = new GoogleGenerativeAI(api.key);
    let success = false;

    for (let i = 0; i < modelsToTry.length; i++) {
      const modelName = modelsToTry[i];
      
      if (shouldSkipModel(api.name, modelName)) {
              logger.process(`[Post Gen] [${api.name}] Model ${modelName} is flash and version < 3. Switching to API_2 after 3s...`);
              await new Promise(r => setTimeout(r, 3000));
              break; // Skip to next API
          }
      
      try {
        logger.process(`[Post Gen] [${api.name}] Generating content with ${modelName} (Region: ${region}, Search: ${useSearch})`);
        
        // [Google Search Grounding] 실시간 검색 도구 활성화 조건
        const supportsTools = !modelName.includes('lite') && !modelName.includes('gemma');
        const tools = (useSearch && supportsTools) ? [{ googleSearchRetrieval: {} }] : undefined;

        const model = currentGenAI.getGenerativeModel({ 
            model: modelName,
            tools: tools,
            generationConfig: {
                temperature: 0.75,
                topP: 0.85
            }
        });
        
        // [가드] AI가 'Expose', 'expose/guide', 'expose (폭로)' 등 enum 외 값을 돌려줄 경우
        //        `post_writing_${angle}` task 조회 실패 → 본문 생성 전체 크래시 방지
        const prompt = prebuiltPrompt;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        bodyMarkdown = response.text().trim().replace(/^```markdown|```$/g, "").trim();
        
        if (bodyMarkdown.startsWith('---')) {
            const parts = bodyMarkdown.split('---');
            if (parts.length >= 3) {
                bodyMarkdown = parts.slice(2).join('---').trim();
            }
        }

        logger.success(`[Post Gen] [${api.name}] Content generated successfully with ${modelName}`);
        success = true;
        break; // 성공하면 루프 탈출
      } catch (error) {
        lastError = error;
        logger.warn(`[Post Gen] [${api.name}] Failed with ${modelName}: ${error.message}. Retrying immediately with next model...`);
        continue;
      }
    }
    if (success) break;
  }
  
  if (!bodyMarkdown) {
      logger.error(`[Post Gen] All models across all APIs failed`, lastError?.message);
      return res.status(500).json({ error: '본문 생성 실패' });
  }

  // [v2.6] References URL 검증 & 도메인 루트 자동 축약
  //        - Gemini hallucination deep-link 로 인한 404 를 이미지 치환 전에 먼저 정리.
  //        - 실패해도 전체 포스팅을 막지 않도록 try/catch 로 감싸 안전 폴백.
  try {
      bodyMarkdown = await verifyAndFixReferences(bodyMarkdown);
  } catch (e) {
      logger.error('[References] verifyAndFixReferences 실패 (원본 유지)', e.message);
  }

  // [v2.8] FAQPage JSON-LD 코드블록 제거
  // front matter faq: 배열을 통해 테마에서 자동 삽입되므로 본문 노출은 제거
  bodyMarkdown = bodyMarkdown.replace(
      /```json[\s\S]*?"@type"\s*:\s*"FAQPage"[\s\S]*?```/g,
      ''
  ).trim();
  bodyMarkdown = normalizeDiagramShortcodes(bodyMarkdown).trim();
  bodyMarkdown = sanitizeMermaidBlocks(bodyMarkdown).trim();
  bodyMarkdown = bodyMarkdown.replace(/\n{3,}/g, '\n\n').trim();

  const usedImageUrls = new Set(); // 포스팅 단위 중복 이미지 방지용 Set

  // 2. 썸네일 생성 (title 기반)
  const selectedTitle = postPlan.viralTitles ? 
      (postPlan.viralTitles.dataDriven || postPlan.viralTitles.curiosity || postPlan.viralTitles.solution || postPlan.mainKeyword) : 
      postPlan.viralTitle;
  // [v2.8] 내부 분석 메트릭이 제목에 노출되는 경우 안전한 제목으로 대체
  const internalMetricPattern = /경쟁[률율]?\s*[\d.]+|블루오션|painScore|competitionIndex|searchVolume|documentCount|\b0\.\d{2}\b|blue ocean|competition index/i;
  const safeTitle = internalMetricPattern.test(String(selectedTitle || ''))
      ? (postPlan.viralTitles?.curiosity || postPlan.viralTitles?.solution || postPlan.mainKeyword || selectedTitle)
      : selectedTitle;
  
  let thumbnailSearchKeyword = safeTitle;
  let skipThumbnailTranslation = false;

  if (region === 'US') {
      skipThumbnailTranslation = true;
  } else if (postPlan.imageSearchKeywords && postPlan.imageSearchKeywords.length > 0) {
      // 한국어라도 기획안에 이미 영어 검색 키워드가 준비되어 있다면 그것을 사용하고 번역을 건너뜁니다.
      thumbnailSearchKeyword = postPlan.imageSearchKeywords[0];
      skipThumbnailTranslation = true;
  }

  logger.process(`[Image Fetch] Fetching thumbnail for keyword: ${thumbnailSearchKeyword} (Title: ${safeTitle})`);
  const thumbnailUrl = await getRandomImage(thumbnailSearchKeyword, true, skipThumbnailTranslation, usedImageUrls);

  // 3. 본문 내 이미지 치환 (Alt 텍스트 + 영문 키워드 기반)
  // [Case A] 마크다운 문법을 지킨 경우: ![alt](URL "title")
  const bodyImageRegex = /!\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/g;
  const bodyMatches = [...bodyMarkdown.matchAll(bodyImageRegex)];
  
  const engKeywords = Array.isArray(postPlan.imageSearchKeywords) ? postPlan.imageSearchKeywords : [];
  let placeholderIndex = 0;

  for (const match of bodyMatches) {
      const fullMatch = match[0];
      const altText = match[1];
      const placeholderUrl = match[2];
      const englishKeyword = match[3];

      // 오타 방지: IMAGE_PLACEHOLDER가 아닌 IMAGE_PLACEER 등 다양한 오타 대응
      if (placeholderUrl.includes('IMAGE_PLACE')) {
          const searchKeyword = englishKeyword || engKeywords[placeholderIndex] || altText;
          const skipTranslation = !!englishKeyword || !!engKeywords[placeholderIndex] || region === 'US';
          const realImageUrl = await getRandomImage(searchKeyword, false, skipTranslation, usedImageUrls);
          
          if (realImageUrl) {
              // [S2] 영문 title 속성 보존 → 이미지 SEO 신호 유지
              const titleToUse = englishKeyword || engKeywords[placeholderIndex] || searchKeyword;
              const titlePart = titleToUse ? ` "${String(titleToUse).replace(/"/g, '\\"')}"` : '';
              const replacement = `![${altText}](${realImageUrl}${titlePart})`;
              bodyMarkdown = bodyMarkdown.replace(fullMatch, replacement);
          }
          placeholderIndex++;
      }
  }

  // [Case B] AI가 문법을 빼먹고 플레이스홀더만 생으로 출력한 경우: IMAGE_PLACEHOLDER_N (또는 망가진 마크다운)
  // 오타 방지를 위해 정규식을 IMAGE_PLACE[A-Z_]*\d+ 형태로 유연하게 변경
  const rawPlaceholderRegex = /<img[^>]*IMAGE_PLACE[A-Z_]*\d+[^>]*>|!?\[[^\]]*\]\s*\(\s*[^)]*IMAGE_PLACE[A-Z_]*\d+[^)]*\)|!?\[\s*IMAGE_PLACE[A-Z_]*\d+\s*\]|IMAGE_PLACE[A-Z_]*\d+/g;
  const rawMatches = [...bodyMarkdown.matchAll(rawPlaceholderRegex)];
  let sharedPlaceholderIndex = placeholderIndex;

  for (const match of rawMatches) {
      const fullMatch = match[0]; // IMAGE_PLACEHOLDER_2, IMAGE_PLACEER_2 등
      logger.warn(`[Image Fetch] AI omitted markdown for ${fullMatch}. Applying fallback replacement.`);
      
      let fallbackSearchKeyword = postPlan.mainKeyword;
      let skipFallbackTranslation = region === 'US';

      if (region !== 'US' && postPlan.imageSearchKeywords && postPlan.imageSearchKeywords.length > 0) {
          fallbackSearchKeyword = postPlan.imageSearchKeywords[sharedPlaceholderIndex]
              || postPlan.imageSearchKeywords[Math.floor(Math.random() * postPlan.imageSearchKeywords.length)];
          skipFallbackTranslation = true;
      }

      const realImageUrl = await getRandomImage(fallbackSearchKeyword, false, skipFallbackTranslation, usedImageUrls);
      if (realImageUrl) {
          // [S2] fallback 경로도 title 속성 포함 (imageSearchKeywords 우선, 없으면 mainKeyword)
          const fallbackEng = (region !== 'US' && postPlan.imageSearchKeywords && postPlan.imageSearchKeywords.length)
              ? (postPlan.imageSearchKeywords[sharedPlaceholderIndex] || postPlan.imageSearchKeywords[0])
              : fallbackSearchKeyword;
          const titlePart = fallbackEng ? ` "${String(fallbackEng).replace(/"/g, '\\"')}"` : '';
          const replacement = `\n\n![${postPlan.mainKeyword}](${realImageUrl}${titlePart})\n\n`;
          bodyMarkdown = bodyMarkdown.replace(fullMatch, replacement);
      }
      sharedPlaceholderIndex++;
  }

  // 4. Hugo Front-matter 구성
  let selectedCategory = postPlan.category || "Tech and IT";
  selectedCategory = selectedCategory.replace(/&/g, 'and').replace(/\s+/g, ' ').trim();

  const currentDate = new Date().toISOString().split('T')[0];

  // [v3.0] 슬러그: AI slug 제거 → imageSearchKeywords[0](영문) 우선 → mainKeyword 번역 fallback
  const slugSource = (Array.isArray(postPlan.imageSearchKeywords) && postPlan.imageSearchKeywords[0]) || postPlan.mainKeyword;
  const fallbackSource = postPlan.mainKeyword || safeTitle;
  const finalSlug = makeUniqueSlug(slugSource, fallbackSource, `${postPlan.mainKeyword}|${selectedCategory}`);

  // [v2.4] 본문 후처리: ① 인터널 링크 자동 삽입 → ② 쿠팡 파트너스 박스
  const baseUrl = 'https://gunbin.github.io';
  // [S1] 현재 글의 태그를 전달해 의미 매칭 품질 향상
  bodyMarkdown = injectInternalLinks(bodyMarkdown, finalSlug, lang, baseUrl, tags);

  // [C1] 본문에 유동 삽입된 `{{coupangLink:상품명}}` 마커를 우선 처리
  //      (AI가 본문 맥락에 맞춰 스스로 삽입한 상품명으로 쿠팡 박스 생성)
  const dynamicCoupangRegex = /\{\{coupangLink:([^}]+?)\}\}/g;
  const dynamicMatches = [...bodyMarkdown.matchAll(dynamicCoupangRegex)];
  let dynamicInjected = 0;
  for (const m of dynamicMatches) {
      const rawKeyword = (m[1] || '').trim();
      if (!rawKeyword) continue;
      // 카테고리 미적격이거나 박스 생성 실패 시 마커와 주변 공백을 제거
      const box = buildCoupangBox(rawKeyword, selectedCategory, lang);
      const markerPattern = new RegExp(`\\n*[ \\t]*${escapeRegex(m[0])}[ \\t]*\\n*`, '');
      if (box && dynamicInjected === 0) {
          bodyMarkdown = bodyMarkdown.replace(markerPattern, '\n\n' + box + '\n\n');
          dynamicInjected++;
      } else {
          bodyMarkdown = bodyMarkdown.replace(markerPattern, '\n\n');
      }
  }
  if (dynamicInjected > 0) {
      logger.success(`[Coupang] Dynamic box injected (${dynamicInjected}x) from in-body markers`);
  }

  // [하위 호환] 기존 {{coupangLink}} 단독 마커 처리 (기획단계 shoppableKeyword 기반)
  const legacyMarker = '{{coupangLink}}';
  if (bodyMarkdown.includes(legacyMarker)) {
      const legacyBox = buildCoupangBox(postPlan.shoppableKeyword, selectedCategory, lang);
      // 앞뒤 빈 줄까지 흡수하도록 패턴 매칭 (이중 공백 방지)
      const legacyPattern = /\n*[ \t]*\{\{coupangLink\}\}[ \t]*\n*/g;
      if (legacyBox && dynamicInjected === 0) {
          bodyMarkdown = bodyMarkdown.replace(legacyPattern, '\n\n' + legacyBox + '\n\n');
      } else {
          // 이미 동적 박스가 삽입됐거나 기획단계 키워드가 없으면 마커만 제거
          bodyMarkdown = bodyMarkdown.replace(legacyPattern, '\n\n');
      }
  }

  // [C2] References `<small>...</small>` 블록에서 URL 없는 단독 출처 라인 제거
  //      (존재하지 않는 보고서/예보명 등 AI fabrication 방지)
  bodyMarkdown = bodyMarkdown.replace(/<small>([\s\S]*?)<\/small>/g, (full, inner) => {
      if (!/\[References\]/i.test(inner)) return full; // References 블록만 처리
      const lines = inner.split(/<br\s*\/?>/i);
      const kept = lines.filter(line => {
          const trimmed = line.trim();
          if (!trimmed) return true; // 빈 줄은 포맷 유지용
          // 헤더 라벨/이탤릭 태그 라인은 보존
          if (/^(<i>\s*)?\[References\]/i.test(trimmed)) return true;
          if (/^(<\/i>|<i>)$/.test(trimmed)) return true;
          // 출처 항목인 경우: 마크다운 링크 `[...](http...)` 포함 여부 체크
          const isSourceItem = /^-\s/.test(trimmed);
          if (!isSourceItem) return true; // 출처 항목이 아니면 그대로 유지
          return /\]\(\s*https?:\/\//i.test(trimmed);
      });
      return `<small>${kept.join('<br>')}</small>`;
  });

  // 연속 빈 줄 정규화 (쿠팡 박스/마커 제거로 인한 3줄 이상 공백 정리)
  bodyMarkdown = bodyMarkdown.replace(/\n{3,}/g, '\n\n').trim();

  // [S5] 목록 페이지 요약 제어용 `<!--more-->` 자동 삽입 (첫 H2 직전)
  if (!bodyMarkdown.includes('<!--more-->')) {
      const firstH2Match = bodyMarkdown.match(/^##\s/m);
      if (firstH2Match && typeof firstH2Match.index === 'number' && firstH2Match.index > 0) {
          const pivot = firstH2Match.index;
          bodyMarkdown = bodyMarkdown.slice(0, pivot).trimEnd() +
              '\n\n<!--more-->\n\n' +
              bodyMarkdown.slice(pivot);
      }
  }

  // [v2.4] FAQ 추출 → frontmatter faq: 배열 (Hugo head에서 JSON-LD로 변환됨)
  const aiFaq = Array.isArray(postPlan.faq) ? postPlan.faq.filter(x => x && x.q && x.a) : [];
  const extractedFaq = extractFaqFromMarkdown(bodyMarkdown);
  const faqList = aiFaq.length ? aiFaq : extractedFaq;

  const yamlEscape = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  let faqYaml = '';
  if (faqList.length) {
      const items = faqList.slice(0, 6).map(f => `  - q: "${yamlEscape(f.q)}"\n    a: "${yamlEscape(f.a)}"`).join('\n');
      faqYaml = `faq:\n${items}\n`;
  }

  const hugoHeader = `---
author: "TrendRadar"
title: "${yamlEscape(safeTitle)}"
date: ${currentDate}
lastmod: ${currentDate}
slug: "${finalSlug}"
tags: [${tags.map(t => `"${yamlEscape(t)}"`).join(', ')}]
description: "${yamlEscape(postPlan.metaDescription || '')}"
categories: ["${yamlEscape(selectedCategory)}"]
thumbnail: "${thumbnailUrl}"
${faqYaml}---

`;

  // [v2.4] 클라이언트가 publish/push 시 함께 보낼 수 있도록 인덱스 메타도 응답에 포함
  const indexEntry = {
    slug: finalSlug,
    mainKeyword: postPlan.mainKeyword || '',
    angleType: postPlan.angleType || '',
    lsiKeywords: Array.isArray(postPlan.lsiKeywords) ? postPlan.lsiKeywords : [],
    coreEntities: Array.isArray(postPlan.coreEntities) ? postPlan.coreEntities : [],
    // [S1] 인터널 링크 의미 매칭용 — 현재 글의 tags 를 인덱스에 저장
    tags: Array.isArray(tags) ? tags : [],
    category: selectedCategory,
    lang
  };

  return res.json({ markdown: hugoHeader + bodyMarkdown, indexEntry });
});

async function processMarkdownImagesToCloudinary(markdown) {
  let processedMarkdown = markdown;
  
  // 1. 썸네일 URL 매칭 (프론트매터의 thumbnail: "URL")
  const thumbnailRegex = /thumbnail:\s*"(https?:\/\/[^"]+)"/;
  const thumbMatch = processedMarkdown.match(thumbnailRegex);
  if (thumbMatch) {
      const rawUrl = thumbMatch[1];
      // 이미 Cloudinary URL이 아닌 경우에만 업로드
      if (!rawUrl.includes('res.cloudinary.com')) {
          logger.process(`[Cloudinary Upload] Uploading thumbnail: ${rawUrl}`);
          const cloudinaryUrl = await uploadToCloudinary(rawUrl);
          if (cloudinaryUrl) {
              processedMarkdown = processedMarkdown.replace(rawUrl, cloudinaryUrl);
          }
      }
  }

  // 2. 본문 이미지 매칭 (![alt](URL "title") 또는 ![alt](URL))
  const bodyImageRegex = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g;
  const bodyMatches = [...processedMarkdown.matchAll(bodyImageRegex)];

  for (const match of bodyMatches) {
      const rawUrl = match[2];
      if (!rawUrl.includes('res.cloudinary.com')) {
          logger.process(`[Cloudinary Upload] Uploading body image: ${rawUrl}`);
          const cloudinaryUrl = await uploadToCloudinary(rawUrl);
          if (cloudinaryUrl) {
              processedMarkdown = processedMarkdown.replace(rawUrl, cloudinaryUrl);
          }
      }
  }
  
  return processedMarkdown;
}

// frontmatter에서 slug 파싱 (publish/push 시 파일명에 사용)
function extractSlugFromMarkdown(markdown) {
  const m = markdown.match(/^---[\s\S]*?\nslug:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

app.post('/api/publish', async (req, res) => {
  let { markdown, region = 'KR', indexEntry } = req.body;
  if (!markdown) return res.status(400).json({ error: 'Markdown content missing' });

  // 배포 시점에 일괄적으로 Cloudinary에 업로드 후 치환
  markdown = await processMarkdownImagesToCloudinary(markdown);

  const lang = region === 'US' ? 'en' : 'ko';
  // [v2.4] 파일명: slug 기반 (frontmatter 우선) → fallback: timestamp
  const slug = (indexEntry && indexEntry.slug) || extractSlugFromMarkdown(markdown) || `trend-${Date.now()}`;
  const filename = `${slug}.md`;

  const targetDir = path.join(process.cwd(), '..', 'autoHugoBlog', 'content', lang, 'blog');
  const filePath = path.join(targetDir, filename);

  try {
      if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
      }
      fs.writeFileSync(filePath, markdown, 'utf8');
      logger.success(`[Publish] Saved markdown file to ${filePath}`);

      // [v2.4] 카니발 방지 인덱스 append (30일 prune 동시 수행)
      if (indexEntry && indexEntry.slug) {
          appendPublishedIndex({ ...indexEntry, lang, publishedAt: new Date().toISOString() });
      }

      res.json({ success: true, filePath: `/content/${lang}/blog/${filename}` });
  } catch (error) {
      logger.error("[Publish Error]", error.message);
      res.status(500).json({ error: 'Failed to write markdown file to Hugo' });
  }
});

app.post('/api/push-github', async (req, res) => {
  let { markdown, region = 'KR', indexEntry } = req.body;
  if (!markdown) return res.status(400).json({ error: 'Markdown content missing' });

  // 깃허브 푸시 시점에 일괄적으로 Cloudinary에 업로드 후 치환
  markdown = await processMarkdownImagesToCloudinary(markdown);

  if (!process.env.GITHUB_TOKEN) {
      logger.error("[GitHub Push Error]", "GITHUB_TOKEN is not defined in .env");
      return res.status(500).json({ error: 'GITHUB_TOKEN is missing in server environment.' });
  }

  const lang = region === 'US' ? 'en' : 'ko';
  // [v2.4] 파일명: slug 기반 (frontmatter 우선) → fallback: timestamp
  const slug = (indexEntry && indexEntry.slug) || extractSlugFromMarkdown(markdown) || `trend-${Date.now()}`;
  const filename = `${slug}.md`;
  const repoOwner = 'Gunbin';
  const repoName = 'gunbin.github.io';
  // GitHub API requires the exact file path inside the repository
  const githubFilePath = `content/${lang}/blog/${filename}`;
  const apiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${githubFilePath}`;

  try {
      logger.process(`[GitHub Push] Pushing directly to GitHub via REST API...`);

      // Base64 encode the markdown content
      const base64Content = Buffer.from(markdown, 'utf8').toString('base64');

      const response = await axios.put(apiUrl, {
          message: `Auto-post: Add trend content ${filename}`,
          content: base64Content,
          branch: 'main' // Change this if your default branch is 'master'
      }, {
          headers: {
              'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
              'Accept': 'application/vnd.github.v3+json'
          }
      });

      logger.success(`[GitHub Push] Successfully pushed to GitHub: ${response.data.content.html_url}`);

      // [v2.4] 카니발 방지 인덱스 append (30일 prune 동시 수행)
      if (indexEntry && indexEntry.slug) {
          appendPublishedIndex({ ...indexEntry, lang, publishedAt: new Date().toISOString() });
      }

      // [Google Indexing API] 즉각적인 색인 요청 트리거
      if (indexEntry && indexEntry.slug) {
          const liveUrl = `https://gunbin.github.io/${lang === 'en' ? 'en/' : ''}blog/${indexEntry.slug}/`;
          triggerGoogleIndexing(liveUrl).catch(err => logger.error('[Indexing API Error]', err));
      }

      res.json({ success: true, filePath: githubFilePath, url: response.data.content.html_url });
  } catch (error) {
      logger.error("[GitHub Push Error]", error.response?.data?.message || error.message);
      res.status(500).json({
          error: 'Failed to push to GitHub directly',
          details: error.response?.data?.message || error.message
      });
  }
});

// --- Freshness Update Helpers ---
function applyFreshnessUpdate(contentStr, updateLine) {
    let updated = contentStr;
    const today = new Date().toISOString().split('T')[0];

    // 1) front matter lastmod 갱신/추가
    if (/^lastmod:\s*.+$/m.test(updated)) {
        updated = updated.replace(/^lastmod:\s*.+$/m, `lastmod: ${today}`);
    } else if (/^date:\s*.+$/m.test(updated)) {
        updated = updated.replace(/^date:\s*.+$/m, (m) => `${m}\nlastmod: ${today}`);
    }

    // 2) 업데이트 노트는 본문 상단(첫 H2 직전)에 삽입
    const firstH2Regex = /^(##\s+.+)$/m;
    if (firstH2Regex.test(updated)) {
        updated = updated.replace(firstH2Regex, `${updateLine}\n\n$1`);
    } else {
        // H2가 없으면 본문 끝에 fallback
        updated += `\n\n${updateLine}`;
    }
    return updated;
}

async function getLatestNaverNews(keyword) {
    if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) {
        throw new Error('Naver API keys are missing in .env');
    }
    const response = await axios.get('https://openapi.naver.com/v1/search/news.json', {
        params: { query: keyword, display: 1, sort: 'date' },
        headers: {
            'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
            'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET
        }
    });
    if (response.data && response.data.items && response.data.items.length > 0) {
        return response.data.items[0].title.replace(/<[^>]*>?/g, '').replace(/&quot;/g, '"');
    }
    throw new Error('No news found for keyword: ' + keyword);
}

app.post('/api/refresh-oldest', async (req, res) => {
    try {
        const targetDays = Number(req.body.refreshDays) || 30;
        const index = prunePublishedIndex(readPublishedIndex());
        const now = Date.now();
        const DAY = 86400000;

        const candidates = index.filter(p => {
            if (!p.publishedAt) return false;
            const isOldEnough = (now - new Date(p.publishedAt).getTime()) > targetDays * DAY;
            const notRefreshedRecently = !p.lastRefreshedAt || (now - new Date(p.lastRefreshedAt).getTime()) > 7 * DAY;
            return isOldEnough && notRefreshedRecently;
        }).sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime());

        if (candidates.length === 0) {
            return res.json({ success: false, message: `No post found older than ${targetDays} days that hasn't been refreshed recently.` });
        }

        const target = candidates[0];
        logger.process(`[Refresh] Target found: ${target.slug} (published: ${target.publishedAt})`);

        let newsTitle = target.mainKeyword;
        try {
            newsTitle = await getLatestNaverNews(target.mainKeyword);
            logger.process(`[Refresh] Fetched news: ${newsTitle}`);
        } catch (e) {
            logger.warn(`[Refresh] Naver news fetch failed, falling back to keyword. ${e.message}`);
        }

        const modelsToTry = await getBestModels();
        const liteModels = modelsToTry.filter(m => m.includes('flash') || m.includes('lite'));
        if (liteModels.length === 0) liteModels.push(modelsToTry[0]);
        
        const apiKey1 = process.env.GEMINI_API_KEY;
        const apiKey2 = process.env.GEMINI_API_KEY_2;
        const apis = [{ name: 'API_1', key: apiKey1 }, { name: 'API_2', key: apiKey2 }].filter(a => a.key);

        let summary = '';
        for (const api of apis) {
            if (summary) break;
            const genAI = new GoogleGenerativeAI(api.key);
            for (const modelName of liteModels) {
                try {
                    const model = genAI.getGenerativeModel({ model: modelName });
                    const prompt = target.lang === 'en'
                        ? `Summarize this news title into one short sentence (under 10 words): "${newsTitle}"`
                        : `다음 뉴스 제목을 50자 이내의 짧은 한 문장으로 요약해줘: "${newsTitle}"`;
                    const result = await model.generateContent(prompt);
                    summary = result.response.text().trim();
                    break;
                } catch (e) { continue; }
            }
        }

        if (!summary) throw new Error('Failed to generate summary via Gemini');
        logger.success(`[Refresh] Generated summary: ${summary}`);

        const repoOwner = 'Gunbin';
        const repoName = 'gunbin.github.io';
        const githubFilePath = `content/${target.lang === 'en' ? 'en' : 'ko'}/blog/${target.slug}.md`;
        const apiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${githubFilePath}`;

        const getResponse = await axios.get(apiUrl, {
            headers: { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
        });

        let contentStr = Buffer.from(getResponse.data.content, 'base64').toString('utf8');
        const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '.').substring(2);
        const updateLine = target.lang === 'en'
            ? `> **Updated (${dateStr}):** ${summary}`
            : `> **업데이트 (${dateStr}):** ${summary}`;

        contentStr = applyFreshnessUpdate(contentStr, updateLine);
        const base64Content = Buffer.from(contentStr, 'utf8').toString('base64');

        const putResponse = await axios.put(apiUrl, {
            message: `Auto-refresh: Update ${target.slug} with latest news`,
            content: base64Content,
            sha: getResponse.data.sha,
            branch: 'main'
        }, {
            headers: { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
        });

        target.lastRefreshedAt = new Date().toISOString();
        const allIndex = prunePublishedIndex(readPublishedIndex());
        const targetIndex = allIndex.findIndex(p => p.slug === target.slug && p.lang === target.lang);
        if (targetIndex !== -1) {
            allIndex[targetIndex].lastRefreshedAt = target.lastRefreshedAt;
            writePublishedIndex(allIndex);
        }

        // Trigger Google Indexing if available
        const liveUrl = `https://gunbin.github.io/${target.lang === 'en' ? 'en/' : ''}blog/${target.slug}/`;
        triggerGoogleIndexing(liveUrl).catch(err => logger.error('[Refresh Indexing Error]', err));

        res.json({ success: true, message: `Successfully refreshed post: ${target.slug}`, url: putResponse.data.content.html_url });
    } catch (error) {
        logger.error('[Refresh Error]', error.message || error);
        res.status(500).json({ success: false, error: 'Refresh failed', details: error.response?.data?.message || error.message });
    }
});

export { calcSeoViabilityScore, annotateAnalysisPriority };

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && fileURLToPath(new URL(`file://${process.argv[1]}`)) === __filename;

if (isMain) {
    const PORT = process.env.PORT || 3000;
    const server = app.listen(PORT, () => {
        logger.success(`TrendRadar v2.0 running at http://localhost:${PORT}`);
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            logger.error(`Port ${PORT} is already in use. Please close the other process or use a different port (e.g., set PORT=3001 in .env).`);
            process.exit(1);
        } else {
            logger.error('Server error:', err);
        }
    });
}
