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
      return res.data.photos[0].src.large2x;
    }
    return 'https://images.pexels.com/photos/1103970/pexels-photo-1103970.jpeg?auto=compress&cs=tinysrgb&w=1200'; 
  } catch (error) {
    console.error('Pexels API Error:', error.message);
    return 'https://images.pexels.com/photos/1103970/pexels-photo-1103970.jpeg?auto=compress&cs=tinysrgb&w=1200';
  }
}

// 1. Google Trends
async function getGoogleTrends() {
  try {
    const res = await axios.get('https://trends.google.com/trending/rss?geo=KR', {
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

// 2. Nate
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

// 3. Signal.bz
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

app.get('/api/config/prompts', (req, res) => {
  try {
    const fileContent = fs.readFileSync('./prompts.yml', 'utf8');
    res.json({ yaml: fileContent });
  } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/trends', async (req, res) => {
  const [google, signal, namu] = await Promise.all([
    getGoogleTrends(), getSignalTrends(), getNamuwikiTrends()
  ]);
  res.json({ timestamp: new Date().toISOString(), google, signal, namu });
});

app.post('/api/analyze', async (req, res) => {
  const { trends, config } = req.body; 
  const topicCount = config?.topicCount || 3;

  const modelsToTry = ["gemini-pro-latest", "gemini-flash-latest", "gemini-3-flash-preview", "gemini-2.0-flash"];
  let lastError = null;

  for (const modelName of modelsToTry) {
    try {
      console.log(`Attempting Viral Analysis: ${modelName} (Count: ${topicCount})`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const prompt = promptManager.getPrompt('trend_analysis', {
        trends_data: JSON.stringify(trends),
        topic_count: topicCount
      });

      const result = await model.generateContent(prompt);
      const response = await result.response;
      let text = response.text().trim().replace(/```json|```/g, "").trim();
      return res.json(JSON.parse(text));
    } catch (error) {
      lastError = error;
      console.error(`Error with ${modelName}:`, error.message);
      continue;
    }
  }
  res.status(500).json({ error: 'AI 분석 실패', details: lastError?.message });
});

app.post('/api/generate-post', async (req, res) => {
  const { postPlan } = req.body;
  
  const [thumbnailUrl, contextUrl] = await Promise.all([
    getPexelsImage(postPlan.seoKeywords[0] || postPlan.mainKeyword),
    getPexelsImage(postPlan.seoKeywords[1] || 'insight')
  ]);

  const modelsToTry = ["gemini-pro-latest", "gemini-flash-latest", "gemini-3-flash-preview", "gemini-2.0-flash"];
  
  for (const modelName of modelsToTry) {
    try {
      console.log(`Generating Viral Post: ${modelName}`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const prompt = promptManager.getPrompt('post_writing', {
        viralTitle: postPlan.viralTitle,
        mainKeyword: postPlan.mainKeyword,
        searchIntent: postPlan.searchIntent,
        seoKeywords: postPlan.seoKeywords.join(', '),
        coreMessage: postPlan.coreMessage,
        current_date: new Date().toLocaleDateString(),
        thumbnail_url: thumbnailUrl,
        context_url: contextUrl
      });

      const result = await model.generateContent(prompt);
      const response = await result.response;
      return res.json({ markdown: response.text().trim().replace(/^```markdown|```$/g, "").trim() });
    } catch (error) { continue; }
  }
  res.status(500).json({ error: '본문 생성 실패' });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`TrendRadar v2.0 running at http://localhost:${PORT}`);
});
