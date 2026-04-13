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
import logger from './logger.js';

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

// --- Translation Helper (For better image search) ---
async function translateToEnglish(keyword) {
  if (!keyword || keyword.trim() === '') return 'abstract';
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `Translate the following Korean blog keyword into a simple, clear English search term for an image database (like Pexels/Pixabay). Output ONLY the English words, no punctuation or extra text. Keyword: "${keyword}"`;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    let translated = response.text().trim().replace(/["'.]/g, '');
    return translated || keyword; 
  } catch (error) {
    logger.error('Translation Error', error.message);
    return keyword; 
  }
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
async function getPixabayImage(keyword, type = 'all') {
  if (!process.env.PIXABAY_API_KEY) return null;
  try {
    const res = await axios.get(`https://pixabay.com/api/`, {
      params: {
        key: process.env.PIXABAY_API_KEY,
        q: keyword,
        image_type: type,
        per_page: 5,
        safesearch: 'true'
      }
    });
    if (res.data.hits && res.data.hits.length > 0) {
      const randomIndex = Math.floor(Math.random() * res.data.hits.length);
      // Use webformatURL (max 640px) for better loading speed
      return res.data.hits[randomIndex].webformatURL;
    }
    
    // Fallback: If no results, try searching with only the first two words
    const simplified = keyword.split(' ').slice(0, 2).join(' ');
    if (simplified !== keyword) {
      return await getPixabayImage(simplified, type);
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
        page_size: 5 
      },
      headers: { 'User-Agent': 'TrendRadar/1.0' }
    });
    if (res.data.results && res.data.results.length > 0) {
      const randomIndex = Math.floor(Math.random() * res.data.results.length);
      // Use "thumbnail" instead of "url" because it is proxied and hotlink-friendly
      return res.data.results[randomIndex].thumbnail;
    }
  } catch (error) {
    logger.error('Openverse API Error', error.message);
  }
  return null;
}

// --- Master Image Dispatcher ---
async function getRandomImage(keyword, isThumbnail = false) {
  let searchQuery = keyword;
  if (Array.isArray(keyword)) {
    searchQuery = keyword[Math.floor(Math.random() * keyword.length)];
  }

  logger.process(`[Image Search] Query: ${searchQuery} (${isThumbnail ? 'Thumbnail' : 'Body'})`);

  let imageUrl = null;
  
  // 1순위: 카툰풍/일러스트 이미지 (Pixabay, Openverse)
  const primarySources = [
    () => getPixabayImage(searchQuery, 'illustration'),
    () => getPixabayImage(searchQuery, 'vector'),
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
    () => getPixabayImage('abstract pattern', 'vector'),
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

// 1. Google Trends (다국어 지원)
async function getGoogleTrends(geo = 'KR') {
  try {
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
  } catch (error) { return []; }
}

// 2. Nate (한국 전용)
async function getSignalTrends() {
  try {
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
  } catch (error) { return []; }
}

// 3. Signal.bz (한국 전용)
async function getNamuwikiTrends() {
  try {
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
  } catch (error) { return []; }
}

// 4. Reddit Trends (영미권 전용 - 인기 게시물 기반)
async function getRedditTrends() {
  try {
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
  } catch (error) {
    logger.error('Reddit API Error', error.message);
    return [];
  }
}

// 5. Yahoo News (영미권 전용 - RSS)
async function getYahooNewsRSS() {
  try {
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
  } catch (error) {
      logger.error('Yahoo News API Error', error.message);
      return []; 
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
  const region = req.query.region || 'KR'; // 'KR' 또는 'US'
  
  if (region === 'US') {
    const [google, reddit, yahoo] = await Promise.all([
      getGoogleTrends('US'), getRedditTrends(), getYahooNewsRSS()
    ]);
    res.json({ timestamp: new Date().toISOString(), region, google, reddit, yahoo });
  } else {
    const [google, signal, namu] = await Promise.all([
      getGoogleTrends('KR'), getSignalTrends(), getNamuwikiTrends()
    ]);
    res.json({ timestamp: new Date().toISOString(), region, google, signal, namu });
  }
});

app.post('/api/analyze', async (req, res) => {
  const { trends, config, region = 'KR' } = req.body; 
  const topicCount = config?.topicCount || 3;
  const lang = region === 'US' ? 'en' : 'ko';

  const modelsToTry = [
    "gemini-3.1-pro",                     // UI: Gemini 3.1 Pro (최상위 지능)
    "gemini-2.5-pro",                     // UI: Gemini 2.5 Pro
    "gemini-3-flash",                     // UI: Gemini 3 Flash
    "gemini-2.5-flash",                   // UI: Gemini 2.5 Flash
    "gemini-2.0-flash",                   // UI: Gemini 2 Flash
    "gemini-3.1-flash-lite",              // UI: Gemini 3.1 Flash Lite (500회 한도)
    "gemini-2.5-flash-lite"               // UI: Gemini 2.5 Flash Lite
  ];
  let lastError = null;

  for (let i = 0; i < modelsToTry.length; i++) {
    const modelName = modelsToTry[i];
    try {
      logger.process(`[Analysis] Attempting with ${modelName} (Count: ${topicCount}, Region: ${region})`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const prompt = promptManager.getPrompt('trend_analysis', lang, {
        trends_data: JSON.stringify(trends),
        topic_count: topicCount
      });

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
      logger.warn(`[Analysis] Failed with ${modelName}: ${error.message}. Retrying...`);
      if (i < modelsToTry.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2500));
      }
      continue;
    }
  }
  logger.error(`[Analysis] All models failed`, lastError?.message);
  res.status(500).json({ error: 'AI 분석 실패', details: lastError?.message });
});

app.post('/api/generate-post', async (req, res) => {
  const { postPlan, region = 'KR' } = req.body;
  const lang = region === 'US' ? 'en' : 'ko';
  
  // Fetch thumbnail and 3 different context images using the Master Dispatcher
  logger.process(`[Post Gen] Fetching images for: ${postPlan.mainKeyword}`);
  const [thumbnailUrl, contextUrl1, contextUrl2, contextUrl3] = await Promise.all([
    getRandomImage(postPlan.mainKeyword, true), // Thumbnail (Illustration/Cartoon)
    getRandomImage(postPlan.seoKeywords?.[0] || postPlan.mainKeyword, false), // Body 1
    getRandomImage(postPlan.seoKeywords?.[1] || postPlan.lsiKeywords?.[0] || postPlan.mainKeyword, false), // Body 2
    getRandomImage(postPlan.lsiKeywords?.[1] || 'insight', false) // Body 3
  ]);

  // Construct Hugo Front-matter in Backend
  const selectedTitle = postPlan.viralTitles ? 
      (postPlan.viralTitles.benefit || postPlan.viralTitles.curiosity || postPlan.viralTitles.fomo || postPlan.mainKeyword) : 
      postPlan.viralTitle;
  
  let selectedCategory = postPlan.category || "Tech and IT";
  selectedCategory = selectedCategory.replace(/&/g, 'and').replace(/\s+/g, ' ').trim();
  
  const currentDate = new Date().toISOString().split('T')[0];
  const tags = Array.isArray(postPlan.seoKeywords) ? postPlan.seoKeywords : [];

  const hugoHeader = `---
author: "TrendRadar"
title: "${selectedTitle.replace(/"/g, '\\"')}"
date: ${currentDate}
tags: [${tags.map(t => `"${t}"`).join(', ')}]
description: "${(postPlan.metaDescription || '').replace(/"/g, '\\"')}"
categories: ["${selectedCategory}"]
thumbnail: "${thumbnailUrl}"
---

`;

  const modelsToTry = [
    "gemini-3.1-pro",                     // UI: Gemini 3.1 Pro (최상위 지능)
    "gemini-2.5-pro",                     // UI: Gemini 2.5 Pro
    "gemini-3-flash",                     // UI: Gemini 3 Flash
    "gemini-2.5-flash",                   // UI: Gemini 2.5 Flash
    "gemini-2.0-flash",                   // UI: Gemini 2 Flash
    "gemini-3.1-flash-lite",              // UI: Gemini 3.1 Flash Lite (500회 한도)
    "gemini-2.5-flash-lite"               // UI: Gemini 2.5 Flash Lite
  ];
  
  let lastError = null;

  for (let i = 0; i < modelsToTry.length; i++) {
    const modelName = modelsToTry[i];
    try {
      logger.process(`[Post Gen] Generating content with ${modelName} (Region: ${region})`);
      const model = genAI.getGenerativeModel({ model: modelName });
      
      const prompt = promptManager.getPrompt('post_writing', lang, {
        mainKeyword: postPlan.mainKeyword,
        searchIntent: postPlan.searchIntent,
        seoKeywords: tags.join(', '),
        lsiKeywords: postPlan.lsiKeywords ? (Array.isArray(postPlan.lsiKeywords) ? postPlan.lsiKeywords.join(', ') : postPlan.lsiKeywords) : '',
        coreMessage: postPlan.coreMessage,
        context_url_1: contextUrl1,
        context_url_2: contextUrl2,
        context_url_3: contextUrl3
      });

      const result = await model.generateContent(prompt);
      const response = await result.response;
      let bodyMarkdown = response.text().trim().replace(/^```markdown|```$/g, "").trim();
      
      if (bodyMarkdown.startsWith('---')) {
          const parts = bodyMarkdown.split('---');
          if (parts.length >= 3) {
              bodyMarkdown = parts.slice(2).join('---').trim();
          }
      }

      logger.success(`[Post Gen] Successful with ${modelName}`);
      return res.json({ markdown: hugoHeader + bodyMarkdown });
    } catch (error) {
      lastError = error;
      logger.warn(`[Post Gen] Failed with ${modelName}: ${error.message}. Retrying...`);
      if (i < modelsToTry.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2500));
      }
      continue;
    }
  }
  logger.error(`[Post Gen] All models failed`, lastError?.message);
  res.status(500).json({ error: '본문 생성 실패' });
});

app.post('/api/publish', (req, res) => {
  const { markdown, region = 'KR' } = req.body;
  if (!markdown) return res.status(400).json({ error: 'Markdown content missing' });
  
  const lang = region === 'US' ? 'en' : 'ko';
  const timestamp = Date.now();
  const filename = `trend-${timestamp}.md`;
  
  const targetDir = path.join(process.cwd(), '..', 'autoHugoBlog', 'content', lang, 'blog');
  const filePath = path.join(targetDir, filename);
  
  try {
      if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
      }
      fs.writeFileSync(filePath, markdown, 'utf8');
      logger.success(`[Publish] Saved markdown file to ${filePath}`);
      res.json({ success: true, filePath: `/content/${lang}/blog/${filename}` });
  } catch (error) {
      logger.error("[Publish Error]", error.message);
      res.status(500).json({ error: 'Failed to write markdown file to Hugo' });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  logger.success(`TrendRadar v2.0 running at http://localhost:${PORT}`);
});
