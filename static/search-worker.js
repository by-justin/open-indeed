/**
 * WT3 Job Directory Search Worker
 * - Full query syntax parser (field selectors, exclusions, exact phrases, uFuzzy fallback)
 * - Independent UI controls evaluation (type, workplace mode, country, recency)
 * - Off-thread sorting (date, company, title)
 */

importScripts('ufuzzy.min.js');

const uf = new uFuzzy({
  intraMode: 1,
  intraIns: 1,
});

let data = null;
let count = 0;
let haystacks = [];
let titlesLower = [];
let companiesLower = [];
let locationsLower = [];
let modesClean = [];
let typesClean = [];
let sourcesLower = [];
let countriesLower = [];
let citiesLower = [];
let statesLower = [];

// Parse search string into structured criteria
function parseQuery(raw) {
  if (!raw) {
    return { fieldFilters: [], exclusions: [], exactPhrases: [], freeTerms: [] };
  }

  let text = raw.trim();
  const fieldFilters = [];
  const exclusions = [];
  const exactPhrases = [];
  const freeTerms = [];

  // 1. Extract exact phrases in quotes: "machine learning" or -"lead architect"
  text = text.replace(/(?:(-)?)"([^"]+)"/g, (match, isNeg, phrase) => {
    const p = phrase.trim().toLowerCase();
    if (p) {
      if (isNeg) {
        exclusions.push(p);
      } else {
        exactPhrases.push(p);
      }
    }
    return ' ';
  });

  // 2. Extract field selectors: workplace, type, country, state, city, location, geo, posted, source, company, title, req_id, id
  // Zero alias policy: exactly matches canonical keys. Supports both quoted "..." and unquoted values.
  const fieldRegex = /\b(workplace|type|country|state|city|location|geo|posted|source|company|title|req_id|id):(?:"([^"]+)"|(\S+))/gi;
  text = text.replace(fieldRegex, (match, field, quotedVal, unquotedVal) => {
    const canonField = field.toLowerCase();
    const val = (quotedVal !== undefined ? quotedVal : unquotedVal).toLowerCase().trim();
    if (val) {
      fieldFilters.push({ field: canonField, val: val });
    }
    return ' ';
  });

  // 3. Extract negations: -senior, NOT manager
  text = text.replace(/\bNOT\s+(\S+)/gi, (match, term) => {
    const t = term.trim().toLowerCase();
    if (t) exclusions.push(t);
    return ' ';
  });

  text = text.replace(/(?:^|\s)-(\S+)/g, (match, term) => {
    const t = term.trim().toLowerCase();
    if (t) exclusions.push(t);
    return ' ';
  });

  // 4. Remaining tokens are free-text keywords
  const remaining = text.split(/\s+/).filter(Boolean);
  for (const word of remaining) {
    const w = word.trim().toLowerCase();
    if (w && w !== 'and' && w !== 'or') {
      freeTerms.push(w);
    }
  }

  return { fieldFilters, exclusions, exactPhrases, freeTerms };
}

// Convert recency string ('24h', '3d', '7d', '14d', '30d') to cutoff date string YYYY-MM-DD
function getRecencyCutoff(recency) {
  if (!recency || recency === 'all') return null;
  const now = new Date();
  let days = 0;
  if (recency === '24h' || recency === '1d') days = 1;
  else if (recency === '3d') days = 3;
  else if (recency === '7d') days = 7;
  else if (recency === '14d') days = 14;
  else if (recency === '30d') days = 30;
  else {
    const match = recency.match(/^<=?(\d+)([dhwmy]?)$/);
    if (match) {
      const n = parseInt(match[1], 10);
      const unit = match[2] || 'd';
      if (unit === 'h') days = Math.max(1, Math.round(n / 24));
      else if (unit === 'w') days = n * 7;
      else if (unit === 'm') days = n * 30;
      else days = n;
    }
  }
  if (!days) return null;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return cutoff.toISOString().slice(0, 10);
}

self.onmessage = function(e) {
  const msg = e.data;

  if (msg.type === 'init') {
    data = msg.data;
    count = data.t.length;

    haystacks = new Array(count);
    titlesLower = new Array(count);
    companiesLower = new Array(count);
    locationsLower = new Array(count);
    modesClean = new Array(count);
    typesClean = new Array(count);
    sourcesLower = new Array(count);
    countriesLower = new Array(count);
    citiesLower = new Array(count);
    statesLower = new Array(count);

    for (let i = 0; i < count; i++) {
      const c = (data.c[i] || '').toLowerCase();
      const t = (data.t[i] || '').toLowerCase();
      const l = (data.l[i] || '').toLowerCase();
      const fl = (data.fl[i] || '').toLowerCase();
      const m = (data.m[i] || '').toLowerCase().replace(/[-_]/g, '');
      const emp = (data.e && data.e[i] ? data.e[i] : '').toLowerCase();
      const s = (data.so && data.so[i] ? data.so[i] : '').toLowerCase();
      const co = (data.co && data.co[i] ? data.co[i] : '').toLowerCase();
      const ci = (data.ci && data.ci[i] ? data.ci[i] : '').toLowerCase();
      const st = (data.st && data.st[i] ? data.st[i] : '').toLowerCase();

      companiesLower[i] = c;
      titlesLower[i] = t;
      locationsLower[i] = l + ' ' + fl;
      modesClean[i] = m;
      typesClean[i] = emp;
      sourcesLower[i] = s;
      countriesLower[i] = co;
      citiesLower[i] = ci;
      statesLower[i] = st;

      haystacks[i] = c + ' ' + t + ' ' + l + ' ' + fl + ' ' + m + ' ' + emp + ' ' + s + ' ' + co + ' ' + ci + ' ' + st;
    }

    self.postMessage({ type: 'ready', total: count });
    return;
  }

  const action = msg.action || msg.type;
  if (action === 'search') {
    if (!data) return;

    const query = (msg.query || '').trim();
    const wpFilter = (msg.workplace || 'all').toLowerCase();
    const typeFilter = (msg.empType || msg.type || 'all').toLowerCase();
    const countryFilter = msg.country || 'all';
    const recencyFilter = msg.recency || 'all';
    const sort = msg.sort || 'date-desc';
    const queryId = msg.queryId;
    const maxResults = msg.limit || 10000;

    const parsed = parseQuery(query);
    const recencyCutoff = getRecencyCutoff(recencyFilter);

    // If there are free-text terms, use uFuzzy or token filtering to find candidate rows
    let candidateIndices = null;
    if (parsed.freeTerms.length > 0) {
      const needle = parsed.freeTerms.join(' ');
      candidateIndices = uf.filter(haystacks, needle) || [];
    }

    const matched = [];
    const totalToScan = candidateIndices ? candidateIndices.length : count;

    for (let i = 0; i < totalToScan; i++) {
      const idx = candidateIndices ? candidateIndices[i] : i;

      // --- 1. Dedicated UI Controls ---
      // Workplace Filter
      if (wpFilter !== 'all') {
        if (modesClean[idx] !== wpFilter) continue;
      }

      // Employment Type Filter
      if (typeFilter !== 'all') {
        const itemType = typesClean[idx];
        const itemTitle = titlesLower[idx];
        if (typeFilter === 'internship_coop') {
          const isIntern = itemType.includes('coop') || itemType.includes('intern') ||
                           /\b(intern|internship|co-?op|student|stagiaire)\b/i.test(itemTitle);
          if (!isIntern) continue;
        } else if (typeFilter === 'full_time') {
          const isFullTime = itemType.includes('full') || (!itemType.includes('coop') && !itemType.includes('intern') && !/\b(intern|internship|co-?op|student|stagiaire)\b/i.test(itemTitle));
          if (!isFullTime) continue;
        } else if (typeFilter === 'contract') {
          if (!itemType.includes('contract')) continue;
        } else if (typeFilter === 'part_time') {
          if (!itemType.includes('part')) continue;
        }
      }

      // Country Filter
      if (countryFilter !== 'all') {
        const loc = locationsLower[idx];
        const countryVal = (data.co && data.co[idx] ? data.co[idx] : '').toLowerCase();
        if (countryFilter === 'Canada') {
          const isCa = countryVal === 'ca' || countryVal === 'canada' ||
                       /canada|\bca\b|\balberta\b|\bontario\b|\bbc\b|\bquebec\b|\bmanitoba\b|\bsaskatchewan\b|\bnova scotia\b|\bnew brunswick\b|\bwaterloo\b|\btoronto\b|\bvancouver\b|\bmontreal\b|\bottawa\b|\bcalgary\b|\bedmonton\b|\b(ab|bc|on|qc|mb|sk|ns|nb)\b/i.test(loc);
          if (!isCa) continue;
        } else if (countryFilter === 'United States') {
          const isUs = countryVal === 'us' || countryVal === 'usa' ||
                       /united states|\busa\b|\bus\b/i.test(loc);
          if (!isUs) continue;
        } else if (countryFilter === 'other') {
          const isCa = countryVal === 'ca' || countryVal === 'canada' || /canada/i.test(loc);
          const isUs = countryVal === 'us' || countryVal === 'usa' || /united states|\busa\b/i.test(loc);
          if (isCa || isUs) continue;
        }
      }

      // Recency Filter
      if (recencyCutoff) {
        const itemDate = data.d[idx] || '';
        if (!itemDate || itemDate < recencyCutoff) continue;
      }

      // --- 2. In-Input Query Syntax Filters ---
      // Canonical Field Filters: company, title, workplace, type, country, state, city, location, geo, source, posted, id, req_id
      let passFieldFilters = true;
      for (const ff of parsed.fieldFilters) {
        if (ff.field === 'company') {
          if (!companiesLower[idx].includes(ff.val)) { passFieldFilters = false; break; }
        } else if (ff.field === 'title') {
          if (!titlesLower[idx].includes(ff.val)) { passFieldFilters = false; break; }
        } else if (ff.field === 'workplace') {
          let wMatch = false;
          if (ff.val === 'remote') wMatch = modesClean[idx] === 'remote';
          else if (ff.val === 'hybrid') wMatch = modesClean[idx] === 'hybrid';
          else if (ff.val === 'onsite') wMatch = modesClean[idx] === 'onsite';
          else wMatch = modesClean[idx].includes(ff.val);
          if (!wMatch) { passFieldFilters = false; break; }
        } else if (ff.field === 'type') {
          let tMatch = false;
          if (ff.val === 'coop' || ff.val === 'intern' || ff.val === 'internship') {
            tMatch = typesClean[idx].includes('coop') || typesClean[idx].includes('intern') ||
                     /\b(intern|internship|co-?op)\b/i.test(titlesLower[idx]);
          } else {
            tMatch = typesClean[idx].includes(ff.val);
          }
          if (!tMatch) { passFieldFilters = false; break; }
        } else if (ff.field === 'country') {
          const cMatch = countriesLower[idx] === ff.val || locationsLower[idx].includes(ff.val);
          if (!cMatch) { passFieldFilters = false; break; }
        } else if (ff.field === 'state') {
          const sMatch = statesLower[idx].includes(ff.val) || locationsLower[idx].includes(ff.val);
          if (!sMatch) { passFieldFilters = false; break; }
        } else if (ff.field === 'city') {
          const ciMatch = citiesLower[idx].includes(ff.val) || locationsLower[idx].includes(ff.val);
          if (!ciMatch) { passFieldFilters = false; break; }
        } else if (ff.field === 'location' || ff.field === 'geo') {
          if (!locationsLower[idx].includes(ff.val)) { passFieldFilters = false; break; }
        } else if (ff.field === 'source') {
          if (!sourcesLower[idx].includes(ff.val)) { passFieldFilters = false; break; }
        } else if (ff.field === 'posted') {
          const cutoff = getRecencyCutoff(ff.val);
          if (cutoff && (!data.d[idx] || data.d[idx] < cutoff)) { passFieldFilters = false; break; }
        } else if (ff.field === 'id' || ff.field === 'req_id') {
          const idMatch = (data.i[idx] || '').toLowerCase().includes(ff.val) ||
                          (data.a && data.a[idx] && data.a[idx].toLowerCase().includes(ff.val));
          if (!idMatch) { passFieldFilters = false; break; }
        }
      }
      if (!passFieldFilters) continue;

      // Negations / Exclusions: -senior, NOT manager
      let passExclusions = true;
      for (const neg of parsed.exclusions) {
        if (haystacks[idx].includes(neg)) {
          passExclusions = false;
          break;
        }
      }
      if (!passExclusions) continue;

      // Exact Phrases in quotes: "machine learning"
      let passExact = true;
      for (const phrase of parsed.exactPhrases) {
        if (!haystacks[idx].includes(phrase)) {
          passExact = false;
          break;
        }
      }
      if (!passExact) continue;

      matched.push(idx);
    }

    const totalMatched = matched.length;

    // --- 3. Sorting ---
    if (sort === 'company-asc') {
      matched.sort((a, b) => companiesLower[a].localeCompare(companiesLower[b]));
    } else if (sort === 'title-asc') {
      matched.sort((a, b) => titlesLower[a].localeCompare(titlesLower[b]));
    } else if (sort === 'date-asc') {
      matched.sort((a, b) => (data.d[a] || '').localeCompare(data.d[b] || ''));
    } else if (sort === 'date-desc') {
      matched.sort((a, b) => (data.d[b] || '').localeCompare(data.d[a] || ''));
    }

    self.postMessage({
      type: 'results',
      queryId: queryId,
      indices: matched.slice(0, maxResults),
      totalMatched: totalMatched,
    });
  }
};
