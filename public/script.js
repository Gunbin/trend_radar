let timerInterval;
let timeRemaining = 30000;
let currentTrendsData = null;
let APP_CONFIG = {
    interval: 30000,
    sources: { 
        KR: { google: true, nate: true, signal: true },
        US: { google: true, reddit: true, yahoo: true }
    },
    topicCount: 3,
    region: 'KR'
};

// Load settings from localStorage
function loadSettings() {
    const saved = localStorage.getItem('trendRadar_cfg');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            // Migrate old sources format
            if (parsed.sources && typeof parsed.sources.google === 'boolean') {
                APP_CONFIG.sources.KR.google = parsed.sources.google;
                APP_CONFIG.sources.KR.nate = parsed.sources.nate;
                APP_CONFIG.sources.KR.signal = parsed.sources.signal;
            } else if (parsed.sources) {
                APP_CONFIG.sources = { ...APP_CONFIG.sources, ...parsed.sources };
            }
            APP_CONFIG.interval = parsed.interval || APP_CONFIG.interval;
            APP_CONFIG.topicCount = parsed.topicCount || APP_CONFIG.topicCount;
            APP_CONFIG.region = parsed.region || APP_CONFIG.region;
        } catch (e) {
            console.error('Failed to parse settings', e);
        }
    }
    syncUIToSettings();
}

function syncUIToSettings() {
    document.getElementById('cfg-interval').value = APP_CONFIG.interval / 1000;
    
    document.getElementById('src-google').checked = APP_CONFIG.sources.KR.google;
    document.getElementById('src-nate').checked = APP_CONFIG.sources.KR.nate;
    document.getElementById('src-signal').checked = APP_CONFIG.sources.KR.signal;
    
    document.getElementById('src-google-us').checked = APP_CONFIG.sources.US.google;
    document.getElementById('src-reddit').checked = APP_CONFIG.sources.US.reddit;
    document.getElementById('src-yahoo').checked = APP_CONFIG.sources.US.yahoo;

    document.getElementById('cfg-topics').value = APP_CONFIG.topicCount;
    document.getElementById('region-select').value = APP_CONFIG.region || 'KR';
    
    updateIntervalHint(APP_CONFIG.interval / 1000);
    document.getElementById('topics-val').textContent = `${APP_CONFIG.topicCount} TOPICS`;
    
    updatePanelVisibility();
}

function saveSettings() {
    APP_CONFIG.interval = parseInt(document.getElementById('cfg-interval').value) * 1000;
    
    APP_CONFIG.sources.KR.google = document.getElementById('src-google').checked;
    APP_CONFIG.sources.KR.nate = document.getElementById('src-nate').checked;
    APP_CONFIG.sources.KR.signal = document.getElementById('src-signal').checked;
    
    APP_CONFIG.sources.US.google = document.getElementById('src-google-us').checked;
    APP_CONFIG.sources.US.reddit = document.getElementById('src-reddit').checked;
    APP_CONFIG.sources.US.yahoo = document.getElementById('src-yahoo').checked;

    APP_CONFIG.topicCount = parseInt(document.getElementById('cfg-topics').value);
    
    localStorage.setItem('trendRadar_cfg', JSON.stringify(APP_CONFIG));
    updatePanelVisibility();
    resetTimer(); 
}

document.getElementById('region-select').addEventListener('change', (e) => {
    APP_CONFIG.region = e.target.value;
    localStorage.setItem('trendRadar_cfg', JSON.stringify(APP_CONFIG));
    updatePanelVisibility();
    syncUIToSettings(); // Sync checkboxes visibility in settings
    resetTimer(); // Immediately refetch on region change
});

function updatePanelVisibility() {
    const isKR = APP_CONFIG.region === 'KR';
    
    if (isKR) {
        document.querySelector('.google-panel').style.display = APP_CONFIG.sources.KR.google ? 'flex' : 'none';
        document.querySelector('.signal-panel').style.display = APP_CONFIG.sources.KR.nate ? 'flex' : 'none';
        document.querySelector('.namu-panel').style.display = APP_CONFIG.sources.KR.signal ? 'flex' : 'none';
        document.querySelector('.reddit-panel').style.display = 'none';
        document.querySelector('.yahoo-panel').style.display = 'none';
        
        document.getElementById('src-group-kr').classList.remove('hidden');
        document.getElementById('src-group-us').classList.add('hidden');
        document.querySelector('.google-panel .panel-title').innerHTML = '> GOOGLE_TRENDS_KR <span class="blink">_</span>';
    } else {
        document.querySelector('.google-panel').style.display = APP_CONFIG.sources.US.google ? 'flex' : 'none';
        document.querySelector('.signal-panel').style.display = 'none';
        document.querySelector('.namu-panel').style.display = 'none';
        document.querySelector('.reddit-panel').style.display = APP_CONFIG.sources.US.reddit ? 'flex' : 'none';
        document.querySelector('.yahoo-panel').style.display = APP_CONFIG.sources.US.yahoo ? 'flex' : 'none';
        
        document.getElementById('src-group-kr').classList.add('hidden');
        document.getElementById('src-group-us').classList.remove('hidden');
        document.querySelector('.google-panel .panel-title').innerHTML = '> GOOGLE_TRENDS_US <span class="blink">_</span>';
    }
}

async function fetchTrends() {
  try {
    const res = await fetch(`/api/trends?region=${APP_CONFIG.region || 'KR'}`);
    const rawData = await res.json();
    
    // Filter data based on active settings and region
    const data = {
        timestamp: rawData.timestamp,
        google: (APP_CONFIG.region === 'KR' && APP_CONFIG.sources.KR.google) || (APP_CONFIG.region === 'US' && APP_CONFIG.sources.US.google) ? rawData.google : [],
        signal: (APP_CONFIG.region === 'KR' && APP_CONFIG.sources.KR.nate) ? rawData.signal : [],
        namu: (APP_CONFIG.region === 'KR' && APP_CONFIG.sources.KR.signal) ? rawData.namu : [],
        reddit: (APP_CONFIG.region === 'US' && APP_CONFIG.sources.US.reddit) ? rawData.reddit : [],
        yahoo: (APP_CONFIG.region === 'US' && APP_CONFIG.sources.US.yahoo) ? rawData.yahoo : []
    };
    
    currentTrendsData = data; 
    
    const date = new Date(data.timestamp);
    document.getElementById('last-update').textContent = date.toLocaleTimeString();

    if ((APP_CONFIG.region === 'KR' && APP_CONFIG.sources.KR.google) || (APP_CONFIG.region === 'US' && APP_CONFIG.sources.US.google)) {
        renderList('google-list', data.google, (item) => `
          <div class="trend-item" style="animation-delay: ${item.rank * 50}ms">
            <div class="rank">${item.rank.toString().padStart(2, '0')}</div>
            ${item.image ? `<div class="thumbnail"><img src="${item.image}" alt="thumb"></div>` : ''}
            <div class="content">
              <div class="keyword">${item.keyword}</div>
              <div class="meta">
                <span style="color:var(--google-color)">VOL: ${item.traffic}</span>
                <div class="news-group">
                  ${item.newsItems.map(news => `
                    <a href="${news.url}" target="_blank" class="news-item">
                      <span class="news-source">[${news.source}]</span>${news.title}
                    </a>
                  `).join('')}
                </div>
              </div>
            </div>
          </div>
        `);
    }

    if (APP_CONFIG.region === 'KR' && APP_CONFIG.sources.KR.nate) {
        renderList('signal-list', data.signal, (item) => {
          let statusClass = 'status-same';
          let icon = '-';
          if (item.status === 'UP') { statusClass = 'status-up'; icon = '▲'; }
          if (item.status === 'DOWN') { statusClass = 'status-down'; icon = '▼'; }
          
          return `
            <div class="trend-item" style="animation-delay: ${item.rank * 50}ms">
              <div class="rank">${item.rank.toString().padStart(2, '0')}</div>
              <div class="content">
                <div class="keyword">${item.keyword}</div>
                <div class="meta">
                  <span class="status-tag ${statusClass}">
                    ${icon} ${item.status} ${item.change || ''}
                  </span>
                </div>
              </div>
            </div>
          `;
        });
    }

    if (APP_CONFIG.region === 'KR' && APP_CONFIG.sources.KR.signal) {
        renderList('namu-list', data.namu, (item) => {
          const isError = item.status === 'ERROR';
          const colorStyle = isError ? 'color: #ff3333;' : '';
          return `
            <div class="trend-item" style="animation-delay: ${item.rank * 50}ms">
              <div class="rank" style="${colorStyle}">${item.rank.toString().padStart(2, '0')}</div>
              <div class="content">
                <div class="keyword" style="${colorStyle}">${item.keyword}</div>
                <div class="meta">
                  <span style="opacity:0.6">> STATUS: ${item.status}</span><br>
                  ${item.summaryUrl ? `<a href="${item.summaryUrl}" target="_blank" class="summary-link">AI_SUMMARY</a>` : ''}
                </div>
              </div>
            </div>
          `;
        });
    }

    if (APP_CONFIG.region === 'US' && APP_CONFIG.sources.US.reddit) {
        renderList('reddit-list', data.reddit, (item) => `
            <div class="trend-item" style="animation-delay: ${item.rank * 50}ms">
              <div class="rank">${item.rank.toString().padStart(2, '0')}</div>
              <div class="content">
                <div class="keyword">${item.keyword}</div>
                <div class="meta">
                  <span style="color:var(--reddit-color)">SCORE: ${item.score}</span><br>
                  <a href="${item.url}" target="_blank" class="news-item">[${item.subreddit}] View Post</a>
                </div>
              </div>
            </div>
        `);
    }

    if (APP_CONFIG.region === 'US' && APP_CONFIG.sources.US.yahoo) {
        renderList('yahoo-list', data.yahoo, (item) => `
            <div class="trend-item" style="animation-delay: ${item.rank * 50}ms">
              <div class="rank">${item.rank.toString().padStart(2, '0')}</div>
              <div class="content">
                <div class="keyword">${item.keyword}</div>
                <div class="meta">
                  <span style="color:var(--yahoo-color)">> PUB: ${new Date(item.pubDate).toLocaleDateString()}</span><br>
                  <a href="${item.url}" target="_blank" class="news-item">Read News</a>
                </div>
              </div>
            </div>
        `);
    }

    const allKeywords = [
      ...(data.google || []).map(i => i.keyword),
      ...(data.signal || []).map(i => i.keyword),
      ...(data.namu || []).map(i => i.keyword),
      ...(data.reddit || []).map(i => i.keyword),
      ...(data.yahoo || []).map(i => i.keyword)
    ];
    document.getElementById('trend-ticker').textContent = ' >>> ' + allKeywords.join(' | ') + ' <<< ';

    // Restart timer when successfully fetched
    clearInterval(timerInterval);
    timeRemaining = APP_CONFIG.interval;
    document.getElementById('progress').style.width = '0%';
    startTimer();

  } catch (error) {
    console.error('Failed to fetch trends:', error);
    document.getElementById('last-update').textContent = 'CONNECTION FAILED';
    document.getElementById('last-update').style.color = 'red';
  }
}

function renderList(elementId, items, templateFn) {
  const container = document.getElementById(elementId);
  if (!items || items.length === 0) {
    container.innerHTML = '<li class="loading">NO DATA RECEIVED</li>';
    return;
  }
  container.innerHTML = items.map(templateFn).join('');
}

function startTimer() {
  const progressEl = document.getElementById('progress');
  const interval = APP_CONFIG.interval;
  timeRemaining = interval;
  
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    timeRemaining -= 1000;
    const pct = ((interval - timeRemaining) / interval) * 100;
    progressEl.style.width = `${pct}%`;

    if (timeRemaining <= 0) {
      clearInterval(timerInterval);
      fetchTrends();
    }
  }, 1000);
}

function resetTimer() {
  clearInterval(timerInterval);
  timeRemaining = APP_CONFIG.interval;
  document.getElementById('progress').style.width = '0%';
  fetchTrends(); // Fetch immediately on manual reset
}

// AI Analysis Functionality
document.getElementById('analyze-btn').addEventListener('click', async () => {
    if (!currentTrendsData) return;
    
    const aiSection = document.getElementById('ai-section');
    const aiContent = document.getElementById('ai-content');
    
    aiSection.classList.remove('hidden');
    aiContent.innerHTML = '<div class="ai-loading">CONNECTING TO GEMINI NEURAL NET... [PROCESSING]</div>';
    
    try {
        const res = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                trends: currentTrendsData,
                config: { topicCount: APP_CONFIG.topicCount },
                region: APP_CONFIG.region || 'KR'
            })
        });
        
        const result = await res.json();
        renderAIAnalysis(result);
    } catch (error) {
        aiContent.innerHTML = '<div class="error">AI ANALYSIS FAILED. CHECK API KEY AND SERVER LOGS.</div>';
    }
});

// Manual Input Logic
document.getElementById('manual-btn').addEventListener('click', () => {
    document.getElementById('manual-modal').classList.remove('hidden');
    document.getElementById('manual-text').value = '';
});

document.getElementById('close-manual').addEventListener('click', () => {
    document.getElementById('manual-modal').classList.add('hidden');
});

document.getElementById('manual-analyze-btn').addEventListener('click', async () => {
    const manualText = document.getElementById('manual-text').value.trim();
    if (!manualText) {
        alert("PLEASE ENTER TEXT FOR ANALYSIS.");
        return;
    }
    
    document.getElementById('manual-modal').classList.add('hidden');
    
    const aiSection = document.getElementById('ai-section');
    const aiContent = document.getElementById('ai-content');
    
    aiSection.classList.remove('hidden');
    aiContent.innerHTML = '<div class="ai-loading">CONNECTING TO GEMINI NEURAL NET... [PROCESSING MANUAL INPUT]</div>';
    
    try {
        const res = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                manualText: manualText,
                config: { topicCount: APP_CONFIG.topicCount },
                region: APP_CONFIG.region || 'KR'
            })
        });
        
        const result = await res.json();
        renderAIAnalysis(result);
    } catch (error) {
        aiContent.innerHTML = '<div class="error">AI ANALYSIS FAILED. CHECK API KEY AND SERVER LOGS.</div>';
    }
});

document.getElementById('close-ai').addEventListener('click', () => {
    document.getElementById('ai-section').classList.add('hidden');
});

function renderAIAnalysis(data) {
    const aiContent = document.getElementById('ai-content');
    
    let html = `
        <div class="analysis-grid">
            <div class="post-section">
                <h3>VIRAL_HIJACKING_STRATEGIES (TOP_${data.blogPosts.length})</h3>
                <div class="post-list">
                    ${data.blogPosts.map((post, i) => {
                        const title = post.viralTitles ? (post.viralTitles.benefit || post.viralTitles.curiosity || post.mainKeyword) : post.viralTitle;
                        return `
                        <div class="post-card marketing-card">
                            <div class="post-index">0${i+1}</div>
                            <div class="post-main">
                                <div class="post-title" style="color:var(--text-color)">${title}</div>
                                <div class="post-reason"><span class="highlight-tag">CATEGORY:</span> ${post.category}</div>
                                <div class="post-reason"><span class="highlight-tag">SEARCH_INTENT:</span> ${post.searchIntent}</div>
                                <div class="post-meta">
                                    <div class="meta-item"><span>MAIN_TREND:</span> <strong style="color:var(--namu-color)">${post.mainKeyword}</strong></div>
                                    <div class="meta-item"><span>ANGLE:</span> ${post.angleType || 'guide'}</div>
                                    <div class="meta-item"><span>CORE_FACT:</span> ${post.coreFact}</div>
                                    <div class="meta-item"><span>SEO_KEYWORDS:</span> ${(post.seoKeywords || []).join(', ')}</div>
                                    ${post.lsiKeywords ? `<div class="meta-item"><span>LSI_KEYWORDS:</span> ${(Array.isArray(post.lsiKeywords) ? post.lsiKeywords : []).join(', ')}</div>` : ''}
                                    <div class="meta-item"><span>CORE_MESSAGE:</span> ${post.coreMessage}</div>
                                </div>
                                <button class="write-btn" onclick='generateFullPost(${JSON.stringify(post).replace(/'/g, "&apos;")})'>
                                    WRITE_SEO_OPTIMIZED_POST
                                </button>
                            </div>
                        </div>
                        `
                    }).join('')}
                </div>
            </div>
        </div>
    `;
    
    aiContent.innerHTML = html;
}

async function generateFullPost(postPlan) {
    const modal = document.getElementById('post-modal');
    const content = document.getElementById('post-content');
    
    modal.classList.remove('hidden');
    content.textContent = "GENERATING COMPLETE BLOG POST USING GEMINI...\nPLEASE WAIT FOR NEURAL PROCESSING...";
    
    try {
        const res = await fetch('/api/generate-post', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                postPlan,
                region: APP_CONFIG.region || 'KR'
            })
        });
        
        const result = await res.json();
        currentGeneratedMarkdown = result.markdown;
        // Use marked to parse markdown into HTML
        content.innerHTML = marked.parse(result.markdown);
    } catch (error) {
        content.innerHTML = '<div class="error">FATAL ERROR: FAILED TO GENERATE CONTENT. CHECK SYSTEM LOGS.</div>';
    }
}

// Settings Modal Logic
document.getElementById('settings-btn').addEventListener('click', async () => {
    syncUIToSettings(); // Make sure values are fresh
    document.getElementById('settings-modal').classList.remove('hidden');
    // Fetch prompt for inspector based on current region language
    try {
        const lang = APP_CONFIG.region === 'US' ? 'en' : 'ko';
        const res = await fetch(`/api/config/prompts?lang=${lang}`);
        const data = await res.json();
        document.getElementById('prompt-viewer').textContent = data.yaml;
    } catch (e) {
        document.getElementById('prompt-viewer').textContent = 'ERROR LOADING PROMPTS.';
    }
});

document.getElementById('close-settings').addEventListener('click', () => {
    saveSettings();
    document.getElementById('settings-modal').classList.add('hidden');
});

document.getElementById('cancel-settings').addEventListener('click', () => {
    syncUIToSettings(); // Revert to saved settings
    document.getElementById('settings-modal').classList.add('hidden');
});

document.getElementById('close-post').addEventListener('click', () => {
    document.getElementById('post-modal').classList.add('hidden');
});

document.getElementById('copy-post').addEventListener('click', () => {
    if (!currentGeneratedMarkdown) return;
    navigator.clipboard.writeText(currentGeneratedMarkdown).then(() => {
        alert('CONTENT COPIED TO CLIPBOARD!');
    });
});

document.getElementById('publish-post').addEventListener('click', async () => {
    if (!currentGeneratedMarkdown) return;
    const btn = document.getElementById('publish-post');
    const originalText = btn.textContent;
    btn.textContent = 'SAVING...';
    btn.disabled = true;
    
    try {
        const res = await fetch('/api/publish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                markdown: currentGeneratedMarkdown,
                region: APP_CONFIG.region || 'KR'
            })
        });
        const result = await res.json();
        if (res.ok) {
            alert('SUCCESSFULLY SAVED LOCALLY!\nFile: ' + result.filePath);
            document.getElementById('post-modal').classList.add('hidden');
        } else {
            alert('SAVE FAILED: ' + result.error);
        }
    } catch (error) {
        alert('SAVE ERROR.');
    }
    
    btn.textContent = originalText;
    btn.disabled = false;
});

document.getElementById('push-github-post').addEventListener('click', async () => {
    if (!currentGeneratedMarkdown) return;
    const btn = document.getElementById('push-github-post');
    const originalText = btn.textContent;
    btn.textContent = 'PUSHING...';
    btn.disabled = true;
    
    try {
        const res = await fetch('/api/push-github', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                markdown: currentGeneratedMarkdown,
                region: APP_CONFIG.region || 'KR'
            })
        });
        const result = await res.json();
        if (res.ok) {
            alert('SUCCESSFULLY PUSHED TO GITHUB!\nFile: ' + result.filePath);
            document.getElementById('post-modal').classList.add('hidden');
        } else {
            alert('GITHUB PUSH FAILED: ' + result.error + (result.details ? '\n' + result.details : ''));
        }
    } catch (error) {
        alert('GITHUB PUSH ERROR.');
    }
    
    btn.textContent = originalText;
    btn.disabled = false;
});

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
        e.target.classList.add('active');
        document.getElementById(`tab-${e.target.dataset.tab}`).classList.remove('hidden');
    });
});

document.getElementById('cfg-interval').addEventListener('input', (e) => {
    updateIntervalHint(e.target.value);
});

document.getElementById('cfg-topics').addEventListener('input', (e) => {
    document.getElementById('topics-val').textContent = `${e.target.value} TOPICS`;
});

function updateIntervalHint(sec) {
    const min = (sec / 60).toFixed(1);
    document.getElementById('interval-hint').textContent = `≈ ${min} MIN`;
}

// Initialization
loadSettings();
// Initial fetch is handled by updatePanelVisibility -> resetTimer -> fetchTrends internally or explicitly.
if(!timerInterval) {
    resetTimer();
}