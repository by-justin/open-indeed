/**
 * WT3 Job Directory Client Engine
 * - Two-column master-detail layout (Master List + Reading Pane)
 * - Zero nested/outer scrollbars (100vh viewport app shell)
 * - Off-thread query syntax parser & facet engine via Web Worker
 * - Dedicated UI controls toolbar (Type, Mode, Location, Recency, Sort)
 * - Virtual table scrolling via Clusterize.js
 * - Hover prefetching & instant cached reading pane transitions
 */

(function() {
  'use strict';

  // Left Column Elements
  const searchInput = document.getElementById('search-input');
  const resultsCount = document.getElementById('results-count');
  const noResults = document.getElementById('no-results');
  const scrollArea = document.getElementById('scrollArea');
  const contentArea = document.getElementById('contentArea');

  // Controls Toolbar Elements
  const filterType = document.getElementById('filter-type');
  const filterWorkplace = document.getElementById('filter-workplace');
  const filterCountry = document.getElementById('filter-country');
  const filterRecency = document.getElementById('filter-recency');
  const filterSort = document.getElementById('filter-sort');
  const resetAllBtn = document.getElementById('reset-all-btn');
  const helpToggleBtn = document.getElementById('help-toggle-btn');
  const syntaxGuide = document.getElementById('syntax-guide');

  // Table Sort Header Elements
  const thDate = document.getElementById('th-date');
  const thCompany = document.getElementById('th-company');
  const thTitle = document.getElementById('th-title');

  // Right Column Detail Reader Elements
  const detailPane = document.getElementById('detail-pane');
  const detailHeader = document.getElementById('detail-header');
  const detailTitle = document.getElementById('detail-title');
  const detailMeta = document.getElementById('detail-meta');
  const detailApplyBtn = document.getElementById('detail-apply-btn');
  const detailNewtabBtn = document.getElementById('detail-newtab-btn');
  const detailBody = document.getElementById('detail-body');

  // State
  let colData = null;
  let searchWorker = null;
  let clusterize = null;
  let currentQueryId = 0;
  let activeSafeId = null;
  let currentIndices = null;
  const detailCache = new Map();

  // 1. Initialize Clusterize Virtual Scroller
  if (window.Clusterize && scrollArea && contentArea) {
    clusterize = new Clusterize({
      scrollId: 'scrollArea',
      contentId: 'contentArea',
      show_no_data_row: false,
      rows_in_block: 30,
      blocks_in_cluster: 4,
    });
  }

  function updateResultsCount(matchedCount) {
    if (!resultsCount || !colData) return;
    const totalDb = colData.total_db || (colData.t ? colData.t.length : 0);
    resultsCount.textContent = `${matchedCount.toLocaleString()} / ${totalDb.toLocaleString()} positions`;
  }

  // 2. Fetch Compact Columnar Catalog & Initialize Worker
  async function init() {
    try {
      const resp = await fetch('data/jobs.json');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      colData = await resp.json();

      const total = colData.t ? colData.t.length : 0;
      updateResultsCount(total);

      // Initialize Web Worker
      try {
        searchWorker = new Worker('static/search-worker.js');
        searchWorker.onmessage = handleWorkerMessage;
        searchWorker.postMessage({ type: 'init', data: colData });
      } catch (e) {
        console.warn('Web Worker initialization failed', e);
      }

      // Deep linking via URL parameters (supports Google Sitelinks Searchbox: ?q=...)
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const qParam = urlParams.get('q') || urlParams.get('search');
        const typeParam = urlParams.get('type');
        const wpParam = urlParams.get('workplace');
        const countryParam = urlParams.get('country');
        const jobParam = urlParams.get('job');

        if (qParam && searchInput) searchInput.value = qParam;
        if (typeParam && filterType) filterType.value = typeParam;
        if (wpParam && filterWorkplace) filterWorkplace.value = wpParam;
        if (countryParam && filterCountry) filterCountry.value = countryParam;

        triggerSearch();

        if (jobParam && colData && colData.i) {
          const jobIdx = colData.i.indexOf(jobParam);
          if (jobIdx !== -1) {
            showDetail(colData.i[jobIdx], colData.u[jobIdx], jobIdx);
          }
        }
      } catch (e) {
        triggerSearch();
      }
    } catch (err) {
      console.error('Failed to load jobs catalog:', err);
      if (resultsCount) resultsCount.textContent = 'Failed to load catalog';
    }
  }

  // Worker message handler
  function handleWorkerMessage(e) {
    const msg = e.data;
    if (msg.type === 'ready') {
      console.log(`Search worker indexed ${msg.total} jobs off-thread.`);
      triggerSearch();
      return;
    }
    if (msg.type === 'results' && msg.queryId === currentQueryId) {
      renderIndices(msg.indices, msg.totalMatched);
    }
  }

  // Escape HTML helper
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Generate HTML for a single row from columnar data
  function buildRow(idx) {
    const d = colData.d[idx] || '-';
    const c = escapeHtml(colData.c[idx] || '');
    const t = escapeHtml(colData.t[idx] || '');
    const sl = escapeHtml(colData.l[idx] || '');
    const fl = escapeHtml(colData.fl[idx] || '');
    const u = colData.u[idx];
    const safeId = colData.i[idx];
    const isActive = (safeId === activeSafeId) ? ' active' : '';

    return `<tr class="job-row${isActive}" data-url="${u}" data-id="${safeId}" data-index="${idx}" tabindex="0">` +
      `<td class="col-date">${d}</td>` +
      `<td class="col-company" title="${c}">${c}</td>` +
      `<td class="col-title" title="${t}">${t}</td>` +
      `<td class="col-location" title="${fl}">${sl}</td>` +
    `</tr>`;
  }

  function highlightActiveRow(safeId) {
    if (!contentArea) return;
    const allRows = contentArea.querySelectorAll('.job-row');
    allRows.forEach(r => {
      if (r.getAttribute('data-id') === safeId) {
        r.classList.add('active');
      } else {
        r.classList.remove('active');
      }
    });
  }

  async function showDetail(safeId, url, targetIndex) {
    if (!detailTitle || !detailBody) return;
    activeSafeId = safeId;
    highlightActiveRow(safeId);

    try {
      if (window.history && window.history.replaceState) {
        const u = new URL(window.location.href);
        u.searchParams.set('job', safeId);
        window.history.replaceState(null, '', u.pathname + u.search + u.hash);
      }
    } catch (e) {}

    let idx = targetIndex;
    if ((idx === undefined || idx === null || idx < 0) && colData) {
      idx = colData.i.indexOf(safeId);
    }

    if (idx >= 0 && colData) {
      const title = colData.t[idx];
      const comp = colData.c[idx];
      const loc = colData.fl[idx] || colData.l[idx];
      const date = colData.d[idx];
      const applyUrl = colData.a[idx];
      const m = (colData.m[idx] || '').toLowerCase().replace(/[-_]/g, '');
      const ml = colData.ml[idx] || (m === 'remote' ? 'Remote' : (m === 'hybrid' ? 'Hybrid' : (m === 'onsite' ? 'On-site' : '')));
      const pill = (m && m !== 'unspecified' && ml) ? `<span class="pill pill-${m}">${ml}</span>` : '';

      detailTitle.textContent = title;
      detailMeta.innerHTML = `<strong>${escapeHtml(comp)}</strong> &bull; <span>${escapeHtml(loc)}</span> ${pill ? '&bull; ' + pill : ''} &bull; <span>${date || 'Recent'}</span>`;
      if (detailApplyBtn) {
        const isExternal = applyUrl && (applyUrl.startsWith('http://') || applyUrl.startsWith('https://'));
        detailApplyBtn.href = isExternal ? applyUrl : '#';
        detailApplyBtn.style.display = isExternal ? '' : 'none';
        detailApplyBtn.textContent = `Apply on ${comp}`;
      }
      if (detailNewtabBtn) {
        detailNewtabBtn.href = url;
      }
      if (detailHeader) detailHeader.style.display = 'block';
    }

    // Check in cache
    if (detailCache.has(safeId)) {
      detailBody.innerHTML = detailCache.get(safeId);
      if (detailPane) detailPane.scrollTop = 0;
      return;
    }

    // Show loading
    detailBody.innerHTML = '<div style="text-align: center; padding: 3rem; color: var(--pico-muted-color);">Loading details...</div>';

    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const htmlText = await resp.text();

      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlText, 'text/html');
      const bodyEl = doc.querySelector('.detail-body') || doc.querySelector('#job-article') || doc.querySelector('article');

      if (bodyEl) {
        const content = bodyEl.innerHTML;
        detailCache.set(safeId, content);
        if (activeSafeId === safeId) {
          detailBody.innerHTML = content;
          if (detailPane) detailPane.scrollTop = 0;
        }
      } else {
        if (activeSafeId === safeId) {
          detailBody.innerHTML = '<p><em>No description details found.</em></p>';
        }
      }
    } catch (e) {
      if (activeSafeId === safeId) {
        detailBody.innerHTML = `<p style="color: var(--pico-muted-color); text-align: center; padding: 2rem;">Failed to load description. <a href="${url}" target="_blank" rel="noopener noreferrer">Open page directly</a></p>`;
      }
    }
  }

  function showEmptyDetail() {
    activeSafeId = null;
    if (detailHeader) detailHeader.style.display = 'none';
    if (detailBody) {
      detailBody.innerHTML = `
        <div class="empty-state-container" style="height: 100%; min-height: 380px;">
          <div class="empty-state-icon" style="width: 60px; height: 60px;">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect>
              <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path>
            </svg>
          </div>
          <div class="empty-state-title" style="font-size: 1.15rem;">No Position Selected</div>
          <div class="empty-state-desc" style="max-width: 360px;">Select a position from the left list or adjust your filters to view job details and application links.</div>
        </div>
      `;
    }
  }

  function renderAll() {
    if (!colData) return;
    const total = colData.t.length;
    currentIndices = null;
    const rows = new Array(total);
    for (let i = 0; i < total; i++) {
      rows[i] = buildRow(i);
    }
    if (clusterize) {
      clusterize.update(rows);
    }
    updateResultsCount(total);
    if (noResults) noResults.style.display = total === 0 ? 'flex' : 'none';
    if (scrollArea) scrollArea.style.display = total === 0 ? 'none' : 'block';

    if (total > 0 && !activeSafeId) {
      const firstId = colData.i[0];
      const firstUrl = colData.u[0];
      showDetail(firstId, firstUrl, 0);
    }
  }

  function renderIndices(indices, totalMatched) {
    if (!colData) return;
    currentIndices = indices;
    const count = indices.length;
    const rows = new Array(count);
    for (let i = 0; i < count; i++) {
      rows[i] = buildRow(indices[i]);
    }
    if (clusterize) {
      clusterize.update(rows);
    }
    updateResultsCount(totalMatched);
    if (noResults) {
      noResults.style.display = totalMatched === 0 ? 'flex' : 'none';
    }
    if (scrollArea) {
      scrollArea.style.display = totalMatched === 0 ? 'none' : 'block';
    }

    if (count > 0) {
      const curIdx = colData.i.indexOf(activeSafeId);
      if (curIdx === -1 || indices.indexOf(curIdx) === -1) {
        const firstIdx = indices[0];
        showDetail(colData.i[firstIdx], colData.u[firstIdx], firstIdx);
      } else {
        highlightActiveRow(activeSafeId);
      }
    } else {
      showEmptyDetail();
    }
  }

  // Trigger search execution in worker
  function triggerSearch() {
    if (!colData) return;
    const query = (searchInput ? searchInput.value.trim() : '');
    const typeVal = filterType ? filterType.value : 'all';
    const wpVal = filterWorkplace ? filterWorkplace.value : 'all';
    const countryVal = filterCountry ? filterCountry.value : 'all';
    const recencyVal = filterRecency ? filterRecency.value : 'all';
    const sortVal = filterSort ? filterSort.value : 'date-desc';

    try {
      if (window.history && window.history.replaceState) {
        const u = new URL(window.location.href);
        if (query) u.searchParams.set('q', query);
        else u.searchParams.delete('q');
        window.history.replaceState(null, '', u.pathname + u.search + u.hash);
      }
    } catch (e) {}

    const queryId = ++currentQueryId;

    if (searchWorker) {
      searchWorker.postMessage({
        action: 'search',
        query: query,
        empType: typeVal,
        workplace: wpVal,
        country: countryVal,
        recency: recencyVal,
        sort: sortVal,
        queryId: queryId,
        limit: 10000,
      });
    } else {
      renderAll();
    }
  }

  // Event Listeners for UI Controls Toolbar
  if (searchInput) {
    searchInput.addEventListener('input', triggerSearch);
  }

  [filterType, filterWorkplace, filterCountry, filterRecency, filterSort].forEach(el => {
    if (el) el.addEventListener('change', triggerSearch);
  });

  // Table Header Sort Clicks
  if (thDate) {
    thDate.addEventListener('click', () => {
      if (!filterSort) return;
      filterSort.value = (filterSort.value === 'date-desc' ? 'date-asc' : 'date-desc');
      triggerSearch();
    });
  }

  if (thCompany) {
    thCompany.addEventListener('click', () => {
      if (!filterSort) return;
      filterSort.value = 'company-asc';
      triggerSearch();
    });
  }

  if (thTitle) {
    thTitle.addEventListener('click', () => {
      if (!filterSort) return;
      filterSort.value = 'title-asc';
      triggerSearch();
    });
  }

  // Syntax Help Toggle
  if (helpToggleBtn && syntaxGuide) {
    helpToggleBtn.addEventListener('click', () => {
      const isHidden = syntaxGuide.style.display === 'none';
      syntaxGuide.style.display = isHidden ? 'block' : 'none';
    });
  }

  // Reset All Filters (Restores default Canadian Intern / Co-op preset)
  if (resetAllBtn) {
    resetAllBtn.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      if (filterType) filterType.value = 'internship_coop';
      if (filterWorkplace) filterWorkplace.value = 'all';
      if (filterCountry) filterCountry.value = 'Canada';
      if (filterRecency) filterRecency.value = 'all';
      if (filterSort) filterSort.value = 'date-desc';
      triggerSearch();
    });
  }

  const emptyResetBtn = document.getElementById('empty-reset-btn');
  if (emptyResetBtn && resetAllBtn) {
    emptyResetBtn.addEventListener('click', () => {
      resetAllBtn.click();
    });
  }

  // 3. Row Click Selection & Hover Prefetching
  if (contentArea) {
    contentArea.addEventListener('click', (e) => {
      const row = e.target.closest('.job-row');
      if (!row) return;

      const safeId = row.getAttribute('data-id');
      const url = row.getAttribute('data-url');
      const idx = parseInt(row.getAttribute('data-index'), 10);

      // Select and display in right column reader
      showDetail(safeId, url, idx);
    });

    contentArea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const row = e.target.closest('.job-row');
        if (!row) return;
        const safeId = row.getAttribute('data-id');
        const url = row.getAttribute('data-url');
        const idx = parseInt(row.getAttribute('data-index'), 10);
        showDetail(safeId, url, idx);
      }
    });

    // Prefetch description HTML on hover
    contentArea.addEventListener('mouseover', (e) => {
      const row = e.target.closest('.job-row');
      if (!row) return;
      const safeId = row.getAttribute('data-id');
      const url = row.getAttribute('data-url');
      if (safeId && url && !detailCache.has(safeId)) {
        fetch(url)
          .then(r => r.ok ? r.text() : '')
          .then(html => {
            if (!html) return;
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const bodyEl = doc.querySelector('.detail-body') || doc.querySelector('#job-article') || doc.querySelector('article');
            if (bodyEl) detailCache.set(safeId, bodyEl.innerHTML);
          })
          .catch(() => {});
      }
    });
  }

  // 4. Keyboard Arrow Navigation (Up / Down)
  window.addEventListener('keydown', (e) => {
    const modal = document.getElementById('about-modal');
    if (modal && modal.open) return;

    if (e.target && e.target.id === 'search-input') {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    } else if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) {
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      stepSelection(e.key === 'ArrowDown' ? 1 : -1);
    }
  });

  function stepSelection(delta) {
    if (!colData) return;
    const list = currentIndices !== null ? currentIndices : Array.from({ length: colData.t.length }, (_, i) => i);
    if (list.length === 0) return;

    let currentPos = -1;
    if (activeSafeId) {
      const curIdx = colData.i.indexOf(activeSafeId);
      currentPos = list.indexOf(curIdx);
    }

    let nextPos = currentPos + delta;
    if (nextPos < 0) nextPos = 0;
    if (nextPos >= list.length) nextPos = list.length - 1;

    const nextIdx = list[nextPos];
    const safeId = colData.i[nextIdx];
    const url = colData.u[nextIdx];
    showDetail(safeId, url, nextIdx);

    const activeEl = contentArea.querySelector(`.job-row[data-id="${safeId}"]`);
    if (activeEl && scrollArea) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
