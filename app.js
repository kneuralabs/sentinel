// ── CONSTANTS ────────────────────────────────────────────────────────────────
const SK = { TOKEN: 'sentinel_token', META: 'sentinel_meta' };
const SCAN_BATCH = 3;
const LIVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── STATE ────────────────────────────────────────────────────────────────────
let state = { token: null, repos: [], fetchMap: {}, lastSync: null, hasSecurityScope: null };
let liveCheckId = null;

// ── DOM REFS ─────────────────────────────────────────────────────────────────
const tokenInput  = document.getElementById('githubToken');
const connectBtn  = document.getElementById('connectBtn');
const clearBtn    = document.getElementById('clearStorageBtn');
const dashboard   = document.getElementById('dashboardArea');
const initMsg     = document.getElementById('initialMessage');
const grid        = document.getElementById('repoGridContainer');
const repoCountEl = document.getElementById('repoCount');
const changesEl   = document.getElementById('totalChanges');
const vulnsEl     = document.getElementById('totalVulns');
const syncEl      = document.getElementById('lastSyncTime');
const sDot        = document.getElementById('sDot');
const sText       = document.getElementById('sText');

// ── SCAN OVERLAY ─────────────────────────────────────────────────────────────
const overlay  = document.getElementById('scanOverlay');
const terminal = document.getElementById('scanTerminal');
const progBar  = document.getElementById('scanProgBar');

function addLine(msg, cls = '') {
  const prev = terminal.querySelector('.scan-cursor');
  if (prev) prev.remove();

  const lineClass = cls === 'hl' ? 'cmd' : cls === 'ok' ? 'ok' : cls === 'err' ? 'err' : 'out';
  const prefix    = cls === 'hl' ? '$' : cls === 'ok' ? '[ok]' : cls === 'err' ? '[err]' : '›';

  const el = document.createElement('div');
  el.className = `scan-line ${lineClass}`;
  el.innerHTML =
    `<span class="scan-prefix">${prefix}</span>` +
    `<span class="scan-msg">${msg}<span class="scan-cursor"></span></span>`;
  terminal.appendChild(el);

  const all = terminal.querySelectorAll('.scan-line');
  if (all.length > 14) all[0].remove();
}

function setProgress(pct) { progBar.style.width = pct + '%'; }

function showOverlay() {
  terminal.innerHTML = '';
  setProgress(0);
  dashboard.style.display = 'block';
  initMsg.style.display   = 'none';
  overlay.style.opacity   = '1';
  overlay.style.display   = 'flex';
  overlay.classList.remove('exiting');
}

function hideOverlay() {
  return new Promise(res => {
    overlay.classList.add('exiting');
    setTimeout(() => {
      overlay.style.display = 'none';
      overlay.classList.remove('exiting');
      res();
    }, 580);
  });
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// ── TOAST ─────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, isErr = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
}

// ── GITHUB API ────────────────────────────────────────────────────────────────
async function apiFetch(url, token, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      ...(opts.headers || {})
    }
  });
  if (res.status === 403 && res.headers.get('X-RateLimit-Remaining') === '0')
    throw new Error('Rate limit exceeded. Please wait a moment.');
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${txt.slice(0, 120)}`);
  }
  return res;
}

async function getAllRepos(token) {
  let page = 1, all = [], more = true;
  while (more) {
    const res  = await apiFetch(`https://api.github.com/user/repos?per_page=100&page=${page}&sort=full_name`, token);
    const data = await res.json();
    if (!data.length) break;
    all.push(...data);
    more = (res.headers.get('Link') || '').includes('rel="next"');
    page++;
  }
  return all.map(r => ({
    fullName: r.full_name, owner: r.owner.login,
    name: r.name, branch: r.default_branch
  }));
}

// Fetches latest commit date, total commit count, and branch count in parallel.
// Total commits is derived from the Link header last-page trick (no extra API call).
async function getRepoMeta(token, owner, repo, branch) {
  try {
    const [commitRes, branchRes] = await Promise.all([
      apiFetch(`https://api.github.com/repos/${owner}/${repo}/commits?sha=${branch}&per_page=1`, token),
      apiFetch(`https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`, token)
    ]);
    const [commitData, branchData] = await Promise.all([commitRes.json(), branchRes.json()]);

    const link  = commitRes.headers.get('Link') || '';
    const match = link.match(/page=(\d+)>; rel="last"/);
    const totalCommits = match ? parseInt(match[1], 10) : (Array.isArray(commitData) && commitData.length ? 1 : 0);
    const branchCount  = Array.isArray(branchData) ? branchData.length : 0;
    const latestDate   = commitData?.[0]?.commit?.committer?.date || new Date().toISOString();
    const lc = Array.isArray(commitData) ? commitData[0] : null;
    const latestCommit = lc ? {
      sha: lc.sha,
      message: (lc.commit.message || '').split('\n')[0],
      date: lc.commit.author?.date || lc.commit.committer?.date || latestDate,
    } : null;

    return { latestDate, totalCommits, branchCount, latestCommit };
  } catch {
    return { latestDate: new Date().toISOString(), totalCommits: 0, branchCount: 0, latestCommit: null };
  }
}

async function getCommitsSince(token, owner, repo, branch, since) {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits?sha=${branch}&per_page=40&since=${encodeURIComponent(since)}`;
  const res  = await apiFetch(url, token);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  // GitHub's `since` is inclusive, so the previous scan's latest commit comes
  // back again — exclude it so only genuinely new commits are counted.
  return data
    .filter(c => {
      const d = c.commit.author?.date || c.commit.committer?.date;
      return d && d > since;
    })
    .map(c => ({
      sha:     c.sha,
      message: c.commit.message.split('\n')[0],
      author:  c.commit.author?.name || c.author?.login || 'unknown',
      date:    c.commit.author?.date || c.commit.committer?.date,
      url:     c.html_url
    }));
}

async function getVulns(token, owner, repo) {
  try {
    const res  = await apiFetch(`https://api.github.com/repos/${owner}/${repo}/dependabot/alerts?state=open&per_page=50`, token);
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.filter(a =>
      a.state === 'open' && !a.dismissed_at && !a.fixed_at && !a.auto_dismissed_at
    ).map(a => ({
      id:        a.number,
      summary:   a.security_advisory?.summary || 'Unknown vulnerability',
      severity:  a.security_advisory?.severity || 'unknown',
      pkg:       a.security_vulnerability?.package?.name || 'unknown',
      range:     a.security_vulnerability?.vulnerable_version_range || 'unknown',
      fixed:     a.security_vulnerability?.first_patched_version?.identifier || null,
      url:       a.html_url,
      ecosystem: a.security_vulnerability?.package?.ecosystem || ''
    }));
  } catch(err) {
    if (/GitHub API 404/.test(err.message)) return [];
    if (/403|security_events/.test(err.message)) {
      // The token's scope (read from X-OAuth-Scopes) is the source of truth.
      // A 403 on a repo whose token DOES carry the scope just means Dependabot
      // is disabled / has no accessible alerts for that repo → treat as clean.
      return state.hasSecurityScope === false ? { missingScope: true } : [];
    }
    return { error: err.message };
  }
}

// ── REMEDIATION ───────────────────────────────────────────────────────────────
function fixSteps(v) {
  const eco = v.ecosystem?.toLowerCase() || '';
  let cmd;
  if (eco === 'npm' || eco.includes('npm'))
    cmd = `npm update ${v.pkg}\nnpm audit fix\n# Or pin version:\nnpm install ${v.pkg}@${v.fixed || 'latest'}`;
  else if (eco === 'pip' || eco.includes('pip'))
    cmd = `pip install --upgrade ${v.pkg}\n# Or pin:\npip install ${v.pkg}==${v.fixed || 'latest'}`;
  else if (eco.includes('maven'))
    cmd = `Update pom.xml <version> for ${v.pkg} to ${v.fixed || 'latest'}\nmvn versions:use-latest-versions -Dincludes=${v.pkg}`;
  else if (eco.includes('go'))
    cmd = `go get -u ${v.pkg}\ngo mod tidy`;
  else
    cmd = `Upgrade ${v.pkg} to ${v.fixed || 'patched version'} via your package manager`;

  let out = `1. Locate ${v.pkg} in your dependency manifest\n2. Run:\n   ${cmd.replace(/\n/g, '\n   ')}\n3. Run your test suite\n4. Commit and push`;
  if (!v.fixed) out += `\n\n# No patch available yet — check advisory for workarounds`;
  return out;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function tileColor(d) {
  if (d.hasError) return 'red';
  if ((d.vulns || []).length || d.missingScope) return 'amber';
  return 'green';
}

let sortMode = 'sec';
function latestCommitTime(d) {
  const dates = [d.latestCommit && d.latestCommit.date, ...(d.commits || []).map(c => c.date)]
    .filter(Boolean).map(x => new Date(x).getTime());
  return dates.length ? Math.max(...dates) : 0;
}
function sortDetails(details) {
  const rank = { red: 0, amber: 1, green: 2 };
  const arr = [...details];
  switch (sortMode) {
    case 'commits-desc':   arr.sort((a, b) => (b.totalCommits || 0) - (a.totalCommits || 0)); break;
    case 'commits-asc':    arr.sort((a, b) => (a.totalCommits || 0) - (b.totalCommits || 0)); break;
    case 'branches-desc':  arr.sort((a, b) => (b.branchCount || 0) - (a.branchCount || 0)); break;
    case 'branches-asc':   arr.sort((a, b) => (a.branchCount || 0) - (b.branchCount || 0)); break;
    case 'recent':         arr.sort((a, b) => latestCommitTime(b) - latestCommitTime(a)); break;
    case 'alpha':          arr.sort((a, b) => a.fullName.localeCompare(b.fullName)); break;
    default:               arr.sort((a, b) => rank[tileColor(a)] - rank[tileColor(b)]); break;
  }
  return arr;
}

function pluralize(n, word) { return `${n} ${word}${n !== 1 ? 's' : ''}`; }

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function updateStatsAfterScan(totalCommits, totalVuln) {
  changesEl.textContent = totalCommits;
  vulnsEl.textContent   = totalVuln;
  vulnsEl.className     = 'stat-num' + (totalVuln > 0 ? ' danger' : '');
  syncEl.textContent    = fmtTime(new Date().toISOString());
}

function setConnected(n) {
  sDot.classList.add('live');
  sText.textContent = `${n} repos`;
}

// ── STAT DRILL-DOWNS ──────────────────────────────────────────────────────────
// Populates the expandable lists beneath the Repositories / New Commits /
// Open Vulnerabilities stat cells. `details` is the latest scan results (or null
// before a scan has run, in which case only the repository list is available).
function renderStatDrilldowns(details) {
  const repoList   = document.getElementById('repoList');
  const commitList = document.getElementById('commitList');
  const vulnList   = document.getElementById('vulnList');
  if (!repoList) return;

  // Repositories — all names (without owner prefix), comma-separated, always shown.
  repoList.innerHTML = state.repos.length
    ? esc(state.repos.map(r => r.fullName.split('/').pop()).join(', '))
    : '<div class="stat-list-empty">No repositories</div>';

  // New commits — latest 5 across all repos, each tagged with its repo name.
  const commits = [];
  (details || []).forEach(d => (d.commits || []).forEach(c => commits.push({ ...c, repo: d.fullName })));
  commits.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  const top5 = commits.slice(0, 5);

  const fmtDt = d => d
    ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
  const commitItem = (c, tag) => {
    const dt = fmtDt(c.date);
    const sub = [dt, tag].filter(Boolean).join(' · ');
    return `<div class="stat-list-item">
          <span class="sli-main">${esc(c.message)}</span>
          <span class="sli-sub"><span class="sli-repo">${esc(c.repo)}</span>${sub ? ' · ' + esc(sub) : ''}</span>
        </div>`;
  };

  // Most recent commit across all repos. Retained as a footer entry beneath the
  // new-commit list — and shown alone when there are no new commits — so the
  // panel always reflects the last known commit, even after it stops being new.
  const latest = (details || [])
    .map(d => d.latestCommit ? { ...d.latestCommit, repo: d.fullName } : null)
    .filter(Boolean)
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))[0];

  let commitHtml = top5.map(c => commitItem(c)).join('');
  // Append the retained latest commit unless it's already the top of the list.
  if (latest && !top5.some(c => c.sha && c.sha === latest.sha)) {
    commitHtml += commitItem(latest, 'latest');
  }
  commitList.innerHTML = commitHtml || '<div class="stat-list-empty">No new commits</div>';

  // Open vulnerabilities — only repos that actually have open alerts.
  const vulnRepos = (details || [])
    .filter(d => (d.vulns || []).length)
    .map(d => ({ repo: d.fullName, count: d.vulns.length }));
  vulnList.innerHTML = vulnRepos.length
    ? vulnRepos.map(v =>
        `<div class="stat-list-item">
          <span class="sli-main">${esc(v.repo)}</span>
          <span class="sli-sub">${v.count} open vuln${v.count !== 1 ? 's' : ''}</span>
        </div>`).join('')
    : '<div class="stat-list-empty">No open vulnerabilities</div>';
}

// ── SECURITY POSTURE SUMMARY ──────────────────────────────────────────────────
// Aggregates the latest scan results into an at-a-glance overview: the repository
// RAG breakdown (secure / at-risk / error) and total open vulnerabilities grouped
// by severity. Hidden until a scan with results is available.
function vulnWord(n) { return `${n} open ${n === 1 ? 'vulnerability' : 'vulnerabilities'}`; }

function renderPosture(details) {
  const panel = document.getElementById('posturePanel');
  if (!panel) return;
  if (!details || !details.length) { panel.style.display = 'none'; return; }

  const counts = { green: 0, amber: 0, red: 0 };
  const sev = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  let totalVulns = 0;

  details.forEach(d => {
    counts[tileColor(d)]++;
    (d.vulns || []).forEach(v => {
      totalVulns++;
      const s = (v.severity || 'unknown').toLowerCase();
      sev[s in sev ? s : 'unknown']++;
    });
  });

  // Headline verdict — worst state wins.
  const verdict = document.getElementById('postureVerdict');
  if (counts.red) {
    verdict.textContent = `${pluralize(counts.red, 'repo')} need attention`;
    verdict.className = 'posture-verdict pv-red';
  } else if (totalVulns) {
    verdict.textContent = vulnWord(totalVulns);
    verdict.className = 'posture-verdict pv-amber';
  } else if (counts.amber) {
    verdict.textContent = `${pluralize(counts.amber, 'repo')} need review`;
    verdict.className = 'posture-verdict pv-amber';
  } else {
    verdict.textContent = 'All repositories secure';
    verdict.className = 'posture-verdict pv-green';
  }

  // Segmented repository-status bar (proportional to repo counts).
  const seg = (cls, n) => n ? `<span class="pseg pseg-${cls}" style="flex:${n}" title="${n}"></span>` : '';
  document.getElementById('postureBar').innerHTML =
    seg('green', counts.green) + seg('amber', counts.amber) + seg('red', counts.red);

  // Legend with absolute counts.
  const legItem = (cls, label, n) =>
    `<span class="pleg"><span class="pdot pdot-${cls}"></span>${n} ${label}</span>`;
  document.getElementById('postureRepoLegend').innerHTML =
    legItem('green', 'secure', counts.green) +
    legItem('amber', 'at risk', counts.amber) +
    legItem('red', 'error', counts.red);

  // Severity breakdown.
  const sevBox = document.getElementById('postureSev');
  if (!totalVulns) {
    sevBox.innerHTML = '<span class="psev-clean">✓ No open vulnerabilities</span>';
  } else {
    const chip = (k, label) => `<span class="psev psev-${k}"><b>${sev[k]}</b>${label}</span>`;
    sevBox.innerHTML =
      chip('critical', 'critical') + chip('high', 'high') +
      chip('medium', 'medium') + chip('low', 'low') +
      (sev.unknown ? `<span class="psev psev-low"><b>${sev.unknown}</b>other</span>` : '');
  }

  panel.style.display = 'block';
}

// ── LIVE CHECK ────────────────────────────────────────────────────────────────
const livePill   = document.getElementById('livePill');
const liveStatus = document.getElementById('liveStatus');

function startLiveCheck() {
  stopLiveCheck();
  livePill.style.display = 'flex';
  liveStatus.textContent = 'Live';
  liveCheckId = setInterval(async () => {
    if (!state.token || !state.repos.length) return;
    liveStatus.textContent = 'Checking…';
    try {
      const result = await runScan();
      liveStatus.textContent = 'Live';
      syncEl.textContent = fmtTime(new Date().toISOString());
      if (result.totalVuln > 0) {
        toast(`Live scan: ${pluralize(result.totalVuln, 'vulnerability')} found`);
      }
    } catch { liveStatus.textContent = 'Live'; }
  }, LIVE_INTERVAL_MS);
}

function stopLiveCheck() {
  clearInterval(liveCheckId);
  liveCheckId = null;
  livePill.style.display = 'none';
}

// ── SCOPE WARNING ─────────────────────────────────────────────────────────────
function showScopeWarning() {
  const existing = document.getElementById('scopeWarn');
  if (existing) return;
  const el = document.createElement('div');
  el.id = 'scopeWarn';
  el.className = 'scope-warn';
  el.innerHTML = `<strong>Missing scope:</strong> Your token lacks <code>security_events</code> — vulnerability data is unavailable. <a href="https://github.com/settings/tokens" target="_blank" rel="noopener">Update token →</a>`;
  const controls = document.querySelector('.dash-controls');
  controls.parentNode.insertBefore(el, controls);
}

function hideScopeWarning() {
  const el = document.getElementById('scopeWarn');
  if (el) el.remove();
}

// ── SHARED VULN + META BATCH SCAN ────────────────────────────────────────────
// Scans vulns and fetches repo meta (totalCommits, branchCount, latestDate) in parallel.
// Returns results with latestDate so callers can build fetchMap without a separate pass.
async function batchScan(token, repos, onBatchDone) {
  const results = [];
  for (let i = 0; i < repos.length; i += SCAN_BATCH) {
    const batch = repos.slice(i, i + SCAN_BATCH);
    const chunk = await Promise.all(batch.map(async repo => {
      const { fullName, owner, name, branch } = repo;
      let vulns = [], vulnError = null, missingScope = false;

      const [vd, meta] = await Promise.all([
        getVulns(token, owner, name),
        getRepoMeta(token, owner, name, branch)
      ]);

      if (vd?.missingScope)       { missingScope = true; vulnError = 'Missing security_events scope'; }
      else if (vd?.error)         { vulnError = vd.error; }
      else if (Array.isArray(vd)) vulns = vd;

      return {
        fullName, commits: [], vulns, commitError: null, vulnError, missingScope,
        hasError:     !!(vulnError && !missingScope),
        latestDate:   meta.latestDate,
        latestCommit: meta.latestCommit,
        totalCommits: meta.totalCommits,
        branchCount:  meta.branchCount
      };
    }));
    chunk.forEach(r => results.push(r));
    if (onBatchDone) onBatchDone(batch, i);
  }
  return results;
}

// ── RENDER ────────────────────────────────────────────────────────────────────
function renderGrid(details) {
  if (!details.length) {
    grid.innerHTML = `<div class="empty-card" style="border:none; grid-column:1/-1">
      <div class="empty-title">No repositories found</div></div>`;
    return;
  }
  renderStatDrilldowns(details);
  renderPosture(details);
  details = sortDetails(details);
  window._scanDetails = details;

  grid.innerHTML = details.map((d, i) => {
    const repo = state.repos.find(r => r.fullName === d.fullName);
    if (!repo) return '';

    const color   = tileColor(d);
    const vulns   = d.vulns || [];
    const [owner, name] = repo.fullName.includes('/')
      ? repo.fullName.split('/')
      : [repo.fullName, repo.fullName];

    const secLabel = vulns.length
      ? pluralize(vulns.length, 'vuln')
      : d.missingScope
        ? 'no scope'
        : d.hasError
          ? 'error'
          : 'secure';

    return `<div class="repo-tile tile-${color}" onclick="openDetail(${i})">
      <div class="tile-id">
        <div class="tile-owner">${esc(owner)}/</div>
        <div class="tile-repo">${esc(name)}</div>
      </div>
      <div class="tile-metrics">
        <div class="tile-metric">
          <span class="tm-num">${d.totalCommits ?? '—'}</span>
          <span class="tm-lbl">commits</span>
        </div>
        <div class="tile-metric">
          <span class="tm-num">${d.branchCount ?? '—'}</span>
          <span class="tm-lbl">branches</span>
        </div>
        <div class="tile-metric">
          <span class="tm-lbl tm-sec-lbl">${secLabel}</span>
        </div>
      </div>
    </div>`;
  }).join('');

  finalizeMatrix();
}

function finalizeMatrix() {
  // tiles are styled via tile-green/amber/red classes applied in renderGrid
}

function renderBaseline() {
  repoCountEl.textContent = state.repos.length;
  changesEl.textContent   = '0';
  vulnsEl.textContent     = '0';
  vulnsEl.className       = 'stat-num';
  syncEl.textContent      = state.lastSync ? fmtTime(state.lastSync) : '—';
  renderStatDrilldowns(null);
  renderPosture(null);
  grid.innerHTML = `<div class="empty-card" style="border:none; padding:32px 60px; grid-column:1/-1">
    <div class="empty-sub">Click Rescan to detect vulnerabilities across all repositories</div></div>`;
}

// ── CORE SCAN ─────────────────────────────────────────────────────────────────
async function runScan() {
  const token  = state.token;
  const repos  = [...state.repos];
  const oldMap = { ...state.fetchMap };
  const newMap = { ...oldMap };
  const results = [];

  for (let i = 0; i < repos.length; i += SCAN_BATCH) {
    const batch = repos.slice(i, i + SCAN_BATCH);
    const chunk = await Promise.all(batch.map(async repo => {
      const { fullName, owner, name, branch } = repo;
      let commits = [], commitError = null;
      let vulns = [], vulnError = null, missingScope = false;

      const [commitsResult, meta, vd] = await Promise.all([
        oldMap[fullName]
          ? getCommitsSince(token, owner, name, branch, oldMap[fullName]).catch(e => ({ error: e.message }))
          : Promise.resolve([]),
        getRepoMeta(token, owner, name, branch),
        getVulns(token, owner, name)
      ]);

      if (commitsResult?.error) {
        commitError = commitsResult.error;
        newMap[fullName] = oldMap[fullName] || new Date().toISOString();
      } else {
        commits = commitsResult;
        newMap[fullName] = commits.length && commits[0].date ? commits[0].date : meta.latestDate;
      }

      if (vd?.missingScope)       { missingScope = true; vulnError = 'Missing security_events scope'; }
      else if (vd?.error)         { vulnError = vd.error; }
      else if (Array.isArray(vd)) vulns = vd;

      return {
        fullName, commits, vulns, commitError, vulnError, missingScope,
        hasError:     !!(commitError || (vulnError && !missingScope)),
        latestCommit: meta.latestCommit,
        totalCommits: meta.totalCommits,
        branchCount:  meta.branchCount
      };
    }));
    chunk.forEach(r => results.push(r));
  }

  state.fetchMap = newMap;
  state.lastSync = new Date().toISOString();
  persist();

  const totalCommits = results.reduce((a, r) => a + r.commits.length, 0);
  const totalVuln    = results.reduce((a, r) => a + r.vulns.length, 0);

  updateStatsAfterScan(totalCommits, totalVuln);
  renderGrid(results);
  return { totalVuln, totalCommits, results };
}

// ── FULL INIT + ANIMATED SCAN ─────────────────────────────────────────────────
async function fullInit(token) {
  showOverlay();
  try {
    await wait(180); addLine('Initializing Sentinel', 'hl');
    await wait(260); addLine('Connecting to GitHub API…'); setProgress(5);
    await wait(350); addLine(`Authenticating token ${token.slice(0, 8)}…`, 'hl');

    let repos, tokenScopes = [];
    try {
      const authRes = await apiFetch('https://api.github.com/user', token);
      tokenScopes = (authRes.headers.get('X-OAuth-Scopes') || '').split(',').map(s => s.trim()).filter(Boolean);
      repos = await getAllRepos(token);
    }
    catch(err) {
      addLine('Authentication failed — ' + err.message, 'err');
      await wait(1600); await hideOverlay();
      toast(err.message, true); return;
    }

    const hasSecScope = tokenScopes.includes('security_events') || tokenScopes.includes('repo');
    state.hasSecurityScope = hasSecScope;

    if (!repos.length) {
      addLine('No repositories found', 'err');
      await wait(1200); await hideOverlay();
      toast('No repositories found', true); return;
    }

    addLine(`Token verified — ${repos.length} repositories found`, 'ok'); setProgress(18);
    await wait(180);
    addLine('Scanning repositories…', 'hl'); setProgress(22);

    const results = await batchScan(token, repos, (batch, i) => {
      batch.forEach(r => addLine(`Scan   ${r.fullName}`));
      setProgress(22 + Math.round(((i + SCAN_BATCH) / repos.length) * 74));
      return wait(60);
    });

    const dateMap = {};
    results.forEach(r => { dateMap[r.fullName] = r.latestDate; });

    state.repos    = repos;
    state.fetchMap = dateMap;
    state.token    = token;
    state.lastSync = new Date().toISOString();
    persist();

    renderBaseline();
    repoCountEl.textContent = repos.length;
    setConnected(repos.length);

    const totalVuln = results.reduce((a, r) => a + r.vulns.length, 0);
    setProgress(100);
    await wait(220);
    addLine(
      totalVuln > 0
        ? `Scan complete — ${pluralize(totalVuln, 'vulnerability')} found`
        : `Scan complete — no vulnerabilities detected`,
      totalVuln > 0 ? 'hl' : 'ok'
    );
    await wait(900);
    await hideOverlay();

    updateStatsAfterScan(0, totalVuln);
    renderGrid(results);

    toast(totalVuln > 0
      ? `${pluralize(totalVuln, 'vulnerability')} found — remediation plans embedded below`
      : 'Scan complete — all repositories are secure');

    if (!hasSecScope) showScopeWarning(); else hideScopeWarning();
    startLiveCheck();

  } catch(err) {
    addLine('Unexpected error: ' + err.message, 'err');
    await wait(1600); await hideOverlay();
    toast(err.message, true);
  }
}

// ── RESCAN ────────────────────────────────────────────────────────────────────
document.getElementById('sortSelect').addEventListener('change', e => {
  sortMode = e.target.value;
  if (window._scanDetails) renderGrid(window._scanDetails);
});

document.getElementById('manualRefreshBtn').addEventListener('click', async () => {
  if (!state.token || !state.repos.length) { toast('Connect first', true); return; }
  showOverlay();
  addLine('Initiating rescan', 'hl');
  await wait(200);
  addLine(`Loading ${state.repos.length} repositories from cache`); setProgress(8);
  await wait(240);
  addLine('Scanning for new commits and vulnerabilities…', 'hl'); setProgress(14);
  await wait(200);

  const result = await runScan();
  setProgress(100);
  await wait(200);
  addLine(
    result.totalVuln > 0
      ? `Rescan complete — ${pluralize(result.totalVuln, 'vulnerability')} found`
      : `Rescan complete — no vulnerabilities detected`,
    result.totalVuln > 0 ? 'hl' : 'ok'
  );
  await wait(820);
  await hideOverlay();
  finalizeMatrix();
  toast(result.totalVuln > 0 ? `${pluralize(result.totalVuln, 'vulnerability')} found` : 'All clear');
});

// ── PERSIST & RESTORE ─────────────────────────────────────────────────────────
function persist() {
  if (state.token) localStorage.setItem(SK.TOKEN, state.token);
  localStorage.setItem(SK.META, JSON.stringify({
    repos: state.repos, fetchMap: state.fetchMap, lastSync: state.lastSync,
    hasSecurityScope: state.hasSecurityScope
  }));
}

function restore() {
  const tok  = localStorage.getItem(SK.TOKEN);
  const meta = localStorage.getItem(SK.META);
  if (!tok || !meta) return false;
  try {
    const p = JSON.parse(meta);
    state = { token: tok, repos: p.repos || [], fetchMap: p.fetchMap || {}, lastSync: p.lastSync || null, hasSecurityScope: p.hasSecurityScope ?? null };
    tokenInput.value = tok;
    if (!state.repos.length) return false;

    dashboard.style.display = 'block';
    initMsg.style.display   = 'none';
    renderBaseline();
    setConnected(state.repos.length);

    setTimeout(async () => {
      showOverlay();
      addLine('Resuming session', 'hl');
      await wait(200);
      addLine(`Loaded ${state.repos.length} repositories from cache`); setProgress(12);
      await wait(280);
      addLine('Refreshing vulnerability scan…', 'hl'); setProgress(18);
      await wait(200);
      const result = await runScan();
      setProgress(100);
      await wait(180);
      addLine(
        result.totalVuln > 0
          ? `${pluralize(result.totalVuln, 'vulnerability')} detected`
          : 'No vulnerabilities detected',
        result.totalVuln > 0 ? 'hl' : 'ok'
      );
      await wait(780);
      await hideOverlay();
      finalizeMatrix();
      if (state.hasSecurityScope === false) showScopeWarning();
      startLiveCheck();
    }, 400);
    return true;
  } catch { return false; }
}

// ── EVENTS ────────────────────────────────────────────────────────────────────
connectBtn.addEventListener('click', async () => {
  const tok = tokenInput.value.trim();
  if (!tok) { toast('Enter a GitHub personal access token', true); return; }
  await fullInit(tok);
});

tokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') connectBtn.click(); });

clearBtn.addEventListener('click', () => {
  localStorage.removeItem(SK.TOKEN);
  localStorage.removeItem(SK.META);
  state = { token: null, repos: [], fetchMap: {}, lastSync: null, hasSecurityScope: null };
  tokenInput.value = '';
  dashboard.style.display = 'none';
  initMsg.style.display   = 'block';
  initMsg.innerHTML = `<div class="empty-title">Session cleared</div><div class="empty-sub">Enter a new token to reconnect</div>`;
  sDot.classList.remove('live');
  sText.textContent = 'Not connected';
  stopLiveCheck();
  hideScopeWarning();
  toast('Session cleared');
});

// ── BOOT ──────────────────────────────────────────────────────────────────────
if (!restore()) {
  dashboard.style.display = 'none';
  initMsg.style.display   = 'block';
}

// ── THEME TOGGLE ──────────────────────────────────────────────────────────────
const ICON_MOON = '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M10.5 8.5a5.5 5.5 0 1 1-6-6 4 4 0 0 0 6 6z"/></svg>';
const ICON_SUN  = '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="6.5" cy="6.5" r="2"/><line x1="6.5" y1="1" x2="6.5" y2="2.5"/><line x1="6.5" y1="10.5" x2="6.5" y2="12"/><line x1="1" y1="6.5" x2="2.5" y2="6.5"/><line x1="10.5" y1="6.5" x2="12" y2="6.5"/><line x1="2.8" y1="2.8" x2="3.8" y2="3.8"/><line x1="9.2" y1="9.2" x2="10.2" y2="10.2"/><line x1="10.2" y1="2.8" x2="9.2" y2="3.8"/><line x1="3.8" y1="9.2" x2="2.8" y2="10.2"/></svg>';

let activeTheme = localStorage.getItem('sentinel_theme') || 'light';
const themeBtn  = document.getElementById('themeBtn');

function applyTheme(t) {
  activeTheme = t;
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('sentinel_theme', t);
  if (themeBtn) themeBtn.innerHTML = t === 'dark' ? ICON_SUN : ICON_MOON;
}
applyTheme(activeTheme);
themeBtn.addEventListener('click', () => applyTheme(activeTheme === 'dark' ? 'light' : 'dark'));

// ── ACCESS POPOVER ────────────────────────────────────────────────────────────
const accessDotBtn  = document.getElementById('accessDotBtn');
const accessPopover = document.getElementById('accessPopover');
const accessGlyph   = document.getElementById('accessGlyph');

function syncGlyph() {
  accessGlyph.classList.toggle('live', !!(state.token && state.repos.length));
}

accessDotBtn.addEventListener('click', e => {
  e.stopPropagation();
  const opening = !accessPopover.classList.contains('open');
  accessPopover.classList.toggle('open', opening);
  accessDotBtn.classList.toggle('open', opening);
  if (opening) tokenInput.focus();
});

document.addEventListener('click', e => {
  if (!accessPopover.contains(e.target) && e.target !== accessDotBtn) {
    accessPopover.classList.remove('open');
    accessDotBtn.classList.remove('open');
  }
});

connectBtn.addEventListener('click', () => {
  setTimeout(() => {
    accessPopover.classList.remove('open');
    accessDotBtn.classList.remove('open');
    syncGlyph();
  }, 500);
});
clearBtn.addEventListener('click', () => setTimeout(syncGlyph, 50));
setTimeout(syncGlyph, 800);

// ── DETAIL MODAL ─────────────────────────────────────────────────────────────
const SEV_CLASS = { critical: 'sev-critical', high: 'sev-high', medium: 'sev-medium', low: 'sev-low' };

function buildCommitsHtml(commits) {
  if (!commits.length) return '<div class="detail-empty">No commits found</div>';
  return commits.map(ci => {
    const dt = ci.date
      ? new Date(ci.date).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';
    return `<div class="detail-commit">
      <div class="commit-txt">${esc(ci.message)}</div>
      <div class="commit-meta">
        <span>${esc(ci.author)}</span>
        ${dt ? `<span>${esc(dt)}</span>` : ''}
        <a href="${esc(ci.url)}" target="_blank" rel="noopener">view →</a>
      </div>
    </div>`;
  }).join('');
}

function buildVulnsHtml(vulns, missingScope, vulnError) {
  if (missingScope)
    return `<div class="scope-warn" style="margin:0">
      <div>
        <strong>Token missing <code>security_events</code> scope</strong> — Dependabot alerts are not accessible.<br>
        <span style="font-size:11px;opacity:0.8">Create a new token with the <code>security_events</code> scope (or use <code>repo</code> which includes it).</span>
      </div>
      <a href="https://github.com/settings/tokens" target="_blank" rel="noopener" style="white-space:nowrap">Update token →</a>
    </div>`;
  if (vulnError)
    return `<div class="detail-err">${esc(vulnError)}</div>`;
  if (!vulns.length)
    return '<div class="detail-empty" style="color:var(--green);font-weight:500">✓ No open vulnerabilities detected</div>';

  return vulns.map(v => {
    const sc = SEV_CLASS[v.severity] || 'sev-low';
    const steps = fixSteps(v);
    return `<div class="detail-vuln">
      <div class="vuln-top">
        <span class="vuln-pkg">${esc(v.pkg)}</span>
        <span class="sev ${sc}">${esc(v.severity)}</span>
        ${v.ecosystem ? `<span class="tm-lbl" style="font-size:10px">${esc(v.ecosystem)}</span>` : ''}
      </div>
      <div class="vuln-summary">${esc(v.summary)}</div>
      <div class="vuln-range">Affected: <code>${esc(v.range)}</code>${v.fixed ? ` → Fix: <strong>${esc(v.fixed)}</strong>` : ' <em style="color:var(--red)">(no patch available yet)</em>'}</div>
      <div class="remed-box">
        <div class="remed-title">Remediation Steps</div>
        <div class="remed-steps">${esc(steps)}</div>
      </div>
      <a class="remed-link" href="${esc(v.url)}" target="_blank" rel="noopener">View full advisory on GitHub →</a>
    </div>`;
  }).join('');
}

window.openDetail = async function(idx) {
  const details = window._scanDetails;
  if (!details || !details[idx]) return;
  const d    = details[idx];
  const repo = state.repos.find(r => r.fullName === d.fullName);
  if (!repo) return;

  const panel = document.getElementById('detailPanel');
  document.getElementById('detailRepoNm').textContent    = repo.fullName;
  document.getElementById('detailCommitsBody').innerHTML = '<div class="detail-empty"><span class="spinner"></span> Loading commits…</div>';
  document.getElementById('detailVulnsBody').innerHTML   = '<div class="detail-empty"><span class="spinner"></span> Loading vulnerabilities…</div>';
  panel.className = 'detail-panel rag-' + tileColor(d);
  document.getElementById('detailOverlay').classList.add('open');
  panel.classList.add('open');
  document.body.style.overflow = 'hidden';

  // Fetch fresh commits and fresh vulns in parallel (avoids stale cached scope errors)
  const [commitsResult, freshVd] = await Promise.all([
    apiFetch(
      `https://api.github.com/repos/${repo.owner}/${repo.name}/commits?sha=${repo.branch}&per_page=30`,
      state.token
    ).then(r => r.json()).catch(e => ({ error: e.message })),
    getVulns(state.token, repo.owner, repo.name)
  ]);

  // Commits
  if (commitsResult?.error) {
    document.getElementById('detailCommitsBody').innerHTML = `<div class="detail-err">${esc(commitsResult.error)}</div>`;
  } else {
    const commits = Array.isArray(commitsResult) ? commitsResult.map(c => ({
      sha:     c.sha,
      message: c.commit.message.split('\n')[0],
      author:  c.commit.author?.name || c.author?.login || 'unknown',
      date:    c.commit.author?.date || c.commit.committer?.date,
      url:     c.html_url
    })) : [];
    document.getElementById('detailCommitsBody').innerHTML = buildCommitsHtml(commits);
  }

  // Vulns — always fresh, never from stale cache
  let vulns = [], missingScope = false, vulnError = null;
  if (freshVd?.missingScope)       { missingScope = true; }
  else if (freshVd?.error)         { vulnError = freshVd.error; }
  else if (Array.isArray(freshVd)) { vulns = freshVd; }

  // Update panel RAG color based on fresh vuln data
  const freshColor = missingScope || vulns.length ? 'amber' : vulnError ? 'red' : 'green';
  panel.className = 'detail-panel open rag-' + freshColor;
  document.getElementById('detailVulnsBody').innerHTML = buildVulnsHtml(vulns, missingScope, vulnError);
};

window.closeDetail = function() {
  document.getElementById('detailOverlay').classList.remove('open');
  const panel = document.getElementById('detailPanel');
  panel.classList.remove('open');
  document.body.style.overflow = '';
};

// ── MATRIX ANIMATION ─────────────────────────────────────────────────────────
const MTX_PAL = [
  [24,  67, 184],
  [24, 111,  61],
  [184,  37,  24],
  [154,  82,   0],
  [109,  63, 160],
  [ 10, 117, 104],
  [192,  90,   0],
  [ 43, 108, 176],
];
const MTX_CHARS = '01ABCDEF<>/|@#$%*!=?01';
let mtxActive = false;
let mtxCvs    = [];

function stopMatrix() { mtxActive = false; mtxCvs = []; }

function startMatrix() {
  stopMatrix();
  document.querySelectorAll('.tile-canvas').forEach((cv, i) => {
    const fz  = 9;
    cv.width  = cv.offsetWidth  || cv.parentElement?.offsetWidth  || 160;
    cv.height = cv.offsetHeight || cv.parentElement?.offsetHeight || 160;
    if (!cv.width || !cv.height) return;
    const cols  = Math.max(1, Math.floor(cv.width / fz));
    const drops = Array.from({ length: cols }, () => Math.random() * -(cv.height / fz) * 1.5);
    const ctx   = cv.getContext('2d');
    const rgb   = MTX_PAL[i % MTX_PAL.length];
    const dark  = document.documentElement.getAttribute('data-theme') === 'dark';
    ctx.fillStyle = dark ? '#161614' : '#fafaf8';
    ctx.fillRect(0, 0, cv.width, cv.height);
    mtxCvs.push({ cv, ctx, drops, rgb, fz });
  });
  if (!mtxCvs.length) return;
  mtxActive = true;
  (function loop() {
    if (!mtxActive) return;
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    mtxCvs.forEach(({ cv, ctx, drops, rgb, fz }) => {
      if (!cv.isConnected) return;
      ctx.fillStyle = dark ? 'rgba(22,22,20,0.17)' : 'rgba(250,250,248,0.17)';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.font = fz + 'px "JetBrains Mono",monospace';
      const [r, g, b] = rgb;
      for (let i = 0; i < drops.length; i++) {
        const x = i * fz, y = Math.floor(drops[i]) * fz;
        ctx.fillStyle = `rgba(${r},${g},${b},0.78)`;
        ctx.fillText(MTX_CHARS[Math.floor(Math.random() * MTX_CHARS.length)], x, y);
        ctx.fillStyle = `rgba(${r},${g},${b},0.28)`;
        ctx.fillText(MTX_CHARS[Math.floor(Math.random() * MTX_CHARS.length)], x, y - fz);
        ctx.fillStyle = `rgba(${r},${g},${b},0.10)`;
        ctx.fillText(MTX_CHARS[Math.floor(Math.random() * MTX_CHARS.length)], x, y - fz * 2);
        drops[i] += 0.28;
        if (drops[i] * fz > cv.height + fz * 3 && Math.random() > 0.965) {
          drops[i] = Math.random() * -18;
        }
      }
    });
    requestAnimationFrame(loop);
  })();
}
