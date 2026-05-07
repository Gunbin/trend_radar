let timerInterval;
let timeRemaining = 30000;
let currentTrendsData = null;
let currentManualText = '';
let currentGeneratedMarkdown = null;
let currentGeneratedIndexEntry = null;
let APP_CONFIG = {
    interval: 30000,
    sources: { 
        KR: { ppomppu: true, aha: true, fss: true, policy: true, gNewsLabor: true, gNewsBiz: true, nate: true },
        US: { google: true, reddit: true, redditScams: true, redditPoverty: true, redditFrugal: true, yahoo: true, buzzfeed: true }
    },
    // [v2.6] 실시간 검색(Grounding)은 기본 OFF. 설정 모달에서 on 시 수동 활성화.
    useSearch: false,
    // [v3.3] Burst 주제 하드필터 기본 ON (명시적으로 끌 때만 false)
    burstHardFilterEnabled: true,
    topicCount: 3,
    itemScale: 1.0,
    region: 'KR'
};

function syncDocumentLang() {
    const lang = APP_CONFIG.region === 'US' ? 'en' : 'ko';
    document.documentElement.lang = lang;
}

/** 설정 모달 힌트 문구 — REGION에 맞게 KR/EN 전환 */
function updateSettingsHintsForRegion() {
    const us = APP_CONFIG.region === 'US';
    const set = (id, kr, en) => {
        const el = document.getElementById(id);
        if (el) el.textContent = us ? en : kr;
    };
    set(
        'hint-use-search',
        '* ENABLE_GOOGLE_SEARCH: 최신 팩트체크를 수행하지만 API 쿼터 소진이 빠를 수 있습니다.',
        '* ENABLE_GOOGLE_SEARCH: Runs fresh fact-checking; consumes API quota faster.'
    );
    set(
        'hint-burst-filter',
        '* ENABLE_BURST_HARD_FILTER: Burst 주제를 분석 단계에서 자동 review로 강등합니다. (기본 ON)',
        '* ENABLE_BURST_HARD_FILTER: Burst topics are demoted to review during analysis. (default ON)'
    );
    set(
        'hint-refresh-days',
        '* 설정한 기간 이상 지난 글을 갱신합니다.',
        '* Refreshes posts older than the configured number of days.'
    );
}

// Load settings from localStorage
function loadSettings() {
    const saved = localStorage.getItem('trendRadar_cfg');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            // Migrate old sources format
            if (parsed.sources && typeof parsed.sources.google === 'boolean') {
                APP_CONFIG.sources.KR.nate = parsed.sources.nate !== false;
                APP_CONFIG.sources.KR.gNewsBiz = true;
                APP_CONFIG.sources.KR.gNewsLabor = true;
                APP_CONFIG.sources.KR.aha = true;
            } else if (parsed.sources) {
                // Merge loaded config but default new ones to true
                const loadedKR = parsed.sources.KR || {};
                APP_CONFIG.sources.KR = {
                    ...APP_CONFIG.sources.KR,
                    ...loadedKR
                };
                delete APP_CONFIG.sources.KR.fmkorea; // Remove deprecated source from localStorage
                delete APP_CONFIG.sources.KR.google;
                delete APP_CONFIG.sources.KR.namu;
                delete APP_CONFIG.sources.KR.instiz;
                delete APP_CONFIG.sources.KR.signal;
                
                const loadedUS = parsed.sources.US || {};
                APP_CONFIG.sources.US = {
                    ...APP_CONFIG.sources.US,
                    ...loadedUS
                };
            }
            APP_CONFIG.interval = parsed.interval || APP_CONFIG.interval;
            APP_CONFIG.topicCount = parsed.topicCount || APP_CONFIG.topicCount;
            APP_CONFIG.refreshDays = parsed.refreshDays || 30;
            APP_CONFIG.itemScale = [0.5, 1.0, 1.5].includes(parsed.itemScale) ? parsed.itemScale : APP_CONFIG.itemScale;
            APP_CONFIG.region = parsed.region || APP_CONFIG.region;
            APP_CONFIG.useSearch = parsed.hasOwnProperty('useSearch') ? parsed.useSearch : APP_CONFIG.useSearch;
            APP_CONFIG.burstHardFilterEnabled = parsed.hasOwnProperty('burstHardFilterEnabled')
                ? parsed.burstHardFilterEnabled
                : APP_CONFIG.burstHardFilterEnabled;
        } catch (e) {
            console.error('Failed to parse settings', e);
        }
    }
    syncUIToSettings();
}

function syncUIToSettings() {
    document.getElementById('cfg-interval').value = APP_CONFIG.interval / 1000;
    
    document.getElementById('src-ppomppu').checked = APP_CONFIG.sources.KR.ppomppu !== false;
    document.getElementById('src-aha').checked = APP_CONFIG.sources.KR.aha !== false;
    document.getElementById('src-fss').checked = APP_CONFIG.sources.KR.fss !== false;
    document.getElementById('src-policy').checked = APP_CONFIG.sources.KR.policy !== false;
    document.getElementById('src-gnews-labor').checked = APP_CONFIG.sources.KR.gNewsLabor !== false;
    document.getElementById('src-gnews-biz').checked = APP_CONFIG.sources.KR.gNewsBiz !== false;
    document.getElementById('src-nate').checked = APP_CONFIG.sources.KR.nate;
    
    document.getElementById('src-google-us').checked = APP_CONFIG.sources.US.google;
    document.getElementById('src-reddit').checked = APP_CONFIG.sources.US.reddit;
    document.getElementById('src-reddit-scams').checked = APP_CONFIG.sources.US.redditScams !== false;
    document.getElementById('src-reddit-poverty').checked = APP_CONFIG.sources.US.redditPoverty !== false;
    document.getElementById('src-reddit-frugal').checked = APP_CONFIG.sources.US.redditFrugal !== false;
    document.getElementById('src-yahoo').checked = APP_CONFIG.sources.US.yahoo;
    document.getElementById('src-buzzfeed').checked = APP_CONFIG.sources.US.buzzfeed !== false;

    document.getElementById('cfg-use-search').checked = APP_CONFIG.useSearch;
    const cfgBurstHardFilter = document.getElementById('cfg-burst-hard-filter');
    if (cfgBurstHardFilter) cfgBurstHardFilter.checked = APP_CONFIG.burstHardFilterEnabled !== false;
    document.getElementById('cfg-topics').value = APP_CONFIG.topicCount;
    document.getElementById('cfg-item-scale').value = APP_CONFIG.itemScale;
    updateItemScaleHint(APP_CONFIG.itemScale);
    const cfgRefreshDays = document.getElementById('cfg-refresh-days');
    if (cfgRefreshDays) cfgRefreshDays.value = APP_CONFIG.refreshDays || 30;
    document.getElementById('region-select').value = APP_CONFIG.region || 'KR';
    
    updateIntervalHint(APP_CONFIG.interval / 1000);
    document.getElementById('topics-val').textContent = `${APP_CONFIG.topicCount} TOPICS`;
    syncDocumentLang();
    updateSettingsHintsForRegion();

    updatePanelVisibility();
}

function saveSettings() {
    APP_CONFIG.interval = parseInt(document.getElementById('cfg-interval').value) * 1000;
    
    APP_CONFIG.sources.KR.ppomppu = document.getElementById('src-ppomppu').checked;
    APP_CONFIG.sources.KR.aha = document.getElementById('src-aha').checked;
    APP_CONFIG.sources.KR.fss = document.getElementById('src-fss').checked;
    APP_CONFIG.sources.KR.policy = document.getElementById('src-policy').checked;
    APP_CONFIG.sources.KR.gNewsLabor = document.getElementById('src-gnews-labor').checked;
    APP_CONFIG.sources.KR.gNewsBiz = document.getElementById('src-gnews-biz').checked;
    APP_CONFIG.sources.KR.nate = document.getElementById('src-nate').checked;
    
    APP_CONFIG.sources.US.google = document.getElementById('src-google-us').checked;
    APP_CONFIG.sources.US.reddit = document.getElementById('src-reddit').checked;
    APP_CONFIG.sources.US.redditScams = document.getElementById('src-reddit-scams').checked;
    APP_CONFIG.sources.US.redditPoverty = document.getElementById('src-reddit-poverty').checked;
    APP_CONFIG.sources.US.redditFrugal = document.getElementById('src-reddit-frugal').checked;
    APP_CONFIG.sources.US.yahoo = document.getElementById('src-yahoo').checked;
    APP_CONFIG.sources.US.buzzfeed = document.getElementById('src-buzzfeed').checked;

    APP_CONFIG.useSearch = document.getElementById('cfg-use-search').checked;
    const cfgBurstHardFilter = document.getElementById('cfg-burst-hard-filter');
    APP_CONFIG.burstHardFilterEnabled = cfgBurstHardFilter ? cfgBurstHardFilter.checked : true;
    APP_CONFIG.topicCount = parseInt(document.getElementById('cfg-topics').value);
    APP_CONFIG.itemScale = parseFloat(document.getElementById('cfg-item-scale').value) || 1.0;
    const cfgRefreshDays = document.getElementById('cfg-refresh-days');
    if (cfgRefreshDays) {
        APP_CONFIG.refreshDays = parseInt(cfgRefreshDays.value) || 30;
    }
    
    localStorage.setItem('trendRadar_cfg', JSON.stringify(APP_CONFIG));
    updatePanelVisibility();
    resetTimer(); 
}

document.getElementById('region-select').addEventListener('change', (e) => {
    APP_CONFIG.region = e.target.value;
    currentTrendsData = null; // Clear old data to prevent stale AI analysis
    localStorage.setItem('trendRadar_cfg', JSON.stringify(APP_CONFIG));
    updatePanelVisibility();
    syncUIToSettings(); // Sync checkboxes visibility in settings
    resetTimer(); // Immediately refetch on region change
});

function updatePanelVisibility() {
    const isKR = APP_CONFIG.region === 'KR';
    
    // Clear all lists when switching to avoid stale data display
    const lists = ['ppomppu-list', 'aha-list', 'fss-list', 'policy-list', 'gnews-labor-list', 'google-list', 'signal-list', 'reddit-list', 'reddit-scams-list', 'reddit-poverty-list', 'reddit-frugal-list', 'yahoo-list', 'buzzfeed-list'];
    lists.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '<li class="loading">SWITCHING REGION...</li>';
    });
    
    if (isKR) {
        document.querySelector('.ppomppu-panel').style.display = APP_CONFIG.sources.KR.ppomppu ? 'flex' : 'none';
        document.querySelector('.instiz-panel').style.display = APP_CONFIG.sources.KR.aha ? 'flex' : 'none';
        document.querySelector('.fss-panel').style.display = APP_CONFIG.sources.KR.fss ? 'flex' : 'none';
        document.querySelector('.policy-panel').style.display = APP_CONFIG.sources.KR.policy ? 'flex' : 'none';
        document.querySelector('.namu-panel').style.display = APP_CONFIG.sources.KR.gNewsLabor ? 'flex' : 'none';
        document.querySelector('.google-panel').style.display = APP_CONFIG.sources.KR.gNewsBiz ? 'flex' : 'none';
        document.querySelector('.signal-panel').style.display = APP_CONFIG.sources.KR.nate ? 'flex' : 'none';
        
        document.querySelector('.reddit-panel').style.display = 'none';
        document.querySelector('.reddit-scams-panel').style.display = 'none';
        document.querySelector('.reddit-poverty-panel').style.display = 'none';
        document.querySelector('.reddit-frugal-panel').style.display = 'none';
        document.querySelector('.yahoo-panel').style.display = 'none';
        document.querySelector('.buzzfeed-panel').style.display = 'none';
        
        document.getElementById('src-group-kr').classList.remove('hidden');
        document.getElementById('src-group-us').classList.add('hidden');
        document.querySelector('.google-panel .panel-title').innerHTML = '> GOOGLE_NEWS_BIZ <span class="blink">_</span>';
    } else {
        document.querySelector('.google-panel').style.display = APP_CONFIG.sources.US.google ? 'flex' : 'none';
        document.querySelector('.signal-panel').style.display = 'none';
        document.querySelector('.namu-panel').style.display = 'none';
        document.querySelector('.fss-panel').style.display = 'none';
        document.querySelector('.policy-panel').style.display = 'none';
        document.querySelector('.ppomppu-panel').style.display = 'none';
        document.querySelector('.instiz-panel').style.display = 'none';
        
        document.querySelector('.reddit-panel').style.display = APP_CONFIG.sources.US.reddit ? 'flex' : 'none';
        document.querySelector('.reddit-scams-panel').style.display = APP_CONFIG.sources.US.redditScams !== false ? 'flex' : 'none';
        document.querySelector('.reddit-poverty-panel').style.display = APP_CONFIG.sources.US.redditPoverty !== false ? 'flex' : 'none';
        document.querySelector('.reddit-frugal-panel').style.display = APP_CONFIG.sources.US.redditFrugal !== false ? 'flex' : 'none';
        document.querySelector('.yahoo-panel').style.display = APP_CONFIG.sources.US.yahoo ? 'flex' : 'none';
        document.querySelector('.buzzfeed-panel').style.display = APP_CONFIG.sources.US.buzzfeed !== false ? 'flex' : 'none';
        
        document.getElementById('src-group-kr').classList.add('hidden');
        document.getElementById('src-group-us').classList.remove('hidden');
        document.querySelector('.google-panel .panel-title').innerHTML = '> GOOGLE_TRENDS_US <span class="blink">_</span>';
    }
}

async function fetchTrends() {
  try {
    let activeSourcesArr = [];
    if (APP_CONFIG.region === 'KR') {
        if (APP_CONFIG.sources.KR.ppomppu) activeSourcesArr.push('ppomppu');
        if (APP_CONFIG.sources.KR.aha) activeSourcesArr.push('aha');
        if (APP_CONFIG.sources.KR.fss) activeSourcesArr.push('fss');
        if (APP_CONFIG.sources.KR.policy) activeSourcesArr.push('policy');
        if (APP_CONFIG.sources.KR.gNewsLabor) activeSourcesArr.push('gNewsLabor');
        if (APP_CONFIG.sources.KR.gNewsBiz) activeSourcesArr.push('gNewsBiz');
        if (APP_CONFIG.sources.KR.nate) activeSourcesArr.push('signal'); // 서버는 nate를 'signal' 파라미터로 받음
    } else {
        if (APP_CONFIG.sources.US.google) activeSourcesArr.push('google');
        if (APP_CONFIG.sources.US.reddit) activeSourcesArr.push('reddit');
        if (APP_CONFIG.sources.US.redditScams) activeSourcesArr.push('redditScams');
        if (APP_CONFIG.sources.US.redditPoverty) activeSourcesArr.push('redditPoverty');
        if (APP_CONFIG.sources.US.redditFrugal) activeSourcesArr.push('redditFrugal');
        if (APP_CONFIG.sources.US.yahoo) activeSourcesArr.push('yahoo');
        if (APP_CONFIG.sources.US.buzzfeed) activeSourcesArr.push('buzzfeed');
    }
    const activeSources = activeSourcesArr.join(',');

    const res = await fetch(`/api/trends?region=${APP_CONFIG.region || 'KR'}&sources=${activeSources}&itemScale=${APP_CONFIG.itemScale}`);
    const rawData = await res.json();
    
    // Filter data based on active settings and region
    const data = {
        timestamp: rawData.timestamp,
        sourceDescriptions: rawData.sourceDescriptions,
        ppomppu: (APP_CONFIG.region === 'KR' && APP_CONFIG.sources.KR.ppomppu) ? rawData.ppomppu : [],
        aha: (APP_CONFIG.region === 'KR' && APP_CONFIG.sources.KR.aha) ? rawData.aha : [],
        fss: (APP_CONFIG.region === 'KR' && APP_CONFIG.sources.KR.fss) ? rawData.fss : [],
        policy: (APP_CONFIG.region === 'KR' && APP_CONFIG.sources.KR.policy) ? rawData.policy : [],
        gNewsLabor: (APP_CONFIG.region === 'KR' && APP_CONFIG.sources.KR.gNewsLabor) ? rawData.gNewsLabor : [],
        gNewsBiz: (APP_CONFIG.region === 'KR' && APP_CONFIG.sources.KR.gNewsBiz) ? rawData.gNewsBiz : [],
        signal: (APP_CONFIG.region === 'KR' && APP_CONFIG.sources.KR.nate) ? rawData.signal : [],
        google: (APP_CONFIG.region === 'US' && APP_CONFIG.sources.US.google) ? rawData.google : [],
        reddit: (APP_CONFIG.region === 'US' && APP_CONFIG.sources.US.reddit) ? rawData.reddit : [],
        redditScams: (APP_CONFIG.region === 'US' && APP_CONFIG.sources.US.redditScams) ? rawData.redditScams : [],
        redditPoverty: (APP_CONFIG.region === 'US' && APP_CONFIG.sources.US.redditPoverty) ? rawData.redditPoverty : [],
        redditFrugal: (APP_CONFIG.region === 'US' && APP_CONFIG.sources.US.redditFrugal) ? rawData.redditFrugal : [],
        buzzfeed: (APP_CONFIG.region === 'US' && APP_CONFIG.sources.US.buzzfeed) ? rawData.buzzfeed : [],
        yahoo: (APP_CONFIG.region === 'US' && APP_CONFIG.sources.US.yahoo) ? rawData.yahoo : []
    };
    
    currentTrendsData = data; 
    
    const date = new Date(data.timestamp);
    document.getElementById('last-update').textContent = date.toLocaleTimeString();

    if (APP_CONFIG.region === 'KR' && APP_CONFIG.sources.KR.ppomppu) {
        renderList('ppomppu-list', data.ppomppu, (item) => `
            <div class="trend-item" style="animation-delay: ${item.rank * 50}ms">
              <div class="rank">${item.rank.toString().padStart(2, '0')}</div>
              <div class="content">
                <div class="keyword">${item.keyword}</div>
                <div class="meta">
                  <span style="color:var(--namu-color)">> HOT DEAL</span><br>
                  <a href="${item.url}" target="_blank" class="news-item">바로가기</a>
                </div>
              </div>
            </div>
        `);
    }

    if (APP_CONFIG.region === 'KR' && APP_CONFIG.sources.KR.aha) {
        renderList('aha-list', data.aha, (item) => `
            <div class="trend-item" style="animation-delay: ${item.rank * 50}ms">
              <div class="rank">${item.rank.toString().padStart(2, '0')}</div>
              <div class="content">
                <div class="keyword">${item.keyword}</div>
                <div class="meta">
                  <span style="color:var(--neon-color)">> EXPERT Q&A</span><br>
                  <a href="${item.url}" target="_blank" class="news-item">바로가기</a>
                </div>
              </div>
            </div>
        `);
    }

    if (APP_CONFIG.region === 'KR' && APP_CONFIG.sources.KR.fss) {
        renderList('fss-list', data.fss, (item) => `
            <div class="trend-item" style="animation-delay: ${item.rank * 50}ms">
              <div class="rank">${item.rank.toString().padStart(2, '0')}</div>
              <div class="content">
                <div class="keyword">${item.keyword}</div>
                <div class="meta">
                  <span style="color:#ff5555">> 경보발령: ${new Date(item.pubDate).toLocaleDateString()}</span><br>
                  <a href="${item.url}" target="_blank" class="news-item">상세보기</a>
                </div>
              </div>
            </div>
        `);
    }

    if (APP_CONFIG.region === 'KR' && APP_CONFIG.sources.KR.policy) {
        renderList('policy-list', data.policy, (item) => `
            <div class="trend-item" style="animation-delay: ${item.rank * 50}ms">
              <div class="rank">${item.rank.toString().padStart(2, '0')}</div>
              <div class="content">
                <div class="keyword">${item.keyword}</div>
                <div class="meta">
                  <span style="color:#55ff55">> 정책발표: ${new Date(item.pubDate).toLocaleDateString()}</span><br>
                  <a href="${item.url}" target="_blank" class="news-item">상세보기</a>
                </div>
              </div>
            </div>
        `);
    }

    if (APP_CONFIG.region === 'KR' && APP_CONFIG.sources.KR.gNewsLabor) {
        renderList('gnews-labor-list', data.gNewsLabor, (item) => `
            <div class="trend-item" style="animation-delay: ${item.rank * 50}ms">
              <div class="rank">${item.rank.toString().padStart(2, '0')}</div>
              <div class="content">
                <div class="keyword">${item.keyword}</div>
                <div class="meta">
                  <span style="color:#55ff55">> PUB: ${new Date(item.pubDate).toLocaleDateString()}</span><br>
                  <a href="${item.url}" target="_blank" class="news-item">기사보기</a>
                </div>
              </div>
            </div>
        `);
    }

    if (APP_CONFIG.region === 'KR' && APP_CONFIG.sources.KR.gNewsBiz) {
        renderList('google-list', data.gNewsBiz, (item) => `
          <div class="trend-item" style="animation-delay: ${item.rank * 50}ms">
            <div class="rank">${item.rank.toString().padStart(2, '0')}</div>
            <div class="content">
              <div class="keyword">${item.keyword}</div>
              <div class="meta">
                <span style="color:var(--google-color)">> PUB: ${new Date(item.pubDate).toLocaleDateString()}</span><br>
                <a href="${item.url}" target="_blank" class="news-item">기사보기</a>
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

    if (APP_CONFIG.region === 'US' && APP_CONFIG.sources.US.google) {
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

    if (APP_CONFIG.region === 'US' && APP_CONFIG.sources.US.redditScams) {
        renderList('reddit-scams-list', data.redditScams, (item) => `
            <div class="trend-item" style="animation-delay: ${item.rank * 50}ms">
              <div class="rank">${item.rank.toString().padStart(2, '0')}</div>
              <div class="content">
                <div class="keyword">${item.keyword}</div>
                <div class="meta">
                  <span style="color:#ff5555">> SCAM ALERT / SCORE: ${item.score}</span><br>
                  <a href="${item.url}" target="_blank" class="news-item">[${item.subreddit}] View Post</a>
                </div>
              </div>
            </div>
        `);
    }

    if (APP_CONFIG.region === 'US' && APP_CONFIG.sources.US.redditPoverty) {
        renderList('reddit-poverty-list', data.redditPoverty, (item) => `
            <div class="trend-item" style="animation-delay: ${item.rank * 50}ms">
              <div class="rank">${item.rank.toString().padStart(2, '0')}</div>
              <div class="content">
                <div class="keyword">${item.keyword}</div>
                <div class="meta">
                  <span style="color:#55ff55">> WELFARE INFO / SCORE: ${item.score}</span><br>
                  <a href="${item.url}" target="_blank" class="news-item">[${item.subreddit}] View Post</a>
                </div>
              </div>
            </div>
        `);
    }

    if (APP_CONFIG.region === 'US' && APP_CONFIG.sources.US.redditFrugal) {
        renderList('reddit-frugal-list', data.redditFrugal, (item) => `
            <div class="trend-item" style="animation-delay: ${item.rank * 50}ms">
              <div class="rank">${item.rank.toString().padStart(2, '0')}</div>
              <div class="content">
                <div class="keyword">${item.keyword}</div>
                <div class="meta">
                  <span style="color:var(--namu-color)">> SMART TIP / SCORE: ${item.score}</span><br>
                  <a href="${item.url}" target="_blank" class="news-item">[${item.subreddit}] 상세보기</a>
                </div>
              </div>
            </div>
        `);
    }

    if (APP_CONFIG.region === 'US' && APP_CONFIG.sources.US.buzzfeed) {
        renderList('buzzfeed-list', data.buzzfeed, (item) => `
            <div class="trend-item" style="animation-delay: ${item.rank * 50}ms">
              <div class="rank">${item.rank.toString().padStart(2, '0')}</div>
              <div class="content">
                <div class="keyword">${item.keyword}</div>
                <div class="meta">
                  <span style="color:var(--neon-color)">> VIRAL TREND</span><br>
                  <a href="${item.url}" target="_blank" class="news-item">Open</a>
                </div>
              </div>
            </div>
        `);
    }

    const allKeywords = APP_CONFIG.region === 'KR' ? [
      ...(data.ppomppu || []).map(i => i.keyword),
      ...(data.aha || []).map(i => i.keyword),
      ...(data.fss || []).map(i => i.keyword),
      ...(data.policy || []).map(i => i.keyword),
      ...(data.gNewsLabor || []).map(i => i.keyword),
      ...(data.gNewsBiz || []).map(i => i.keyword),
      ...(data.signal || []).map(i => i.keyword)
    ] : [
      ...(data.google || []).map(i => i.keyword),
      ...(data.reddit || []).map(i => i.keyword),
      ...(data.redditScams || []).map(i => i.keyword),
      ...(data.redditPoverty || []).map(i => i.keyword),
      ...(data.redditFrugal || []).map(i => i.keyword),
      ...(data.buzzfeed || []).map(i => i.keyword),
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

async function fetchPromptPreview(stage, payload, title) {
    const modal = document.getElementById('prompt-modal');
    const titleEl = document.getElementById('prompt-modal-title');
    const contentEl = document.getElementById('prompt-modal-content');
    titleEl.textContent = title || 'GEMINI_PROMPT_PREVIEW';
    contentEl.textContent = 'LOADING PROMPT...';
    modal.classList.remove('hidden');

    try {
        const res = await fetch('/api/debug/prompt-preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage, ...payload })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'PREVIEW FAILED');
        const metaText = data?.meta ? `/* ${JSON.stringify(data.meta, null, 2)} */\n\n` : '';
        contentEl.textContent = `${metaText}${data.prompt || ''}`;
    } catch (error) {
        contentEl.textContent = `PROMPT PREVIEW FAILED:\n${error.message}`;
    }
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
    currentManualText = '';
    
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
                config: { 
                    topicCount: APP_CONFIG.topicCount,
                    useSearch: APP_CONFIG.useSearch,
                    burstHardFilterEnabled: APP_CONFIG.burstHardFilterEnabled
                },
                region: APP_CONFIG.region || 'KR'
            })
        });
        
        const result = await res.json();
        renderAIAnalysis(result);
    } catch (error) {
        aiContent.innerHTML = '<div class="error">AI ANALYSIS FAILED. CHECK API KEY AND SERVER LOGS.</div>';
    }
});

document.getElementById('refresh-btn').addEventListener('click', async () => {
    if (!confirm(`Are you sure you want to refresh the oldest post (older than ${APP_CONFIG.refreshDays || 30} days)?`)) return;
    
    const btn = document.getElementById('refresh-btn');
    const originalText = btn.textContent;
    btn.textContent = 'REFRESHING...';
    btn.disabled = true;
    
    try {
        const res = await fetch('/api/refresh-oldest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshDays: APP_CONFIG.refreshDays || 30 })
        });
        const result = await res.json();
        
        if (result.success) {
            alert(`SUCCESS: ${result.message}\nURL: ${result.url || ''}`);
        } else {
            alert(`FAILED: ${result.message || result.error}\n${result.details || ''}`);
        }
    } catch (error) {
        alert('REFRESH ERROR: ' + error.message);
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
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
    currentManualText = manualText;
    
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
                config: { 
                    topicCount: APP_CONFIG.topicCount,
                    useSearch: APP_CONFIG.useSearch,
                    burstHardFilterEnabled: APP_CONFIG.burstHardFilterEnabled
                },
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

// [v2.7] priority 기반 정렬 순서 (primary → secondary → review)
const PRIORITY_RANK = { primary: 1, secondary: 2, review: 3 };

// [v2.7] priority 뱃지 — REGION별 임계값 안내 (서버 annotate와 맞춤)
const PRIORITY_META_KR = {
    primary:   { label: 'PRIMARY',   icon: '■', title: 'SEO 생존점수 우수 (seoViability≥8) — 서버 기준 메인 후보' },
    secondary: { label: 'SECONDARY', icon: '▲', title: '생존점수 보통 (≥5) 또는 경쟁 과열(competitionIndex>3) 시 보조 후보' },
    review:    { label: 'REVIEW',    icon: '?', title: '검색량 0·Burst·painScore 누락/약함·과열+저점수 등 재검토' }
};
const PRIORITY_META_US = {
    primary:   { label: 'PRIMARY',   icon: '■', title: 'Strong viability (seoViability≥4 on Google Suggest path) — main pick' },
    secondary: { label: 'SECONDARY', icon: '▲', title: 'Moderate (≥2) or high competition (>4.5) with rescue score — secondary' },
    review:    { label: 'REVIEW',    icon: '?', title: 'searchVolume 0, Burst, weak pain, or hot competition + low score — recheck' }
};
function getPriorityMeta(region) {
    return region === 'US' ? PRIORITY_META_US : PRIORITY_META_KR;
}

// HTML 이스케이프 (문자열 값 삽입 안전용)
function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function isBlueOceanIndex(ci, region) {
    if (typeof ci !== 'number') return false;
    const th = region === 'US' ? 0.6 : 0.5;
    return ci < th;
}

function formatCompetitionIndex(ci) {
    return typeof ci === 'number' ? ci : '-';
}

function renderAIAnalysis(data) {
    const aiContent = document.getElementById('ai-content');
    const region = APP_CONFIG.region || 'KR';
    const isUS = region === 'US';
    const pMeta = getPriorityMeta(region);

    // [v3.1] Checked Keywords Pool Table 렌더링
    let poolHtml = '';
    if (data._keywordPool && Object.keys(data._keywordPool).length > 0) {
        let poolRows = Object.entries(data._keywordPool).map(([kw, d]) => {
            const docCell =
                d.documentCount != null && typeof d.documentCount === 'number'
                    ? d.documentCount.toLocaleString()
                    : 'N/A';
            const volCell =
                typeof d.searchVolume === 'number' ? d.searchVolume.toLocaleString() : 'N/A';
            return `
            <tr>
                <td>${esc(kw)}</td>
                <td>${volCell}</td>
                <td>${docCell}</td>
                <td class="${isBlueOceanIndex(d.competitionIndex, region) ? 'blue-ocean-text' : ''}">${formatCompetitionIndex(d.competitionIndex)}</td>
            </tr>`;
        }).join('');
        const poolTitle = isUS
            ? '📊 Checked Keywords Pool (Google Suggest — demand proxy)'
            : '📊 Checked Keywords Pool (Real-time Naver Metrics)';

        poolHtml = `
            <div class="pool-section">
                <div class="pool-title">${poolTitle}</div>
                <div class="pool-table-wrapper">
                    <table class="pool-table">
                        <thead>
                            <tr>
                                <th>KEYWORD</th>
                                <th>VOLUME</th>
                                <th>DOCS</th>
                                <th>COMP</th>
                            </tr>
                        </thead>
                        <tbody>${poolRows}</tbody>
                    </table>
                </div>
            </div>
        `;
    }

    // [v2.7] 기획안을 priority 기준으로 정렬 (원본 순서는 index 로 보존)
    const sortedPosts = (data.blogPosts || [])
        .map((post, origIndex) => ({ post, origIndex }))
        .sort((a, b) => {
            const ra = PRIORITY_RANK[a.post._meta?.priority] || 99;
            const rb = PRIORITY_RANK[b.post._meta?.priority] || 99;
            if (ra !== rb) return ra - rb;
            // 같은 priority 내에서는 painScore 높은 순
            const pa = a.post.painScore ?? -1;
            const pb = b.post.painScore ?? -1;
            return pb - pa;
        });

    // [v2.7] 우선순위별 카운트 (통계 바)
    const counts = { primary: 0, secondary: 0, review: 0, unknown: 0 };
    for (const { post } of sortedPosts) {
        const p = post._meta?.priority;
        if (counts[p] !== undefined) counts[p]++;
        else counts.unknown++;
    }

    const statsBar = `
        <div class="priority-stats-bar">
            <div class="stats-left">
                <span class="stats-label">QUALITY_DISTRIBUTION:</span>
                <span class="stat-chip chip-primary" title="${esc(pMeta.primary.title)}">
                    ${pMeta.primary.icon} PRIMARY ${counts.primary}
                </span>
                <span class="stat-chip chip-secondary" title="${esc(pMeta.secondary.title)}">
                    ${pMeta.secondary.icon} SECONDARY ${counts.secondary}
                </span>
                <span class="stat-chip chip-review" title="${esc(pMeta.review.title)}">
                    ${pMeta.review.icon} REVIEW ${counts.review}
                </span>
                ${counts.unknown ? `<span class="stat-chip chip-unknown">? LEGACY ${counts.unknown}</span>` : ''}
            </div>
            <div class="stats-right">
                <label class="filter-toggle">
                    <input type="checkbox" id="hide-review-toggle" onchange="togglePriorityFilter()" />
                    <span>HIDE REVIEW</span>
                </label>
            </div>
        </div>
    `;

    const cardsHtml = sortedPosts.map(({ post, origIndex }) => {
        const title = post.viralTitles
            ? (post.viralTitles.curiosity || post.viralTitles.dataDriven || post.viralTitles.solution || post.mainKeyword)
            : (post.viralTitle || post.mainKeyword);

        // [v2.7] priority 뱃지
        const priority = post._meta?.priority || 'unknown';
        const meta = pMeta[priority];
        const legacyTitle = isUS
            ? 'Legacy response — priority metadata missing'
            : 'legacy 응답 — painScore 필드 없음';
        const badgeHtml = meta
            ? `<span class="priority-badge badge-${priority}" title="${esc(meta.title)}">${meta.icon} ${meta.label}</span>`
            : `<span class="priority-badge badge-unknown" title="${esc(legacyTitle)}">? LEGACY</span>`;
            // [v2.7] painScore
        const painScore = Number.isFinite(post.painScore) ? post.painScore : null;
        const painTitle = isUS
            ? 'Pain composite (urgency × severity × impact), scale 3–15'
            : '심각성+시급성+타격 합산 (3~15)';
        const painBadge = painScore !== null
            ? `<span class="metric-chip" title="${esc(painTitle)}">PAIN: <strong>${painScore}</strong>/15</span>`
            : '';

        const suggestProxy = post._metricsSource === 'google_suggest';
        const searchTooltip =
            suggestProxy && typeof post._demandScore === 'number'
                ? ` title="${esc(`Suggest demand proxy (not monthly search volume); demandScore ${post._demandScore}/5`)}"`
                : '';
        const docDisplay =
            post.documentCount != null && typeof post.documentCount === 'number'
                ? post.documentCount.toLocaleString()
                : 'N/A';
        const compTitle = isUS
            ? 'Suggest competition index (~0–5). Blue-ocean styling if below 0.6 (US path).'
            : '경쟁 지수 — 0.5 미만 블루오션, 값이 없으면 "-"';

        // [v3.1] Metrics Badge Row (TARGET_KW 추가)
        const metricsHtml = (post.searchVolume !== undefined)
            ? `<div class="metrics-row">
                <div class="metric-item" style="flex: 2">
                    <span class="m-label">TARGET_KW:</span>
                    <span class="m-value" style="color:var(--namu-color)">${esc(post.targetKeyword || 'N/A')}</span>
                </div>
                <div class="metric-item"${searchTooltip}>
                    <span class="m-label">SEARCH:</span>
                    <span class="m-value">${Number(post.searchVolume).toLocaleString()}</span>
                </div>
                <div class="metric-item">
                    <span class="m-label">DOCS:</span>
                    <span class="m-value">${docDisplay}</span>
                </div>
                <div class="metric-item ${isBlueOceanIndex(post.competitionIndex, region) ? 'blue-ocean' : ''}" title="${esc(compTitle)}">
                    <span class="m-label">COMP:</span>
                    <span class="m-value">${formatCompetitionIndex(post.competitionIndex)}</span>
                </div>
               </div>`
            : '';

        // [v2.7] sourceUrls — 메타에 추가
        const sourceUrlsHtml = Array.isArray(post.sourceUrls) && post.sourceUrls.length
            ? `<div class="meta-item"><span>SOURCE_URLS:</span> ${post.sourceUrls.map(u => `<a href="${esc(u)}" target="_blank" style="color:var(--google-color)">[LINK]</a>`).join(' ')}</div>`
            : '';

        const cardClasses = ['post-card', 'marketing-card', `priority-${priority}`];

        return `
        <div class="${cardClasses.join(' ')}" data-priority="${priority}">
            <div class="post-index">0${origIndex + 1}</div>
            <div class="post-main">
                <div class="card-header-row">
                    ${badgeHtml}
                    ${painBadge}
                    
                </div>
                ${post._meta?.reason ? `<div class="priority-reason-text">${esc(post._meta.reason)}</div>` : ''}
                <div class="post-title" style="color:var(--text-color)">${esc(title)}</div>
                
                ${metricsHtml}
                
                <div class="post-reason"><span class="highlight-tag">CATEGORY:</span> ${esc(post.category)}</div>
                <div class="post-reason"><span class="highlight-tag">SEARCH_INTENT:</span> ${esc(post.searchIntent)}</div>
                <div class="post-reason"><span class="highlight-tag">TARGET_AUDIENCE:</span> ${esc(post.trafficStrategy?.targetAudience || 'N/A')}</div>
                
                <div class="post-meta">
                    <div class="meta-item"><span>MAIN_TREND:</span> <strong style="color:var(--namu-color)">${esc(post.mainKeyword)}</strong></div>
                    <div class="meta-item"><span>ANGLE:</span> ${esc(post.angleType || 'guide')}</div>
                    <div class="meta-item"><span>LIFECYCLE:</span> ${esc(post.trafficStrategy?.lifecycle || 'N/A')}</div>
                    <div class="meta-item"><span>DEPTH:</span> ${esc(post.contentDepth || 'N/A')}</div>
                    <div class="meta-item"><span>SHOPPABLE_ITEM:</span> ${esc(post.shoppableKeyword || 'None')}</div>
                    <div class="meta-item"><span>CORE_FACT:</span> ${esc(post.coreFact)}</div>
                    <div class="meta-item"><span>CORE_ENTITIES:</span> ${(Array.isArray(post.coreEntities) ? post.coreEntities : []).map(esc).join(', ')}</div>
                    <div class="meta-item"><span>SEO_KEYWORDS:</span> ${(post.seoKeywords || []).map(esc).join(', ')}</div>
                    ${post.lsiKeywords ? `<div class="meta-item"><span>LSI_KEYWORDS:</span> ${(Array.isArray(post.lsiKeywords) ? post.lsiKeywords : []).map(esc).join(', ')}</div>` : ''}
                    <div class="meta-item"><span>NEWS_MAIN:</span> ${esc(post.searchQueries?.news_main || post.searchQueries?.news || post.newsSearchQuery || 'N/A')}</div>
                    <div class="meta-item"><span>NEWS_SUB:</span> ${esc(post.searchQueries?.news_sub || 'N/A')}</div>
                    <div class="meta-item"${isUS ? ` title="${esc('News API enriches facts; kin is the Reddit/Q&A discovery hint.')}"` : ''}><span>KIN_QUERY:</span> ${esc(post.searchQueries?.kin || 'N/A')}</div>
                    <div class="meta-item"><span>CORE_MESSAGE:</span> ${esc(post.coreMessage)}</div>
                    ${sourceUrlsHtml}
                </div>
                <div class="card-action-row">
                    <button class="write-btn" onclick='generateFullPost(${JSON.stringify(post).replace(/'/g, "&apos;")})'>
                        WRITE_SEO_OPTIMIZED_POST
                    </button>
                    <button class="preview-btn" onclick='previewPostPrompt(${JSON.stringify(post).replace(/'/g, "&apos;")})'>
                        VIEW_POST_PROMPT
                    </button>
                </div>
            </div>
        </div>`;
    }).join('');

    aiContent.innerHTML = `
        <div class="analysis-grid">
            <div class="post-section">
                <h3>VIRAL_HIJACKING_STRATEGIES (TOP_${sortedPosts.length})</h3>
                ${poolHtml}
                ${statsBar}
                <div class="post-list">
                    ${cardsHtml}
                </div>
            </div>
        </div>
    `;
}

// [v2.7] REVIEW 카드 show/hide 토글 (자동 탈락 없이 사용자 편의)
function togglePriorityFilter() {
    const checkbox = document.getElementById('hide-review-toggle');
    const hideReview = checkbox && checkbox.checked;
    document.querySelectorAll('.post-card[data-priority]').forEach(card => {
        const p = card.getAttribute('data-priority');
        if (hideReview && (p === 'review' || p === 'unknown')) {
            card.style.display = 'none';
        } else {
            card.style.display = '';
        }
    });
}

async function generateFullPost(postPlan) {
    const modal = document.getElementById('post-modal');
    const content = document.getElementById('post-content');
    
    modal.classList.remove('hidden');
    content.textContent = "FETCHING REAL-TIME FACTS & GENERATING BLOG POST...\nPLEASE WAIT FOR NEURAL PROCESSING...";

    try {        const res = await fetch('/api/generate-post', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                postPlan,
                region: APP_CONFIG.region || 'KR',
                useSearch: APP_CONFIG.useSearch
            })
        });
        
        const result = await res.json();
        currentGeneratedMarkdown = result.markdown;
        // [v2.4] 카니발 방지 인덱스용 메타. publish/push 시 함께 전송.
        currentGeneratedIndexEntry = result.indexEntry || null;
        // Use marked to parse markdown into HTML
        content.innerHTML = marked.parse(result.markdown);
    } catch (error) {
        content.innerHTML = '<div class="error">FATAL ERROR: FAILED TO GENERATE CONTENT. CHECK SYSTEM LOGS.</div>';
    }
}

async function previewPostPrompt(postPlan) {
    await fetchPromptPreview('post_generation', {
        postPlan,
        region: APP_CONFIG.region || 'KR',
        useSearch: APP_CONFIG.useSearch
    }, 'POST_GENERATION_PROMPT');
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
                region: APP_CONFIG.region || 'KR',
                indexEntry: currentGeneratedIndexEntry
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
                region: APP_CONFIG.region || 'KR',
                indexEntry: currentGeneratedIndexEntry
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

document.getElementById('preview-keyword-btn').addEventListener('click', async () => {
    if (!currentTrendsData && !currentManualText) {
        alert('먼저 트렌드를 불러오거나 수동 입력 분석을 실행해주세요.');
        return;
    }
    await fetchPromptPreview('keyword_extraction', {
        trends: currentTrendsData,
        manualText: currentManualText,
        region: APP_CONFIG.region || 'KR'
    }, 'KEYWORD_EXTRACTION_PROMPT');
});

document.getElementById('preview-analysis-btn').addEventListener('click', async () => {
    if (!currentTrendsData && !currentManualText) {
        alert('먼저 트렌드를 불러오거나 수동 입력 분석을 실행해주세요.');
        return;
    }
    await fetchPromptPreview('analysis', {
        trends: currentTrendsData,
        manualText: currentManualText,
        config: {
            topicCount: APP_CONFIG.topicCount,
            useSearch: APP_CONFIG.useSearch,
            burstHardFilterEnabled: APP_CONFIG.burstHardFilterEnabled
        },
        region: APP_CONFIG.region || 'KR'
    }, 'PLANNING_PROMPT');
});

document.getElementById('close-prompt-btn').addEventListener('click', () => {
    document.getElementById('prompt-modal').classList.add('hidden');
});

document.getElementById('copy-prompt-btn').addEventListener('click', () => {
    const content = document.getElementById('prompt-modal-content').textContent || '';
    if (!content) return;
    navigator.clipboard.writeText(content).then(() => {
        alert('PROMPT COPIED TO CLIPBOARD!');
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

document.getElementById('cfg-item-scale').addEventListener('input', (e) => {
    updateItemScaleHint(parseFloat(e.target.value));
});

function updateIntervalHint(sec) {
    const min = (sec / 60).toFixed(1);
    document.getElementById('interval-hint').textContent = `≈ ${min} MIN`;
}

function updateItemScaleHint(scale) {
    const us = APP_CONFIG.region === 'US';
    let label = us ? 'Standard' : '표준';
    if (scale <= 0.5) label = us ? 'Fewer' : '적게';
    else if (scale >= 1.5) label = us ? 'More' : '많게';
    document.getElementById('item-scale-val').textContent = `${label} (${scale.toFixed(1)}x)`;
}

// Initialization
loadSettings();
// Initial fetch is handled by updatePanelVisibility -> resetTimer -> fetchTrends internally or explicitly.
if(!timerInterval) {
    resetTimer();
}