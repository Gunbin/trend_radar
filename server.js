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
const PUBLISHED_INDEX_TTL_DAYS = 30;
const MODELS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6시간

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

    try {
        const response = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
        
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
        
        // 너무 많은 모델을 시도할 필요는 없으므로 상위 10개만 유지
        cachedModels = models.slice(0, 10);
        cachedModelsAt = Date.now();
        logger.info(`[System] Dynamically loaded ${cachedModels.length} models (TTL 6h). Highest intelligence: ${cachedModels[0]}`);
        return cachedModels;

    } catch (error) {
        logger.error("[System] Failed to fetch models dynamically. Using reliable fallback list.");
        return [
            "gemini-3.1-pro-preview",
            "gemini-3-pro-preview",
            "gemini-2.5-pro",
            "gemini-2.5-flash",
            "gemini-2.0-flash"
        ];
    }
}

// --- Translation Helper (For better image search) ---
async function translateToEnglish(keyword) {
  if (!keyword || keyword.trim() === '') return 'abstract';
  
  // Rate Limit (429) 에러 방지를 위해 번역 시도 전 3초 대기
  await new Promise(resolve => setTimeout(resolve, 3000));

  const prompt = `Translate the following Korean blog keyword into a simple, clear English search term for an image database (like Pexels/Pixabay). Output ONLY the English words, no punctuation or extra text. Keyword: "${keyword}"`;
  
  // getBestModels()를 통해 가용한 최적의 모델 목록을 가져와 순회
  const models = await getBestModels();
  
  for (const modelName of models) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      const response = await result.response;
      let translated = response.text().trim().replace(/["'.]/g, '');
      
      if (translated) {
        return translated;
      }
    } catch (error) {
      logger.error(`[Translation] Model ${modelName} failed: ${error.message}`);
      // 실패 시 다음 모델로 넘어가서 재시도
    }
  }

  // 모든 모델이 실패한 경우 원본 키워드를 반환
  logger.error('Translation Error: All dynamic models failed to translate.');
  return keyword;
}

// --- Image Fetchers ---

// 1. Pexels (Photos)
async function getPexelsImage(keyword) {
  try {
    const res = await axios.get(`https://api.pexels.com/v1/search?query=${encodeURIComponent(keyword)}&per_page=10`, {
      headers: { 'Authorization': process.env.PEXELS_API_KEY }
    });
    if (res.data.photos && res.data.photos.length > 0) {
      const randomIndex = Math.floor(Math.random() * Math.min(res.data.photos.length, 5));
      return res.data.photos[randomIndex].src.landscape;
    }
  } catch (error) {
    logger.error('Pexels API Error', error.message);
  }
  return null;
}

// 2. Pixabay (Photos, Illustrations, Vectors)
async function getPixabayImage(keyword, type = 'all', usedUrls = new Set()) {
  if (!process.env.PIXABAY_API_KEY) return null;
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
    if (res.data.hits && res.data.hits.length > 0) {
      // 섞인 후보군 생성
      const candidates = [...res.data.hits].sort(() => Math.random() - 0.5);
      for (const hit of candidates) {
        const url = hit.webformatURL;
        // 아직 본문에 사용되지 않은 신선한 URL만 선택
        if (!usedUrls.has(url)) {
          usedUrls.add(url); // 선택됨과 동시에 사용 목록에 기록
          return url;
        }
      }

      // 만약 30장이 전부 다 쓰였다면 (극히 드문 경우), 어쩔 수 없이 첫 번째 이미지를 반환
      const fallbackUrl = res.data.hits[0].webformatURL;
      usedUrls.add(fallbackUrl);
      return fallbackUrl;
    }

    // Fallback: If no results, try searching with only the first two words
    const simplified = keyword.split(' ').slice(0, 2).join(' ');
    if (simplified !== keyword) {
      return await getPixabayImage(simplified, type, usedUrls);
    }
  } catch (error) {
    logger.error('Pixabay API Error', error.message);
  }
  return null;
}
// 3. Openverse (Creative Commons)
async function getOpenverseImage(keyword) {
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
          return imageUrl; // Valid image found
        } catch (imgError) {
          logger.error('Openverse Image Broken (Skipping)', imageUrl);
          continue; // Try the next one
        }
      }
    }
  } catch (error) {
    logger.error('Openverse API Error', error.message);
  }
  return null;
}

// --- Cloudinary Upload Helper ---
async function uploadToCloudinary(url) {
  if (!url) return null;
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
      logger.success(`[Cloudinary] Uploaded image: ${optimizeUrl}`);
      return optimizeUrl;
  } catch (error) {
      logger.error('Cloudinary Upload Error', error.message);
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
    const lines = arr.slice(-50).map(it => `- ${it.mainKeyword}`).join('\n');
    return lang === 'ko'
        ? `\n\n[최근 30일 발행 이력 (중복/유사 주제 금지)]\n${lines}\n`
        : `\n\n[Published in the last 30 days (DO NOT repeat or paraphrase)]\n${lines}\n`;
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function injectInternalLinks(markdown, currentSlug, lang, baseUrl) {
    const candidates = prunePublishedIndex(readPublishedIndex()).filter(it =>
        it.lang === lang &&
        it.slug !== currentSlug &&
        it.mainKeyword // 핵심 키워드 존재 여부 확인
    );
    if (!candidates.length) return markdown;

    // 코드블록 / 인라인코드 / 이미지 / 기존 링크는 보호
    const protections = [];
    const stash = (str) => {
        const idx = protections.length;
        protections.push(str);
        return `\u0000P${idx}\u0000`;
    };
    let working = markdown
        .replace(/```[\s\S]*?```/g, m => stash(m))
        .replace(/`[^`\n]+`/g, m => stash(m))
        .replace(/!\[[^\]]*\]\([^)]+\)/g, m => stash(m))
        .replace(/\[[^\]]+\]\([^)]+\)/g, m => stash(m));

    let injected = 0;
    const MAX_LINKS = 3;
    const linked = new Set();
    const shuffled = [...candidates].sort(() => Math.random() - 0.5);

    for (const cand of shuffled) {
        if (injected >= MAX_LINKS) break;
        
        // coreEntities 대신 mainKeyword 우선 연결. mainKeyword가 너무 길면 coreEntities 활용 방안도 있으나,
        // 어색한 매칭(예: "정부")을 막기 위해 3글자 이상인 경우만 허용.
        const keywordsToTry = [cand.mainKeyword, ...(cand.coreEntities || [])].filter(Boolean);
        
        for (const ent of keywordsToTry) {
            if (injected >= MAX_LINKS) break;
            const ek = String(ent).trim();
            
            // 3글자 미만의 너무 짧은 단어는 무분별한 매칭을 유발하므로 제외
            if (ek.length < 3 || linked.has(ek)) continue;
            
            // 한글/영문 등 텍스트 경계를 고려 (완벽하진 않으나 띄어쓰기나 조사 앞부분 매칭 유도)
            // 너무 단순한 replace를 막기 위해
            const re = new RegExp(escapeRegex(ek));
            if (!re.test(working)) continue;
            
            const langSegment = cand.lang === 'en' ? '/en' : '/ko';
            const url = `${baseUrl.replace(/\/$/, '')}${langSegment}/blog/${cand.slug}/`;
            
            // 첫 번째 매칭되는 단어 하나만 치환 (전역 치환 아님)
            working = working.replace(re, `[${ek}](${url})`);
            linked.add(ek);
            injected++;
            break; // 한 문서당 하나의 링크만 걸기
        }
    }

    // 보호 블록 복원
    working = working.replace(/\u0000P(\d+)\u0000/g, (_, i) => protections[Number(i)] || '');
    if (injected > 0) logger.success(`[InternalLinks] Injected ${injected} link(s)`);
    return working;
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
        // 너무 일반적인 단어 차단
        if (/^(한국|오늘|뉴스|정보|이슈)$/i.test(s)) return;
        collected.push(s);
    };
    push(postPlan?.mainKeyword);
    if (Array.isArray(postPlan?.seoKeywords)) postPlan.seoKeywords.forEach(push);
    if (Array.isArray(postPlan?.lsiKeywords)) postPlan.lsiKeywords.slice(0, 3).forEach(push);
    if (Array.isArray(postPlan?.coreEntities)) postPlan.coreEntities.slice(0, 3).forEach(push);
    return collected.slice(0, 8);
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
  for (let i = 0; i <= retries; i++) {
    try {
      const data = await fetchFn();
      return data;
    } catch (error) {
      if (i < retries) {
        logger.warn(`[${name}] Error: ${error.message}. Retrying ${i+1}/${retries}...`);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        logger.error(`[${name}] Final Error`, error.message);
        return [];
      }
    }
  }
}

// 1. Google Trends (다국어 지원)
async function getGoogleTrends(geo = 'KR') {
  return fetchWithRetry('Google Trends', async () => {
    const res = await axios.get(`https://trends.google.com/trending/rss?geo=${geo}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(res.data);
    const items = result.rss.channel[0].item.slice(0, 10);
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
async function getSignalTrends() {
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
        return data.slice(0, 10).map((item, i) => ({
            rank: i + 1, keyword: item[1],
            status: item[2] === 's' ? 'SAME' : (item[2] === '+' ? 'UP' : 'DOWN'),
            change: item[3]
        }));
    }
    return [];
  });
}

// 3. Signal.bz (한국 전용)
async function getNamuwikiTrends() {
  return fetchWithRetry('Signal.bz', async () => {
    const res = await axios.get('https://api.signal.bz/news/realtime', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 5000
    });
    if (res.data && res.data.top10) {
        return res.data.top10.slice(0, 10).map((item) => ({
            rank: item.rank, keyword: item.keyword,
            status: item.state === 's' ? 'SAME' : (item.state === '+' ? 'UP' : 'DOWN'),
            summaryUrl: item.summary || null
        }));
    }
    return [];
  });
}

// 4. Reddit Trends (영미권 전용 - 인기 게시물 기반)
async function getRedditTrends() {
  return fetchWithRetry('Reddit Trends', async () => {
    const res = await axios.get('https://www.reddit.com/r/popular/top.json?limit=10', {
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

// 4-1. Reddit Scams (영미권 전용 - Loss Aversion)
async function getRedditScams() {
  return fetchWithRetry('Reddit Scams', async () => {
    const res = await axios.get('https://www.reddit.com/r/Scams/top.json?limit=10&t=day', {
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

// 4-2. Reddit Poverty Finance (영미권 전용 - Welfare)
async function getRedditPoverty() {
  return fetchWithRetry('Reddit PovertyFinance', async () => {
    const res = await axios.get('https://www.reddit.com/r/povertyfinance/top.json?limit=10&t=day', {
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

// 4-3. Reddit Frugal & LifeProTips (영미권 전용 - Smart Consumer)
async function getRedditFrugal() {
  return fetchWithRetry('Reddit Frugal', async () => {
    // Fetch both and interleave or just Frugal? Let's use Frugal for simplicity and impact
    const res = await axios.get('https://www.reddit.com/r/Frugal/top.json?limit=10&t=day', {
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

// 4-4. BuzzFeed Trending (영미권 전용 - Viral & Entertainment)
async function getBuzzFeedTrending() {
  return fetchWithRetry('BuzzFeed Trending', async () => {
    const res = await axios.get('https://www.buzzfeed.com/trending.xml', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 5000
    });
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(res.data);
    const items = result.rss.channel[0].item.slice(0, 10);
    return items.map((item, i) => ({
      rank: i + 1,
      keyword: item.title[0],
      url: item.link[0],
      pubDate: item.pubDate ? item.pubDate[0] : ''
    }));
  });
}

// 5. Yahoo News (영미권 전용 - RSS)
async function getYahooNewsRSS() {
  return fetchWithRetry('Yahoo News', async () => {
    const res = await axios.get('https://news.yahoo.com/rss/', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 5000
    });
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(res.data);
    const items = result.rss.channel[0].item.slice(0, 10);
    return items.map((item, i) => ({
      rank: i + 1,
      keyword: item.title[0],
      url: item.link[0],
      pubDate: item.pubDate ? item.pubDate[0] : ''
    }));
  });
}

// 6. 금융감독원 소비자경보 (한국 전용 - RSS 대신 HTML 스크래핑)
async function getFssAlerts() {
  return fetchWithRetry('FSS Alerts', async () => {
    const res = await axios.get('https://www.fss.or.kr/fss/bbs/B0000188/list.do?menuNo=200213', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 5000
    });
    const $ = cheerio.load(res.data);
    const alerts = [];
    $('.bd-list .title a').each((i, el) => {
        if (alerts.length >= 10) return false;
        const title = $(el).text().trim();
        let link = $(el).attr('href') || '';
        if (link.startsWith('?')) link = 'https://www.fss.or.kr/fss/bbs/B0000188/list.do' + link;
        
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

// 7. 정책브리핑 (한국 전용 - RSS)
async function getPolicyBriefing() {
  return fetchWithRetry('Policy Briefing', async () => {
    // https 연결 리셋(ECONNRESET) 방지를 위해 http 사용
    const res = await axios.get('http://www.korea.kr/rss/policy.xml', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 5000
    });
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(res.data);
    const items = result.rss.channel[0].item.slice(0, 10);
    return items.map((item, i) => ({
      rank: i + 1,
      keyword: item.title[0],
      url: item.link[0],
      pubDate: item.pubDate ? item.pubDate[0] : ''
    }));
  });
}

// 8. 뽐뿌 정보/강좌 게시판 (한국 전용 - 핫딜 대신 정보성 글 크롤링)
async function getPpomppuHotDeals() {
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
        if (deals.length >= 10) return false;
        
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

// 9. 바이럴 커뮤니티 베스트 (한국 전용 - 인스티즈 핫게시판 크롤링, 펨코 우회)
async function getInstizHot() {
  return fetchWithRetry('Instiz Hot', async () => {
    // 1. got-scraping을 사용하여 브라우저 지문 위장
    const { body } = await gotScraping({
        url: 'https://www.instiz.net/hot.htm?sid=pt',
        headerGeneratorOptions: {
            browsers: [
                { name: 'chrome', minVersion: 110 },
                { name: 'safari', minVersion: 15 },
                { name: 'firefox', minVersion: 110 }
            ],
            devices: ['desktop', 'mobile'], 
            locales: ['ko-KR', 'ko']
        },
        headers: { 
            'Referer': 'https://www.google.com/search?q=%EC%9D%B8%EC%8A%A4%ED%8B%B0%EC%A6%88',
        },
        timeout: {
            request: 10000
        }
    });
    const $ = cheerio.load(body);
    const bests = [];

    // 인스티즈 리스트 라인 추출
    $('.result_search a, .realchart_item_a').each((i, el) => {
        if (bests.length >= 10) return false;
        
        let link = $(el).attr('href') || '';
        if (link.startsWith('/')) link = 'https://www.instiz.net' + link;
        
        // title은 자식 요소인 h3.search_title에 있거나 (result_search), 그냥 text()에 있음 (realchart_item_a)
        let titleNode = $(el).find('.search_title');
        let title = titleNode.length ? titleNode.text() : $(el).text();
        
        title = title.replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim(); // 댓글수 제거 및 연속 공백 제거
        
        // 글 제목 필터링
        if (title && !title.includes('공지') && !link.includes('memo')) {
            bests.push({
                rank: bests.length + 1,
                keyword: `[인스티즈] ${title}`,
                url: link
            });
        }
    });
    
    return bests;
  });
}

// --- Google Indexing API Helper ---
async function triggerGoogleIndexing(urlToindex) {
  const keyPath = path.join(process.cwd(), 'blog-auto-posting-493814-55523dd2b0a8.json');
  if (!fs.existsSync(keyPath)) {
      logger.warn(`[Indexing API] Service account key not found at ${keyPath}. Skipping Google Indexing.`);
      return;
  }

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

      logger.success(`[Indexing API] Successfully requested indexing for: ${urlToindex}`);
  } catch (error) {
      logger.error(`[Indexing API Error] Failed to request indexing for ${urlToindex}: ${error.response?.data?.error?.message || error.message}`);
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

  const checkSource = (name) => sources.length === 0 || sources.includes(name);

  if (region === 'US') {
    const [google, reddit, yahoo, redditScams, redditPoverty, redditFrugal, buzzfeed] = await Promise.all([
      checkSource('google') ? getGoogleTrends('US') : Promise.resolve([]),
      checkSource('reddit') ? getRedditTrends() : Promise.resolve([]),
      checkSource('yahoo') ? getYahooNewsRSS() : Promise.resolve([]),
      checkSource('redditScams') ? getRedditScams() : Promise.resolve([]),
      checkSource('redditPoverty') ? getRedditPoverty() : Promise.resolve([]),
      checkSource('redditFrugal') ? getRedditFrugal() : Promise.resolve([]),
      checkSource('buzzfeed') ? getBuzzFeedTrending() : Promise.resolve([])
    ]);
    res.json({ 
        timestamp: new Date().toISOString(), 
        region, 
        google, reddit, yahoo, redditScams, redditPoverty, redditFrugal, buzzfeed
    });
  } else {
    const [google, signal, namu, fss, policy, ppomppu, instiz] = await Promise.all([
      checkSource('google') ? getGoogleTrends('KR') : Promise.resolve([]),
      checkSource('nate') ? getSignalTrends() : Promise.resolve([]),
      checkSource('signal') ? getNamuwikiTrends() : Promise.resolve([]),
      checkSource('fss') ? getFssAlerts() : Promise.resolve([]),
      checkSource('policy') ? getPolicyBriefing() : Promise.resolve([]),
      checkSource('ppomppu') ? getPpomppuHotDeals() : Promise.resolve([]),
      checkSource('instiz') ? getInstizHot() : Promise.resolve([])
    ]);
    res.json({
        timestamp: new Date().toISOString(),
        region,
        google, signal, namu, fss, policy, ppomppu, instiz
    });  }
});

app.post('/api/analyze', async (req, res) => {
  const { trends, manualText, config, region = 'KR' } = req.body; 
  const topicCount = config?.topicCount || 3;
  const lang = region === 'US' ? 'en' : 'ko';

  const modelsToTry = await getBestModels();
  let lastError = null;

  for (let i = 0; i < modelsToTry.length; i++) {
    const modelName = modelsToTry[i];
    try {
      logger.process(`[Analysis] Attempting with ${modelName} (Count: ${topicCount}, Region: ${region})`);
      const model = genAI.getGenerativeModel({ model: modelName });
      
      let prompt;
      if (manualText) {
          prompt = promptManager.getPrompt('manual_analysis', lang, {
            manual_text: manualText,
            topic_count: topicCount
          });
      } else {
          prompt = promptManager.getPrompt('trend_analysis', lang, {
            trends_data: JSON.stringify(trends),
            topic_count: topicCount
          });
      }
      // [v2.4] 카니발 방지: 최근 30일 발행 키워드를 negative context로 주입
      prompt += buildRecentKeywordsContext(lang);

      const result = await model.generateContent(prompt);
      const response = await result.response;
      let text = response.text().trim();
      text = text.replace(/^```(json)?|```$/gi, "").trim();
      
      const firstBrace = text.indexOf('{');
      const lastBrace = text.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        text = text.slice(firstBrace, lastBrace + 1);
      }
      
      logger.success(`[Analysis] Successful with ${modelName}`);
      return res.json(JSON.parse(text));
    } catch (error) {
      lastError = error;
      logger.warn(`[Analysis] Failed with ${modelName}: ${error.message}. Retrying immediately with next model...`);
      continue;
    }
  }
  logger.error(`[Analysis] All models failed`, lastError?.message);
  res.status(500).json({ error: 'AI 분석 실패', details: lastError?.message });
});

app.post('/api/generate-post', async (req, res) => {
  const { postPlan, region = 'KR' } = req.body;
  const lang = region === 'US' ? 'en' : 'ko';

  // [v2.4] 태그 자동 확장: mainKeyword + seoKeywords + lsi + coreEntities → 4~8개
  const tags = buildExpandedTags(postPlan);

  const modelsToTry = await getBestModels();
  
  let lastError = null;
  let bodyMarkdown = '';
  
  // 1. 본문 생성 (이미지 URL 없이 먼저 생성)
  for (let i = 0; i < modelsToTry.length; i++) {
    const modelName = modelsToTry[i];
    try {
      logger.process(`[Post Gen] Generating content with ${modelName} (Region: ${region})`);
      const model = genAI.getGenerativeModel({ model: modelName });
      
      const angle = postPlan.angleType || 'guide';
      const promptKey = `post_writing_${angle}`;

      const prompt = promptManager.getPrompt(promptKey, lang, {
        mainKeyword: postPlan.mainKeyword,
        searchIntent: postPlan.searchIntent,
        contentDepth: postPlan.contentDepth || 'Normal',
        conclusionType: postPlan.conclusionType || 'Q&A',
        coreFact: postPlan.coreFact || '최신 트렌드 데이터',
        coreEntities: postPlan.coreEntities ? (Array.isArray(postPlan.coreEntities) ? postPlan.coreEntities.join(', ') : postPlan.coreEntities) : '',
        subTopics: postPlan.subTopics ? (Array.isArray(postPlan.subTopics) ? postPlan.subTopics.join(', ') : postPlan.subTopics) : '',
        seoKeywords: tags.join(', '),
        lsiKeywords: postPlan.lsiKeywords ? (Array.isArray(postPlan.lsiKeywords) ? postPlan.lsiKeywords.join(', ') : postPlan.lsiKeywords) : '',
        coreMessage: postPlan.coreMessage,
        // v2.4: trafficStrategy.targetAudience를 본문 프롬프트의 어휘/예시 톤 가이드로 활용 (없으면 안전한 기본값)
        targetAudience: postPlan?.trafficStrategy?.targetAudience || postPlan?.targetAudience || '일반 독자',
        // 이미지 자리에 플레이스홀더 텍스트만 넣도록 유도하거나, 빈 URL 전달
        context_url_1: "IMAGE_PLACEHOLDER_1",
        context_url_2: "IMAGE_PLACEHOLDER_2",
        context_url_3: "IMAGE_PLACEHOLDER_3"
      });

      const result = await model.generateContent(prompt);
      const response = await result.response;
      bodyMarkdown = response.text().trim().replace(/^```markdown|```$/g, "").trim();
      
      if (bodyMarkdown.startsWith('---')) {
          const parts = bodyMarkdown.split('---');
          if (parts.length >= 3) {
              bodyMarkdown = parts.slice(2).join('---').trim();
          }
      }

      logger.success(`[Post Gen] Content generated successfully with ${modelName}`);
      break; // 성공하면 루프 탈출
    } catch (error) {
      lastError = error;
      logger.warn(`[Post Gen] Failed with ${modelName}: ${error.message}. Retrying immediately with next model...`);
      continue;
    }
  }
  
  if (!bodyMarkdown) {
      logger.error(`[Post Gen] All models failed`, lastError?.message);
      return res.status(500).json({ error: '본문 생성 실패' });
  }

  const usedImageUrls = new Set(); // 포스팅 단위 중복 이미지 방지용 Set

  // 2. 썸네일 생성 (title 기반)
  const selectedTitle = postPlan.viralTitles ? 
      (postPlan.viralTitles.benefit || postPlan.viralTitles.curiosity || postPlan.viralTitles.fomo || postPlan.mainKeyword) : 
      postPlan.viralTitle;
  
  let thumbnailSearchKeyword = selectedTitle;
  let skipThumbnailTranslation = false;

  if (region === 'US') {
      skipThumbnailTranslation = true;
  } else if (postPlan.imageSearchKeywords && postPlan.imageSearchKeywords.length > 0) {
      // 한국어라도 기획안에 이미 영어 검색 키워드가 준비되어 있다면 그것을 사용하고 번역을 건너뜁니다.
      thumbnailSearchKeyword = postPlan.imageSearchKeywords[0];
      skipThumbnailTranslation = true;
  }

  logger.process(`[Image Fetch] Fetching thumbnail for keyword: ${thumbnailSearchKeyword} (Title: ${selectedTitle})`);
  const thumbnailUrl = await getRandomImage(thumbnailSearchKeyword, true, skipThumbnailTranslation, usedImageUrls);

  // 3. 본문 내 이미지 치환 (Alt 텍스트 + 영문 키워드 기반)
  // [Case A] 마크다운 문법을 지킨 경우: ![alt](URL "title")
  const bodyImageRegex = /!\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/g;
  const bodyMatches = [...bodyMarkdown.matchAll(bodyImageRegex)];
  
  for (const match of bodyMatches) {
      const fullMatch = match[0];
      const altText = match[1];
      const placeholderUrl = match[2];
      const englishKeyword = match[3];

      // 오타 방지: IMAGE_PLACEHOLDER가 아닌 IMAGE_PLACEER 등 다양한 오타 대응
      if (placeholderUrl.includes('IMAGE_PLACE')) {
          const searchKeyword = englishKeyword || altText;
          const skipTranslation = !!englishKeyword || region === 'US';
          const realImageUrl = await getRandomImage(searchKeyword, false, skipTranslation, usedImageUrls);
          
          if (realImageUrl) {
              const replacement = `![${altText}](${realImageUrl})`;
              bodyMarkdown = bodyMarkdown.replace(fullMatch, replacement);
          }
      }
  }

  // [Case B] AI가 문법을 빼먹고 플레이스홀더만 생으로 출력한 경우: IMAGE_PLACEHOLDER_N (또는 망가진 마크다운)
  // 오타 방지를 위해 정규식을 IMAGE_PLACE[A-Z_]*\d+ 형태로 유연하게 변경
  const rawPlaceholderRegex = /<img[^>]*IMAGE_PLACE[A-Z_]*\d+[^>]*>|!?\[[^\]]*\]\s*\(\s*[^)]*IMAGE_PLACE[A-Z_]*\d+[^)]*\)|!?\[\s*IMAGE_PLACE[A-Z_]*\d+\s*\]|IMAGE_PLACE[A-Z_]*\d+/g;
  const rawMatches = [...bodyMarkdown.matchAll(rawPlaceholderRegex)];

  for (const match of rawMatches) {
      const fullMatch = match[0]; // IMAGE_PLACEHOLDER_2, IMAGE_PLACEER_2 등
      logger.warn(`[Image Fetch] AI omitted markdown for ${fullMatch}. Applying fallback replacement.`);
      
      let fallbackSearchKeyword = postPlan.mainKeyword;
      let skipFallbackTranslation = region === 'US';

      if (region !== 'US' && postPlan.imageSearchKeywords && postPlan.imageSearchKeywords.length > 0) {
          fallbackSearchKeyword = postPlan.imageSearchKeywords[Math.floor(Math.random() * postPlan.imageSearchKeywords.length)];
          skipFallbackTranslation = true;
      }

      const realImageUrl = await getRandomImage(fallbackSearchKeyword, false, skipFallbackTranslation, usedImageUrls);
      if (realImageUrl) {
          // 이미지 태그로 감싸서 치환
          const replacement = `\n\n![${postPlan.mainKeyword}](${realImageUrl})\n\n`;
          bodyMarkdown = bodyMarkdown.replace(fullMatch, replacement);
      }
  }

  // 4. Hugo Front-matter 구성
  let selectedCategory = postPlan.category || "Tech and IT";
  selectedCategory = selectedCategory.replace(/&/g, 'and').replace(/\s+/g, ' ').trim();

  const currentDate = new Date().toISOString().split('T')[0];

  // [v2.4] 슬러그 결정: AI가 생성한 slug → imageSearchKeywords[0] → mainKeyword(영문화 fallback)
  const slugSource = postPlan.slug
      || (Array.isArray(postPlan.imageSearchKeywords) && postPlan.imageSearchKeywords[0])
      || postPlan.mainKeyword
      || 'post';
  const fallbackSource = postPlan.mainKeyword || selectedTitle;
  const finalSlug = makeUniqueSlug(slugSource, fallbackSource, `${postPlan.mainKeyword}|${selectedCategory}`);

  // [v2.4] 본문 후처리: ① 인터널 링크 자동 삽입 → ② 쿠팡 파트너스 박스
  const baseUrl = 'https://gunbin.github.io';
  bodyMarkdown = injectInternalLinks(bodyMarkdown, finalSlug, lang, baseUrl);
  const coupangBox = buildCoupangBox(postPlan.shoppableKeyword, selectedCategory, lang);
  if (bodyMarkdown.includes('{{coupangLink}}')) {
      if (coupangBox) {
          bodyMarkdown = bodyMarkdown.replace('{{coupangLink}}', '\n' + coupangBox + '\n');
      } else {
          // 쿠팡 박스가 생성되지 않으면 (shoppableKeyword 없음 또는 비대상 카테고리) 찌꺼기 텍스트 제거
          bodyMarkdown = bodyMarkdown.replace('{{coupangLink}}', '');
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
title: "${yamlEscape(selectedTitle)}"
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
    lsiKeywords: Array.isArray(postPlan.lsiKeywords) ? postPlan.lsiKeywords : [],
    coreEntities: Array.isArray(postPlan.coreEntities) ? postPlan.coreEntities : [],
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

const PORT = 3000;
app.listen(PORT, () => {
  logger.success(`TrendRadar v2.0 running at http://localhost:${PORT}`);
});
