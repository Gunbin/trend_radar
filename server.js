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

const app = express();
app.use(cors());
app.use(express.json()); 
app.use(express.static('public'));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Pexels API Integration
async function getPexelsImage(keyword) {
  try {
    const res = await axios.get(`https://api.pexels.com/v1/search?query=${keyword}&per_page=1`, {
      headers: { 'Authorization': process.env.PEXELS_API_KEY }
    });
    if (res.data.photos && res.data.photos.length > 0) {
      return res.data.photos[0].src.landscape;
    }
    return 'https://images.pexels.com/photos/1103970/pexels-photo-1103970.jpeg?auto=compress&cs=tinysrgb&w=1200'; 
  } catch (error) {
    console.error('Pexels API Error:', error.message);
    return 'https://images.pexels.com/photos/1103970/pexels-photo-1103970.jpeg?auto=compress&cs=tinysrgb&w=1200';
  }
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
    console.error('Reddit API Error:', error.message);
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
      console.error('Yahoo News API Error:', error.message);
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
      console.log(`Attempting Viral Analysis: ${modelName} (Count: ${topicCount}, Region: ${region})`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const prompt = promptManager.getPrompt('trend_analysis', lang, {
        trends_data: JSON.stringify(trends),
        topic_count: topicCount
      });

      const result = await model.generateContent(prompt);
      const response = await result.response;
      let text = response.text().trim();
      // 보다 강력한 JSON 파싱 대응 (마크다운 백틱 및 앞뒤 불필요한 문자열 제거)
      text = text.replace(/^```(json)?|```$/gi, "").trim();
      
      // JSON 객체 앞뒤에 텍스트가 붙어있을 경우를 대비해 중괄호/대괄호 추출
      const firstBrace = text.indexOf('{');
      const lastBrace = text.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        text = text.slice(firstBrace, lastBrace + 1);
      }
      
      return res.json(JSON.parse(text));
    } catch (error) {
      lastError = error;
      console.error(`Error with ${modelName}:`, error.message);
      if (i < modelsToTry.length - 1) {
        console.log(`[Rate Limit Guard] Waiting 2.5s before next model...`);
        await new Promise(resolve => setTimeout(resolve, 2500));
      }
      continue;
    }
  }
  res.status(500).json({ error: 'AI 분석 실패', details: lastError?.message });
});

app.post('/api/generate-post', async (req, res) => {
  const { postPlan, region = 'KR' } = req.body;
  const lang = region === 'US' ? 'en' : 'ko';
  
  // Fetch thumbnail and 3 different context images
  const [thumbnailUrl, contextUrl1, contextUrl2, contextUrl3] = await Promise.all([
    getPexelsImage(postPlan.seoKeywords[0] || postPlan.mainKeyword),
    getPexelsImage(postPlan.seoKeywords[1] || postPlan.mainKeyword),
    getPexelsImage(postPlan.lsiKeywords?.[0] || postPlan.mainKeyword),
    getPexelsImage(postPlan.lsiKeywords?.[1] || 'insight')
  ]);

  // Construct Hugo Front-matter in Backend for 100% reliability
  const selectedTitle = postPlan.viralTitles ? 
      (postPlan.viralTitles.benefit || postPlan.viralTitles.curiosity || postPlan.viralTitles.fomo || postPlan.mainKeyword) : 
      postPlan.viralTitle;
  
  // Normalize category: Always use 'and' instead of '&' to match Hugo setup
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
  
  for (let i = 0; i < modelsToTry.length; i++) {
    const modelName = modelsToTry[i];
    try {
      console.log(`Generating Viral Post Body: ${modelName} (Region: ${region})`);
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
      
      // If AI accidentally outputted its own header, remove it
      if (bodyMarkdown.startsWith('---')) {
          const parts = bodyMarkdown.split('---');
          if (parts.length >= 3) {
              bodyMarkdown = parts.slice(2).join('---').trim();
          }
      }

      return res.json({ markdown: hugoHeader + bodyMarkdown });
    } catch (error) {
      console.error(`Error with ${modelName}:`, error.message);
      if (i < modelsToTry.length - 1) {
        console.log(`[Rate Limit Guard] Waiting 2.5s before next model...`);
        await new Promise(resolve => setTimeout(resolve, 2500));
      }
      continue;
    }
  }
  res.status(500).json({ error: '본문 생성 실패' });
});

app.post('/api/publish', (req, res) => {
  const { markdown, region = 'KR' } = req.body;
  if (!markdown) return res.status(400).json({ error: 'Markdown content missing' });
  
  const lang = region === 'US' ? 'en' : 'ko';
  
  // Create a slug from timestamp to avoid special characters issues
  const timestamp = Date.now();
  const filename = `trend-${timestamp}.md`;
  
  // Path to autoHugoBlog/content/{lang}/blog/
  const targetDir = path.join(process.cwd(), '..', 'autoHugoBlog', 'content', lang, 'blog');
  const filePath = path.join(targetDir, filename);
  
  try {
      if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
      }
      fs.writeFileSync(filePath, markdown, 'utf8');
      res.json({ success: true, filePath: `/content/${lang}/blog/${filename}` });
  } catch (error) {
      console.error("Publish Error:", error);
      res.status(500).json({ error: 'Failed to write markdown file to Hugo' });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`TrendRadar v2.0 running at http://localhost:${PORT}`);
});