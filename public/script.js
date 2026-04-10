let timerInterval;
let timeRemaining = 30000;
let currentTrendsData = null;
let APP_CONFIG = {
    interval: 30000,
    sources: { google: true, nate: true, signal: true },
    topicCount: 3
};

// Load settings from localStorage
function loadSettings() {
    const saved = localStorage.getItem('trendRadar_cfg');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            APP_CONFIG = { ...APP_CONFIG, ...parsed };
        } catch (e) {
            console.error('Failed to parse settings', e);
        }
    }
    // Sync UI with config
    document.getElementById('cfg-interval').value = APP_CONFIG.interval / 1000;
    document.getElementById('src-google').checked = APP_CONFIG.sources.google;
    document.getElementById('src-nate').checked = APP_CONFIG.sources.nate;
    document.getElementById('src-signal').checked = APP_CONFIG.sources.signal;
    document.getElementById('cfg-topics').value = APP_CONFIG.topicCount;
    updateIntervalHint(APP_CONFIG.interval / 1000);
    document.getElementById('topics-val').textContent = `${APP_CONFIG.topicCount} TOPICS`;
    
    // Apply source visibility
    updatePanelVisibility();
}

function saveSettings() {
    APP_CONFIG.interval = parseInt(document.getElementById('cfg-interval').value) * 1000;
    APP_CONFIG.sources.google = document.getElementById('src-google').checked;
    APP_CONFIG.sources.nate = document.getElementById('src-nate').checked;
    APP_CONFIG.sources.signal = document.getElementById('src-signal').checked;
    APP_CONFIG.topicCount = parseInt(document.getElementById('cfg-topics').value);
    
    localStorage.setItem('trendRadar_cfg', JSON.stringify(APP_CONFIG));
    updatePanelVisibility();
    resetTimer(); 
}

function updatePanelVisibility() {
    document.querySelector('.google-panel').style.display = APP_CONFIG.sources.google ? 'flex' : 'none';
    document.querySelector('.signal-panel').style.display = APP_CONFIG.sources.nate ? 'flex' : 'none';
    document.querySelector('.namu-panel').style.display = APP_CONFIG.sources.signal ? 'flex' : 'none';
}

async function fetchTrends() {
  try {
    const res = await fetch('/api/trends');
    const rawData = await res.json();
    
    // Filter data based on active settings
    const data = {
        timestamp: rawData.timestamp,
        google: APP_CONFIG.sources.google ? rawData.google : [],
        signal: APP_CONFIG.sources.nate ? rawData.signal : [],
        namu: APP_CONFIG.sources.signal ? rawData.namu : []
    };
    
    currentTrendsData = data; 
    
    const date = new Date(data.timestamp);
    document.getElementById('last-update').textContent = date.toLocaleTimeString();

    if (APP_CONFIG.sources.google) {
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

    if (APP_CONFIG.sources.nate) {
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

    if (APP_CONFIG.sources.signal) {
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

    const allKeywords = [
      ...data.google.map(i => i.keyword),
      ...data.signal.map(i => i.keyword),
      ...data.namu.map(i => i.keyword)
    ];
    document.getElementById('trend-ticker').textContent = ' >>> ' + allKeywords.join(' | ') + ' <<< ';

    resetTimer();

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
  startTimer();
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
                config: { topicCount: APP_CONFIG.topicCount }
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
            <div class="cat-section">
                <h3>MARKET_CONTEXT_CATEGORIES</h3>
                <div class="cat-tags">
                    ${data.categories.map(c => `
                        <div class="cat-tag">
                            <strong>${c.name}</strong>
                            <span>${c.description}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
            
            <div class="post-section">
                <h3>VIRAL_HIJACKING_STRATEGIES (TOP_${data.blogPosts.length})</h3>
                <div class="post-list">
                    ${data.blogPosts.map((post, i) => `
                        <div class="post-card marketing-card">
                            <div class="post-index">0${i+1}</div>
                            <div class="post-main">
                                <div class="post-title" style="color:var(--text-color)">${post.viralTitle}</div>
                                <div class="post-reason"><span class="highlight-tag">SEARCH_INTENT:</span> ${post.searchIntent}</div>
                                <div class="post-meta">
                                    <div class="meta-item"><span>MAIN_TREND:</span> <strong style="color:var(--namu-color)">${post.mainKeyword}</strong></div>
                                    <div class="meta-item"><span>SEO_KEYWORDS:</span> ${post.seoKeywords.join(', ')}</div>
                                    <div class="meta-item"><span>CORE_MESSAGE:</span> ${post.coreMessage}</div>
                                    <div class="meta-item"><span>VIRAL_STRATEGY:</span> ${post.strategy}</div>
                                </div>
                                <button class="write-btn" onclick='generateFullPost(${JSON.stringify(post).replace(/'/g, "&apos;")})'>
                                    WRITE_SEO_OPTIMIZED_POST
                                </button>
                            </div>
                        </div>
                    `).join('')}
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
            body: JSON.stringify({ postPlan })
        });
        
        const result = await res.json();
        // Use marked to parse markdown into HTML
        content.innerHTML = marked.parse(result.markdown);
    } catch (error) {
        content.innerHTML = '<div class="error">FATAL ERROR: FAILED TO GENERATE CONTENT. CHECK SYSTEM LOGS.</div>';
    }
}

// Settings Modal Logic
document.getElementById('settings-btn').addEventListener('click', async () => {
    document.getElementById('settings-modal').classList.remove('hidden');
    // Fetch prompt for inspector
    try {
        const res = await fetch('/api/config/prompts');
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

document.getElementById('close-post').addEventListener('click', () => {
    document.getElementById('post-modal').classList.add('hidden');
});

document.getElementById('copy-post').addEventListener('click', () => {
    const content = document.getElementById('post-content').textContent;
    navigator.clipboard.writeText(content).then(() => {
        alert('MARKDOWN COPIED TO CLIPBOARD!');
    });
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
setTimeout(fetchTrends, 1000);
