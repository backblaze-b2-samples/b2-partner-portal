import { api, esc, hasPermission } from './app.js';

// ── State ──────────────────────────────────────────────────────────────────

const rs = {
  startDate:       '',
  endDate:         '',
  groupBy:         localStorage.getItem('rpt_groupBy') || 'day',
  selectedMetric:  'stored_gb',
  bucketFilter:    '',
  locationFilter:  '',
  accountIdFilter: '',
  groupIdFilter:   localStorage.getItem('rpt_groupIdFilter') || '',
  chartType:       'line',
  viewMode:        'total',   // 'total' | 'bucket' | 'group'
  tableOpen:       false,
  data:            null,
  trendChart:      null,
  bucketChart:     null,
  // Cost view
  costMode:        false,
  pricePerTb:      parseFloat(localStorage.getItem('rpt_pricePerTb') || '0') || 0,
  pricingConfigs:  [],
};

const GB_METRICS = new Set(['stored_gb', 'downloaded_gb', 'uploaded_gb', 'deleted_gb']);

function isCostMode()        { return rs.costMode && (rs.pricePerTb > 0 || rs.pricingConfigs.length > 0); }
function isGbCostMode()      { return isCostMode() && GB_METRICS.has(rs.selectedMetric); }
function toCost(gbVal)       { return (gbVal ?? 0) / 1024 * rs.pricePerTb; }
function rateForGroup(groupId) {
  const c = rs.pricingConfigs.find(c => c.group_id === groupId);
  return c ? c.price_per_tb : rs.pricePerTb;
}
function toCostForGroup(gbVal, groupId) { return (gbVal ?? 0) / 1024 * rateForGroup(groupId); }
function fmtCost(v) {
  if (v == null || isNaN(v)) return '$–';
  if (v >= 1e6)  return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1000) return '$' + (v / 1000).toFixed(2) + 'K';
  if (v >= 10)   return '$' + v.toFixed(2);
  return '$' + v.toFixed(4);
}

// ── Constants ──────────────────────────────────────────────────────────────

const DISPLAY_METRICS = [
  'stored_gb', 'downloaded_gb', 'uploaded_gb', 'deleted_gb',
  'api_txn_class_b', 'api_txn_class_c',
];

const CHART_COLORS = [
  '#4f6ef7', '#34d399', '#fbbf24', '#f87171',
  '#a78bfa', '#fb923c', '#38bdf8', '#4ade80',
  '#f472b6', '#facc15', '#818cf8', '#2dd4bf',
];

const CHART_DEFAULTS = {
  plugins: {
    legend: { labels: { color: '#e2e4f0', boxWidth: 12, padding: 16 } },
  },
  scales: {
    x: { ticks: { color: '#7b7f9e' }, grid: { color: '#2e3147' } },
    y: {
      ticks: { color: '#7b7f9e' },
      grid: { color: '#2e3147' },
      beginAtZero: true,
    },
  },
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 300 },
};

// ── Formatters ─────────────────────────────────────────────────────────────

function fmtGb(gb) {
  if (gb == null || isNaN(gb)) return '–';
  if (gb >= 1000) return (gb / 1000).toFixed(2) + ' TB';
  return gb.toFixed(2) + ' GB';
}

function fmtNum(n) {
  if (n == null || isNaN(n)) return '–';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString();
}

function fmtBytes(b) {
  if (b == null || isNaN(b)) return '–';
  if (b >= 1e12) return (b / 1e12).toFixed(2) + ' TB';
  if (b >= 1e9)  return (b / 1e9).toFixed(2)  + ' GB';
  if (b >= 1e6)  return (b / 1e6).toFixed(2)  + ' MB';
  if (b >= 1e3)  return (b / 1e3).toFixed(2)  + ' KB';
  return b + ' B';
}

function fmtMetricValue(val, metric) {
  if (val == null || isNaN(val)) return '–';
  if (metric === 'stored_gb' || metric === 'downloaded_gb' ||
      metric === 'uploaded_gb' || metric === 'deleted_gb') {
    return fmtGb(val);
  }
  if (metric === 'downloaded_bytes' || metric === 'downloaded_favored_bytes') {
    return fmtBytes(val);
  }
  if (metric === 'storage_byte_hours') {
    return fmtBytes(val) + '-hrs';
  }
  return fmtNum(val);
}

// ── Date helpers ───────────────────────────────────────────────────────────

function toIso(d) { return d.toISOString().slice(0, 10); }

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
}

function datePreset(days) {
  const end = yesterday();
  const start = new Date(end);
  start.setDate(end.getDate() - (days - 1));
  return { start: toIso(start), end: toIso(end) };
}

function presetMTD() {
  const end = yesterday();
  return { start: toIso(new Date(end.getFullYear(), end.getMonth(), 1)), end: toIso(end) };
}

function presetLastMonth() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last  = new Date(now.getFullYear(), now.getMonth(), 0);
  return { start: toIso(first), end: toIso(last) };
}

function initDates() {
  const saved = localStorage.getItem('rpt_range');
  if (saved) {
    try {
      const { start, end } = JSON.parse(saved);
      rs.startDate = start;
      rs.endDate   = end;
      return;
    } catch (_) { /* fall through */ }
  }
  const p = datePreset(30);
  rs.startDate = p.start;
  rs.endDate   = p.end;
}

function saveDates() {
  localStorage.setItem('rpt_range', JSON.stringify({ start: rs.startDate, end: rs.endDate }));
  localStorage.setItem('rpt_groupBy', rs.groupBy);
}

// ── Main render ────────────────────────────────────────────────────────────

export async function renderReports(page) {
  initDates();

  // Pick up account_id from hash e.g. #reports?account_id=abc123
  const params = new URLSearchParams(location.hash.includes('?') ? location.hash.split('?')[1] : '');
  const accountFromHash = params.get('account_id');
  if (accountFromHash) rs.accountIdFilter = accountFromHash;

  // Load saved pricing configs (best-effort — non-blocking)
  const pricingRes = await api('/api/pricing').catch(() => null);
  if (pricingRes?.ok) rs.pricingConfigs = await pricingRes.json();

  page.innerHTML = buildShell();
  attachControls(page);

  loadData(page);
}

function buildShell() {
  return `
    <div class="page-header flex-between">
      <div>
        <h1>Usage Reports</h1>
        <p class="page-subtitle">Analytics across your cached B2 usage data</p>
      </div>
      <button class="btn btn-sm" id="export-btn">&#8595; Export CSV</button>
    </div>

    <div class="card" id="controls-card">
      <div class="preset-btns" id="preset-btns">
        <button class="preset-btn" data-preset="7">7d</button>
        <button class="preset-btn" data-preset="14">14d</button>
        <button class="preset-btn" data-preset="30">30d</button>
        <button class="preset-btn" data-preset="90">90d</button>
        <button class="preset-btn" data-preset="mtd">MTD</button>
        <button class="preset-btn" data-preset="last">Last Month</button>
      </div>
      <div class="flex-gap" style="flex-wrap:wrap;gap:12px">
        <div>
          <label class="form-label">Start Date</label>
          <input type="date" id="rpt-start" class="form-input" style="width:150px" value="${esc(rs.startDate)}">
        </div>
        <div>
          <label class="form-label">End Date</label>
          <input type="date" id="rpt-end" class="form-input" style="width:150px" value="${esc(rs.endDate)}">
        </div>
        <div>
          <label class="form-label">Group By</label>
          <div class="btn-group" id="groupby-btns">
            <button class="btn btn-sm${rs.groupBy === 'day'   ? ' active' : ''}" data-group="day">Day</button>
            <button class="btn btn-sm${rs.groupBy === 'week'  ? ' active' : ''}" data-group="week">Week</button>
            <button class="btn btn-sm${rs.groupBy === 'month' ? ' active' : ''}" data-group="month">Month</button>
          </div>
        </div>
        <div>
          <label class="form-label">Group</label>
          <select id="rpt-group-id" class="form-select" style="min-width:150px">
            <option value="">All groups</option>
            ${rs.pricingConfigs.map(c =>
              `<option value="${esc(c.group_id)}"${rs.groupIdFilter === c.group_id ? ' selected' : ''}>${esc(c.group_label || c.group_id)}</option>`
            ).join('')}
          </select>
        </div>
        <div>
          <label class="form-label">Account</label>
          <input id="rpt-account-id" class="form-input" style="width:180px"
            placeholder="Filter by member…" value="${esc(rs.accountIdFilter)}"
            list="rpt-account-datalist" autocomplete="off" spellcheck="false">
          <datalist id="rpt-account-datalist"></datalist>
        </div>
        <div style="align-self:flex-end">
          <button class="btn btn-primary" id="load-btn">Load Reports</button>
        </div>
      </div>
      <div style="border-top:1px solid var(--border);padding-top:12px;margin-top:4px">
        <div class="flex-gap" style="flex-wrap:wrap;align-items:flex-end;gap:12px">
          <div>
            <label class="form-label">Pricing Rate</label>
            <select id="rpt-rate-select" class="form-select" style="min-width:170px">
              <option value="">— Saved rates —</option>
              ${rs.pricingConfigs.map(c =>
                `<option value="${c.price_per_tb}">${esc(c.group_label || c.group_id)} — $${c.price_per_tb}/TB</option>`
              ).join('')}
            </select>
          </div>
          <div>
            <label class="form-label">$/TB</label>
            <input type="number" id="rpt-price-tb" class="form-input" style="width:100px"
              placeholder="0.000" min="0" step="0.001"
              value="${rs.pricePerTb > 0 ? rs.pricePerTb : ''}">
          </div>
          <div style="align-self:flex-end">
            <button class="btn${rs.costMode ? ' btn-primary' : ''}" id="cost-mode-btn">💰 Cost View</button>
          </div>
          ${hasPermission('settings:write') ? `
          <div style="align-self:flex-end">
            <button class="btn btn-sm" id="manage-rates-btn">Manage Rates</button>
          </div>` : ''}
        </div>
      </div>
    </div>

    <div id="rpt-body"></div>
  `;
}

function attachControls(page) {
  // Preset buttons
  page.querySelector('#preset-btns').addEventListener('click', e => {
    const btn = e.target.closest('.preset-btn');
    if (!btn) return;
    const preset = btn.dataset.preset;
    let p;
    if (preset === 'mtd')  p = presetMTD();
    else if (preset === 'last') p = presetLastMonth();
    else p = datePreset(parseInt(preset));
    rs.startDate = p.start;
    rs.endDate   = p.end;
    page.querySelector('#rpt-start').value = p.start;
    page.querySelector('#rpt-end').value   = p.end;
    updatePresetHighlight(page, preset);
  });

  // Group-by buttons
  page.querySelector('#groupby-btns').addEventListener('click', e => {
    const btn = e.target.closest('[data-group]');
    if (!btn) return;
    rs.groupBy = btn.dataset.group;
    page.querySelectorAll('#groupby-btns .btn').forEach(b => b.classList.toggle('active', b.dataset.group === rs.groupBy));
  });

  // Date inputs
  page.querySelector('#rpt-start').addEventListener('change', e => { rs.startDate = e.target.value; });
  page.querySelector('#rpt-end').addEventListener('change',   e => { rs.endDate   = e.target.value; });
  page.querySelector('#rpt-account-id').addEventListener('change', e => { rs.accountIdFilter = e.target.value.trim(); });
  page.querySelector('#rpt-account-id').addEventListener('keydown', e => { if (e.key === 'Enter') loadData(page); });
  page.querySelector('#rpt-group-id').addEventListener('change', e => {
    rs.groupIdFilter = e.target.value;
    localStorage.setItem('rpt_groupIdFilter', rs.groupIdFilter);
  });

  // Load button
  page.querySelector('#load-btn').addEventListener('click', () => loadData(page));

  // Export button
  page.querySelector('#export-btn').addEventListener('click', () => exportCsv());

  // Pricing rate dropdown — auto-fills the $/TB input
  page.querySelector('#rpt-rate-select').addEventListener('change', e => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v)) {
      rs.pricePerTb = v;
      page.querySelector('#rpt-price-tb').value = v;
      localStorage.setItem('rpt_pricePerTb', v);
    }
  });

  // Manual $/TB input
  page.querySelector('#rpt-price-tb').addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    rs.pricePerTb = isNaN(v) || v < 0 ? 0 : v;
    localStorage.setItem('rpt_pricePerTb', rs.pricePerTb);
    page.querySelector('#rpt-rate-select').value = '';
  });

  // Cost mode toggle
  page.querySelector('#cost-mode-btn').addEventListener('click', () => {
    rs.costMode = !rs.costMode;
    page.querySelector('#cost-mode-btn').classList.toggle('btn-primary', rs.costMode);
    if (rs.data) renderAnalytics(page.querySelector('#rpt-body'));
  });

  // Manage rates modal (admin only)
  page.querySelector('#manage-rates-btn')?.addEventListener('click', () => showManageRatesModal(page));
}

function updatePresetHighlight(page, active) {
  page.querySelectorAll('.preset-btn').forEach(b => b.classList.toggle('active', b.dataset.preset === active));
}

// ── Data loading ───────────────────────────────────────────────────────────

async function loadData(page) {
  if (!rs.startDate || !rs.endDate) return;
  saveDates();

  const body = page.querySelector('#rpt-body');
  body.innerHTML = '<div class="empty-state"><div class="spinner"></div><p style="margin-top:12px">Loading usage data…</p></div>';

  // Always request all display metrics + api totals
  const metricList = [...DISPLAY_METRICS, 'api_txn_class_a'].join(',');
  const params = new URLSearchParams({
    start_date: rs.startDate,
    end_date:   rs.endDate,
    group_by:   rs.groupBy,
    metrics:    metricList,
  });
  if (rs.bucketFilter)    params.set('bucket',     rs.bucketFilter);
  if (rs.locationFilter)  params.set('location',   rs.locationFilter);
  if (rs.accountIdFilter) params.set('account_id', rs.accountIdFilter);
  if (rs.groupIdFilter)   params.set('group_id',   rs.groupIdFilter);

  const res = await api(`/api/reports/aggregate?${params}`);
  if (!res?.ok) {
    body.innerHTML = '<div class="alert alert-error">Failed to load report data.</div>';
    return;
  }

  rs.data = await res.json();

  // Populate account datalist with id + email for typeahead
  const datalist = page.querySelector('#rpt-account-datalist');
  if (datalist && rs.data.account_emails) {
    datalist.innerHTML = (rs.data.accounts || []).map(aid => {
      const email = rs.data.account_emails[aid] || '';
      return `<option value="${esc(aid)}">${esc(aid)}${email ? ' — ' + esc(email) : ''}</option>`;
    }).join('');
  }

  // Rebuild group filter dropdown with labels from data + pricing configs
  const groupSel = page.querySelector('#rpt-group-id');
  if (groupSel && rs.data.groups?.length) {
    const prevVal = groupSel.value;
    while (groupSel.options.length > 1) groupSel.remove(1);
    rs.data.groups.forEach(gid => {
      const cfg = rs.pricingConfigs.find(c => c.group_id === gid);
      const opt = document.createElement('option');
      opt.value = gid;
      opt.textContent = cfg ? `${cfg.group_label || gid} (${gid})` : gid;
      groupSel.appendChild(opt);
    });
    groupSel.value = prevVal || rs.groupIdFilter || '';
  }

  if (!rs.data.periods.length) {
    body.innerHTML = `
      <div class="alert alert-warning">No cached data found for this date range.
        ${rs.data.missing_dates.length ? renderFetchMissingBtn(rs.data) : ''}
      </div>`;
    return;
  }

  renderAnalytics(body);
}

// ── Analytics rendering ────────────────────────────────────────────────────

function renderAnalytics(container) {
  const d = rs.data;
  const numDays = d.found_dates.length;

  const accountBanner = rs.accountIdFilter
    ? `<div class="alert alert-warning" style="margin-bottom:16px;font-size:0.85rem">
         Filtered to account <code>${esc(rs.accountIdFilter)}</code>${d.account_emails?.[rs.accountIdFilter] ? ` (${esc(d.account_emails[rs.accountIdFilter])})` : ''} — showing only that member's buckets.
         <button class="btn btn-sm" id="clear-account-filter" style="margin-left:12px">Clear filter</button>
       </div>`
    : '';

  const groupBanner = rs.groupIdFilter
    ? `<div class="alert alert-warning" style="margin-bottom:16px;font-size:0.85rem">
         Filtered to group <code>${esc(rs.groupIdFilter)}</code>.
         <button class="btn btn-sm" id="clear-group-filter" style="margin-left:12px">Clear filter</button>
       </div>`
    : '';

  container.innerHTML = `
    ${accountBanner}
    ${groupBanner}
    ${renderMissingNotice(d)}
    <div class="metric-tabs" id="metric-tabs">${renderMetricTabs(d)}</div>
    <div class="summary-cards">${renderSummaryCards(d, numDays)}</div>
    ${isCostMode() ? renderCostCards(d, numDays) : ''}
    <div class="card" style="margin-bottom:20px" id="trend-card">
      <div class="chart-toolbar">
        <span class="chart-title" id="trend-title">${isGbCostMode() ? 'Est. Cost' : 'Trend'} — ${esc(d.metrics[rs.selectedMetric]?.label || rs.selectedMetric)}</span>
        <div class="btn-group" id="chart-type-btns">
          <button class="btn btn-sm${rs.chartType === 'line' ? ' active' : ''}" data-type="line">Line</button>
          <button class="btn btn-sm${rs.chartType === 'bar'  ? ' active' : ''}" data-type="bar">Bar</button>
        </div>
        <div class="btn-group" id="view-mode-btns">
          <button class="btn btn-sm${rs.viewMode === 'total'  ? ' active' : ''}" data-mode="total">Total</button>
          <button class="btn btn-sm${rs.viewMode === 'bucket' ? ' active' : ''}" data-mode="bucket">By Bucket</button>
          ${d.groups?.length > 1 ? `<button class="btn btn-sm${rs.viewMode === 'group' ? ' active' : ''}" data-mode="group">By Group</button>` : ''}
        </div>
      </div>
      <div class="chart-wrap"><canvas id="trend-chart"></canvas></div>
    </div>
    ${d.buckets.length > 1 ? `
    <div class="card" style="margin-bottom:20px">
      <div class="chart-toolbar">
        <span class="chart-title">Storage by Bucket — latest period</span>
      </div>
      <div style="position:relative;height:${Math.max(120, Math.min(d.buckets.length * 32, 400))}px">
        <canvas id="bucket-chart"></canvas>
      </div>
    </div>` : ''}
    <div class="card" style="margin-bottom:20px" id="table-card">
      <div class="flex-between" style="margin-bottom:${rs.tableOpen ? '16px' : '0'}">
        <span style="font-weight:600;font-size:0.95rem">Summary Table</span>
        <button class="btn btn-sm" id="table-toggle">${rs.tableOpen ? '▲ Collapse' : '▼ Expand'}</button>
      </div>
      <div id="table-body" style="${rs.tableOpen ? '' : 'display:none'}">
        ${renderDataTable(d)}
      </div>
    </div>
  `;

  // Attach interactions
  container.querySelector('#metric-tabs').addEventListener('click', e => {
    const tab = e.target.closest('[data-metric]');
    if (!tab) return;
    rs.selectedMetric = tab.dataset.metric;
    container.querySelectorAll('.metric-tab').forEach(t => t.classList.toggle('active', t.dataset.metric === rs.selectedMetric));
    container.querySelector('#trend-title').textContent = `${isGbCostMode() ? 'Est. Cost' : 'Trend'} — ${d.metrics[rs.selectedMetric]?.label || rs.selectedMetric}`;
    renderTrendChart();
    renderDataTable_update(container, d);
  });

  container.querySelector('#chart-type-btns').addEventListener('click', e => {
    const btn = e.target.closest('[data-type]');
    if (!btn) return;
    rs.chartType = btn.dataset.type;
    container.querySelectorAll('#chart-type-btns .btn').forEach(b => b.classList.toggle('active', b.dataset.type === rs.chartType));
    renderTrendChart();
  });

  container.querySelector('#view-mode-btns').addEventListener('click', e => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    rs.viewMode = btn.dataset.mode;
    container.querySelectorAll('#view-mode-btns .btn').forEach(b => b.classList.toggle('active', b.dataset.mode === rs.viewMode));
    renderTrendChart();
  });

  container.querySelector('#table-toggle').addEventListener('click', () => {
    rs.tableOpen = !rs.tableOpen;
    const tb = container.querySelector('#table-body');
    const btn = container.querySelector('#table-toggle');
    tb.style.display = rs.tableOpen ? '' : 'none';
    btn.textContent = rs.tableOpen ? '▲ Collapse' : '▼ Expand';
    if (rs.tableOpen) container.querySelector('#table-card').style.marginBottom = '20px';
  });

  const missingFetch = container.querySelector('#fetch-missing-btn');
  if (missingFetch) {
    missingFetch.addEventListener('click', () => fetchMissing(container));
  }

  container.querySelector('#clear-account-filter')?.addEventListener('click', () => {
    rs.accountIdFilter = '';
    const input = document.getElementById('rpt-account-id');
    if (input) input.value = '';
    const page = container.closest('#page-content') || document.getElementById('page-content');
    loadData(page);
  });

  container.querySelector('#clear-group-filter')?.addEventListener('click', () => {
    rs.groupIdFilter = '';
    localStorage.setItem('rpt_groupIdFilter', '');
    const sel = document.getElementById('rpt-group-id');
    if (sel) sel.value = '';
    const page = container.closest('#page-content') || document.getElementById('page-content');
    loadData(page);
  });

  renderTrendChart();
  if (d.buckets.length > 1) renderBucketChart();
}

// ── Metric tabs ────────────────────────────────────────────────────────────

function renderMetricTabs(d) {
  return DISPLAY_METRICS.map(m => {
    const label = d.metrics[m]?.label || d.metric_labels?.[m] || m;
    return `<button class="metric-tab${m === rs.selectedMetric ? ' active' : ''}" data-metric="${esc(m)}">${esc(label)}</button>`;
  }).join('');
}

// ── Summary cards ──────────────────────────────────────────────────────────

function renderCostCards(d, numDays) {
  if (!isCostMode()) return '';
  const groups     = d.groups || [];
  const totByGroup = d.totals_by_group || {};
  const hasGroupRates = rs.pricingConfigs.length > 0 && groups.length > 0;

  const disclaimer = `<span style="font-size:0.75rem;color:var(--text-muted);font-weight:400">
    ⚠️ Best-effort estimates based on end-of-period storage snapshots and cumulative download.
    Actual billing uses byte-hours and may differ.</span>`;

  if (hasGroupRates) {
    let totalStoredCost = 0, totalDlCost = 0;
    const rows = groups
      .filter(gid => (totByGroup[gid]?.stored_gb ?? 0) > 0 || (totByGroup[gid]?.downloaded_gb ?? 0) > 0)
      .map(gid => {
        const rate    = rateForGroup(gid);
        const gStored = totByGroup[gid]?.stored_gb ?? 0;
        const gDl     = totByGroup[gid]?.downloaded_gb ?? 0;
        const sCost   = gStored / 1024 * rate;
        const dCost   = gDl    / 1024 * rate;
        totalStoredCost += sCost;
        totalDlCost     += dCost;
        const cfg   = rs.pricingConfigs.find(c => c.group_id === gid);
        const label = cfg ? (cfg.group_label || gid) : gid;
        const storedTb = (gStored / 1024).toFixed(2);
        const dlTb     = (gDl    / 1024).toFixed(2);
        return { label, rate, storedTb, dlTb, sCost, dCost };
      });

    const th = 'style="padding:6px 12px 6px 0;font-size:0.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);font-weight:600;white-space:nowrap"';
    const thR = 'style="padding:6px 0 6px 12px;font-size:0.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);font-weight:600;text-align:right;white-space:nowrap"';
    const td  = 'style="padding:7px 12px 7px 0;font-size:0.85rem;border-top:1px solid var(--border)"';
    const tdR = 'style="padding:7px 0 7px 12px;font-size:0.85rem;text-align:right;border-top:1px solid var(--border)"';
    const tdM = 'style="padding:7px 0 7px 12px;font-size:0.85rem;text-align:right;border-top:1px solid var(--border);color:var(--text-muted)"';

    return `
      <div class="card" style="border-left:3px solid #f59e0b;margin-bottom:20px">
        <div class="flex-between" style="margin-bottom:12px;flex-wrap:wrap;gap:8px">
          <div>
            <span style="font-weight:700;font-size:1rem;color:#f59e0b">💰 Revenue Estimate</span>
            &nbsp;&nbsp;${disclaimer}
          </div>
          <div style="font-size:1.4rem;font-weight:700">${fmtCost(totalStoredCost + totalDlCost)}</div>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr>
              <th ${th}>Group / Tier</th>
              <th ${thR}>Storage</th>
              <th ${thR}>Storage Cost</th>
              <th ${thR}>Download</th>
              <th ${thR}>Download Cost</th>
              <th ${thR}>Subtotal</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
            <tr>
              <td ${td}>${esc(r.label)} <span style="color:var(--text-muted);font-size:0.78rem">$${r.rate}/TB</span></td>
              <td ${tdM}>${r.storedTb} TB</td>
              <td ${tdR}>${fmtCost(r.sCost)}</td>
              <td ${tdM}>${r.dlTb} TB</td>
              <td ${tdR}>${fmtCost(r.dCost)}</td>
              <td ${tdR}><strong>${fmtCost(r.sCost + r.dCost)}</strong></td>
            </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr style="border-top:2px solid var(--border)">
              <td colspan="4" style="padding:8px 0;font-size:0.8rem;color:var(--text-muted)">
                Storage snapshot over ${numDays} day${numDays !== 1 ? 's' : ''} · Download cumulative
              </td>
              <td style="padding:8px 0 8px 12px;text-align:right;font-size:0.85rem;color:var(--text-muted)">Total</td>
              <td style="padding:8px 0 8px 12px;text-align:right;font-weight:700;font-size:1rem">
                ${fmtCost(totalStoredCost + totalDlCost)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>`;
  }

  // Flat-rate fallback
  const stored   = d.totals?.stored_gb ?? 0;
  const dl       = d.totals?.downloaded_gb ?? 0;
  const sCost    = toCost(stored);
  const dCost    = toCost(dl);
  const storedTb = (stored / 1024).toFixed(2);
  const dlTb     = (dl    / 1024).toFixed(2);

  return `
    <div class="card" style="border-left:3px solid #f59e0b;margin-bottom:20px">
      <div class="flex-between" style="margin-bottom:12px;flex-wrap:wrap;gap:8px">
        <div>
          <span style="font-weight:700;font-size:1rem;color:#f59e0b">💰 Revenue Estimate</span>
          &nbsp;&nbsp;${disclaimer}
        </div>
        <div style="font-size:1.4rem;font-weight:700">${fmtCost(sCost + dCost)}</div>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr>
            <th style="padding:6px 12px 6px 0;font-size:0.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);font-weight:600">Rate</th>
            <th style="padding:6px 0 6px 12px;font-size:0.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);font-weight:600;text-align:right">Storage</th>
            <th style="padding:6px 0 6px 12px;font-size:0.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);font-weight:600;text-align:right">Storage Cost</th>
            <th style="padding:6px 0 6px 12px;font-size:0.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);font-weight:600;text-align:right">Download</th>
            <th style="padding:6px 0 6px 12px;font-size:0.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);font-weight:600;text-align:right">Download Cost</th>
            <th style="padding:6px 0 6px 12px;font-size:0.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);font-weight:600;text-align:right">Total</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding:7px 12px 7px 0;font-size:0.85rem;border-top:1px solid var(--border)">
              All data <span style="color:var(--text-muted);font-size:0.78rem">$${rs.pricePerTb}/TB</span>
            </td>
            <td style="padding:7px 0 7px 12px;font-size:0.85rem;text-align:right;border-top:1px solid var(--border);color:var(--text-muted)">${storedTb} TB</td>
            <td style="padding:7px 0 7px 12px;font-size:0.85rem;text-align:right;border-top:1px solid var(--border)">${fmtCost(sCost)}</td>
            <td style="padding:7px 0 7px 12px;font-size:0.85rem;text-align:right;border-top:1px solid var(--border);color:var(--text-muted)">${dlTb} TB</td>
            <td style="padding:7px 0 7px 12px;font-size:0.85rem;text-align:right;border-top:1px solid var(--border)">${fmtCost(dCost)}</td>
            <td style="padding:7px 0 7px 12px;font-size:0.85rem;text-align:right;border-top:1px solid var(--border);font-weight:700">${fmtCost(sCost + dCost)}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr style="border-top:2px solid var(--border)">
            <td colspan="4" style="padding:8px 0;font-size:0.8rem;color:var(--text-muted)">
              Storage snapshot over ${numDays} day${numDays !== 1 ? 's' : ''} · Download cumulative
            </td>
            <td style="padding:8px 0 8px 12px;text-align:right;font-size:0.85rem;color:var(--text-muted)">Total</td>
            <td style="padding:8px 0 8px 12px;text-align:right;font-weight:700;font-size:1rem">${fmtCost(sCost + dCost)}</td>
          </tr>
        </tfoot>
      </table>
    </div>`;
}

function renderSummaryCards(d, numDays) {
  const stored  = d.totals?.stored_gb ?? 0;
  const dl      = d.totals?.downloaded_gb ?? 0;
  const ul      = d.totals?.uploaded_gb ?? 0;
  const apiB    = d.totals?.api_txn_class_b ?? 0;
  const apiC    = d.totals?.api_txn_class_c ?? 0;

  return `
    <div class="summary-card">
      <div class="sc-label">Storage</div>
      <div class="sc-value">${fmtGb(stored)}</div>
      <div class="sc-sub">Latest snapshot</div>
    </div>
    <div class="summary-card metric-downloaded">
      <div class="sc-label">Downloaded</div>
      <div class="sc-value">${fmtGb(dl)}</div>
      <div class="sc-sub">over ${numDays} day${numDays !== 1 ? 's' : ''}</div>
    </div>
    <div class="summary-card metric-uploaded">
      <div class="sc-label">Uploaded</div>
      <div class="sc-value">${fmtGb(ul)}</div>
      <div class="sc-sub">over ${numDays} day${numDays !== 1 ? 's' : ''}</div>
    </div>
    <div class="summary-card metric-api">
      <div class="sc-label">API (B+C)</div>
      <div class="sc-value">${fmtNum(apiB + apiC)}</div>
      <div class="sc-sub">transactions</div>
    </div>
  `;
}

// ── Trend chart ────────────────────────────────────────────────────────────

function renderTrendChart() {
  const canvas = document.getElementById('trend-chart');
  if (!canvas || typeof Chart === 'undefined') return;

  if (rs.trendChart) { rs.trendChart.destroy(); rs.trendChart = null; }

  const d = rs.data;
  const metricData = d.metrics[rs.selectedMetric];
  if (!metricData) return;

  const costMode = isGbCostMode();
  const cvt      = costMode ? toCost : (v => v);
  const fmtVal   = costMode ? fmtCost : (v => fmtMetricValue(v, rs.selectedMetric));

  const labels = d.period_labels;
  let datasets;

  if (rs.viewMode === 'group' && d.groups?.length > 1) {
    datasets = buildGroupDatasets(metricData, d.groups, labels.length, costMode);
  } else if (rs.viewMode === 'bucket' && d.buckets.length > 1) {
    datasets = buildBucketDatasets(metricData, d.buckets, labels.length, cvt);
  } else {
    datasets = [{
      label: costMode ? `Est. Cost (${metricData.label})` : metricData.label,
      data:  metricData.values.map(cvt),
      borderColor: CHART_COLORS[0],
      backgroundColor: rs.chartType === 'bar'
        ? CHART_COLORS[0] + '99'
        : CHART_COLORS[0] + '22',
      fill: rs.chartType === 'line',
      tension: 0.3,
      pointRadius: labels.length > 60 ? 0 : 3,
    }];
  }

  rs.trendChart = new Chart(canvas, {
    type: rs.chartType,
    data: { labels, datasets },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        ...CHART_DEFAULTS.plugins,
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${fmtVal(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        ...CHART_DEFAULTS.scales,
        y: {
          ...CHART_DEFAULTS.scales.y,
          ticks: {
            color: '#7b7f9e',
            callback: v => fmtVal(v),
          },
        },
      },
    },
  });
}

function buildBucketDatasets(metricData, buckets, numPeriods, cvt = v => v) {
  const TOP_N = 8;
  const top = buckets.slice(0, TOP_N);
  const rest = buckets.slice(TOP_N);

  const datasets = top.map((b, i) => ({
    label: b,
    data: (metricData.by_bucket[b] || Array(numPeriods).fill(0)).map(cvt),
    borderColor: CHART_COLORS[i % CHART_COLORS.length],
    backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + (rs.chartType === 'bar' ? '99' : '22'),
    fill: false,
    tension: 0.3,
    pointRadius: numPeriods > 60 ? 0 : 2,
    borderWidth: 2,
  }));

  if (rest.length > 0) {
    const otherData = Array(numPeriods).fill(0);
    rest.forEach(b => {
      const vals = metricData.by_bucket[b] || [];
      vals.forEach((v, i) => { otherData[i] += v; });
    });
    datasets.push({
      label: 'Other',
      data: otherData.map(cvt),
      borderColor: '#6b7280',
      backgroundColor: rs.chartType === 'bar' ? '#6b728099' : '#6b728022',
      fill: false,
      tension: 0.3,
      pointRadius: numPeriods > 60 ? 0 : 2,
      borderWidth: 2,
    });
  }

  return datasets;
}

function buildGroupDatasets(metricData, groups, numPeriods, costMode) {
  const TOP_N = 8;
  const isGbMetric = GB_METRICS.has(rs.selectedMetric);
  const top  = groups.slice(0, TOP_N);
  const rest = groups.slice(TOP_N);

  const datasets = top.map((gid, i) => {
    const vals = metricData.by_group?.[gid] || Array(numPeriods).fill(0);
    const cfg  = rs.pricingConfigs.find(c => c.group_id === gid);
    const label = cfg ? (cfg.group_label || gid) : gid;
    // In cost mode with per-group pricing, use this group's rate; else flat toCost
    const cvt = (costMode && isGbMetric && rs.pricingConfigs.length > 0)
      ? (v => toCostForGroup(v, gid))
      : costMode && isGbMetric ? toCost : (v => v);
    return {
      label,
      data: vals.map(cvt),
      borderColor:     CHART_COLORS[i % CHART_COLORS.length],
      backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + (rs.chartType === 'bar' ? '99' : '22'),
      fill: false,
      tension: 0.3,
      pointRadius: numPeriods > 60 ? 0 : 2,
      borderWidth: 2,
    };
  });

  if (rest.length > 0) {
    // "Other" bucket: sum remaining groups; use flat rate for cost (mixed pricing)
    const cvt = costMode && isGbMetric ? toCost : (v => v);
    const otherData = Array(numPeriods).fill(0);
    rest.forEach(gid => {
      const vals = metricData.by_group?.[gid] || [];
      vals.forEach((v, i) => { otherData[i] += v; });
    });
    datasets.push({
      label: 'Other',
      data: otherData.map(cvt),
      borderColor:     '#6b7280',
      backgroundColor: rs.chartType === 'bar' ? '#6b728099' : '#6b728022',
      fill: false,
      tension: 0.3,
      pointRadius: numPeriods > 60 ? 0 : 2,
      borderWidth: 2,
    });
  }

  return datasets;
}

// ── Bucket bar chart ───────────────────────────────────────────────────────

function renderBucketChart() {
  const canvas = document.getElementById('bucket-chart');
  if (!canvas || typeof Chart === 'undefined') return;

  if (rs.bucketChart) { rs.bucketChart.destroy(); rs.bucketChart = null; }

  const d = rs.data;
  const storedData = d.metrics['stored_gb'];
  if (!storedData) return;

  const lastIdx  = d.periods.length - 1;
  const costMode = isCostMode();
  const bucketVals = d.buckets.map(b => {
    const vals  = storedData.by_bucket[b] || [];
    const gbVal = vals[lastIdx] ?? 0;
    return { bucket: b, val: costMode ? toCost(gbVal) : gbVal };
  }).filter(x => x.val > 0);

  // Show top 20 by storage
  const top = bucketVals.slice(0, 20);

  rs.bucketChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: top.map(x => x.bucket),
      datasets: [{
        label: costMode ? 'Est. Cost' : 'Stored GB',
        data: top.map(x => x.val),
        backgroundColor: top.map((_, i) => CHART_COLORS[i % CHART_COLORS.length] + 'cc'),
        borderColor:     top.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
        borderWidth: 1,
      }],
    },
    options: {
      ...CHART_DEFAULTS,
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: ctx => costMode ? fmtCost(ctx.parsed.x) : fmtGb(ctx.parsed.x) },
        },
      },
      scales: {
        x: {
          ticks: { color: '#7b7f9e', callback: v => costMode ? fmtCost(v) : fmtGb(v) },
          grid:  { color: '#2e3147' },
        },
        y: {
          ticks: { color: '#e2e4f0', font: { size: 11 } },
          grid:  { color: '#2e3147' },
        },
      },
    },
  });
}

// ── Data table ─────────────────────────────────────────────────────────────

function renderDataTable(d) {
  const metric    = rs.selectedMetric;
  const metricData = d.metrics[metric];
  if (!metricData) return '<p style="color:var(--text-muted)">No data.</p>';

  const showPeriods = d.periods.length <= 14;
  const buckets     = d.buckets;
  const costMode    = isGbCostMode();
  const fmtFinal    = costMode
    ? (v => fmtCost(toCost(v)))
    : (v => fmtMetricValue(v, metric));

  const periodCols = showPeriods
    ? d.period_labels.map(l => `<th class="num">${esc(l)}</th>`).join('')
    : `<th class="num">${costMode ? 'Est. Cost' : 'Total'}</th>`;

  const bucketRows = buckets.map(b => {
    const vals = metricData.by_bucket[b] || [];
    if (showPeriods) {
      const cells = d.periods.map((_, i) => `<td class="num">${fmtFinal(vals[i] ?? 0)}</td>`).join('');
      return `<tr><td>${esc(b)}</td>${cells}</tr>`;
    } else {
      const total = metric in { stored_gb: 1, storage_byte_hours: 1 }
        ? (vals[vals.length - 1] ?? 0)
        : vals.reduce((a, v) => a + v, 0);
      return `<tr><td>${esc(b)}</td><td class="num">${fmtFinal(total)}</td></tr>`;
    }
  }).join('');

  // Total row
  let totalCells;
  if (showPeriods) {
    totalCells = metricData.values.map(v => `<td class="num">${fmtFinal(v)}</td>`).join('');
  } else {
    totalCells = `<td class="num">${fmtFinal(d.totals[metric])}</td>`;
  }

  return `
    <div class="data-table-wrap">
      <table>
        <thead><tr><th>Bucket</th>${periodCols}</tr></thead>
        <tbody>
          ${bucketRows}
          <tr class="total-row"><td>Total</td>${totalCells}</tr>
        </tbody>
      </table>
    </div>
  `;
}

function renderDataTable_update(container, d) {
  const tb = container.querySelector('#table-body');
  if (tb) tb.innerHTML = renderDataTable(d);
}

// ── Missing dates notice ───────────────────────────────────────────────────

function renderMissingNotice(d) {
  if (!d.missing_dates.length) return '';
  return `
    <div class="alert alert-warning" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <span>${d.missing_dates.length} date${d.missing_dates.length !== 1 ? 's' : ''} in this range have no cached data.</span>
      <button class="btn btn-sm" id="fetch-missing-btn">Fetch Missing Dates</button>
    </div>
  `;
}

function renderFetchMissingBtn(d) {
  return `<button class="btn btn-sm" id="fetch-missing-btn" style="margin-left:8px">Fetch Missing Dates</button>`;
}

async function fetchMissing(container) {
  const btn = container.querySelector('#fetch-missing-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Fetching…'; }

  const params = new URLSearchParams({ start_date: rs.startDate, end_date: rs.endDate });
  let result;
  try {
    const res = await api(`/api/reports/fetch-range?${params}`, { method: 'POST' });
    result = res?.ok ? await res.json() : null;
  } catch (_) { result = null; }

  const notice = container.querySelector('.alert-warning');
  if (!result) {
    if (notice) notice.innerHTML = '<span class="text-danger">Fetch failed. Check connection.</span>';
    return;
  }

  if (notice) {
    notice.className = 'alert alert-success';
    notice.innerHTML = `Fetched ${result.fetched} date${result.fetched !== 1 ? 's' : ''}, ${result.skipped} already cached, ${result.failed} failed.`;
  }

  // Reload data after a short pause so files are written
  setTimeout(() => loadData(container.closest('#page-content') || document.getElementById('page-content')), 800);
}

// ── CSV Export ─────────────────────────────────────────────────────────────

function exportCsv() {
  const d = rs.data;
  if (!d || !d.periods.length) return;

  const costMode   = isCostMode();
  const metrics    = DISPLAY_METRICS.filter(m => d.metrics[m]);
  const metaLabels = metrics.map(m => d.metrics[m]?.label || m);
  const SNAP       = new Set(['stored_gb', 'storage_byte_hours']);

  // Helper: get total value for a metric from an array of period values
  function periodTotal(m, vals) {
    return SNAP.has(m) ? (vals[vals.length - 1] ?? 0) : vals.reduce((a, v) => a + v, 0);
  }

  // Helper: cost columns for a group (only when per-group pricing active)
  function costCols(gid, storedGb, dlGb) {
    if (!costMode) return [];
    const rate = rateForGroup(gid ?? '');
    return [+(storedGb / 1024 * rate).toFixed(4), +(dlGb / 1024 * rate).toFixed(4)];
  }

  function flatCostCols(storedGb, dlGb) {
    if (!costMode) return [];
    return [+(toCost(storedGb)).toFixed(4), +(toCost(dlGb)).toFixed(4)];
  }

  const costHeaders = costMode ? ['Est. Storage Cost ($)', 'Est. Download Cost ($)'] : [];

  const lines = [];

  // ── Section 1: Period summary ──────────────────────────────────────────────
  lines.push(csvRow([`Usage Report: ${rs.startDate} to ${rs.endDate}`]));
  lines.push(csvRow([`Generated: ${new Date().toISOString()}`]));
  if (costMode) lines.push(csvRow(['Note: Cost estimates are best-effort based on end-of-period storage snapshots.']));
  lines.push('');

  lines.push(csvRow(['PERIOD SUMMARY']));
  lines.push(csvRow(['Period', 'Period (ISO)', ...metaLabels, ...costHeaders]));
  d.periods.forEach((p, i) => {
    const vals = metrics.map(m => +(d.metrics[m].values[i] ?? 0));
    const storedGb = d.metrics['stored_gb']?.values[i] ?? 0;
    const dlGb     = d.metrics['downloaded_gb']?.values[i] ?? 0;
    lines.push(csvRow([d.period_labels[i], p, ...vals, ...flatCostCols(storedGb, dlGb)]));
  });
  // Totals row
  const totalVals = metrics.map(m => +((d.totals[m] ?? 0)));
  const totalStoredGb = d.totals['stored_gb'] ?? 0;
  const totalDlGb     = d.totals['downloaded_gb'] ?? 0;
  lines.push(csvRow(['TOTAL', '', ...totalVals, ...flatCostCols(totalStoredGb, totalDlGb)]));

  // ── Section 2: By group ────────────────────────────────────────────────────
  if (d.groups?.length > 0) {
    lines.push('');
    lines.push(csvRow(['BY GROUP']));
    const grpCostHeaders = costMode ? ['Rate ($/TB)', 'Est. Storage Cost ($)', 'Est. Download Cost ($)', 'Est. Total Cost ($)'] : [];
    lines.push(csvRow(['Group ID', 'Group Label', ...metaLabels, ...grpCostHeaders]));
    d.groups.forEach(gid => {
      const cfg    = rs.pricingConfigs.find(c => c.group_id === gid);
      const label  = cfg ? (cfg.group_label || gid) : gid;
      const tot    = d.totals_by_group?.[gid] || {};
      const vals   = metrics.map(m => +(tot[m] ?? 0));
      const rate   = rateForGroup(gid);
      const sCost  = +(((tot['stored_gb'] ?? 0) / 1024 * rate)).toFixed(4);
      const dCost  = +(((tot['downloaded_gb'] ?? 0) / 1024 * rate)).toFixed(4);
      const grpCost = costMode ? [rate, sCost, dCost, +(sCost + dCost).toFixed(4)] : [];
      lines.push(csvRow([gid, label, ...vals, ...grpCost]));
    });
  }

  // ── Section 3: By account ──────────────────────────────────────────────────
  if (d.accounts?.length > 0) {
    lines.push('');
    lines.push(csvRow(['BY ACCOUNT']));
    lines.push(csvRow(['Account ID', 'Email', ...metaLabels]));
    d.accounts.forEach(aid => {
      const email = d.account_emails?.[aid] || '';
      const tot   = d.totals_by_account?.[aid] || {};
      const vals  = metrics.map(m => +(tot[m] ?? 0));
      lines.push(csvRow([aid, email, ...vals]));
    });
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `b2-usage-${rs.startDate}-to-${rs.endDate}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function csvRow(cells) {
  return cells.map(v => csvCell(String(v ?? ''))).join(',');
}

function csvCell(s) {
  s = String(s);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ── Manage Rates modal ─────────────────────────────────────────────────────

function showManageRatesModal(page) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:580px">
      <div class="modal-title">Manage Pricing Rates</div>
      <p class="text-muted" style="font-size:0.85rem;margin-bottom:16px">
        Set a $/TB rate per group. Used by Cost View to estimate charges on stored and downloaded data.
      </p>
      <div id="rates-list" style="margin-bottom:16px"></div>
      <div class="card">
        <h4 style="margin:0 0 12px;font-size:0.9rem">Add / Update Rate</h4>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Group ID</label>
            <input type="text" id="nr-group-id" class="form-input" placeholder="e.g. 162141" autocomplete="off">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Label (optional)</label>
            <input type="text" id="nr-label" class="form-input" placeholder="e.g. Acme Corp">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">$/TB</label>
            <input type="number" id="nr-price" class="form-input" placeholder="0.000" min="0" step="0.001">
          </div>
        </div>
        <div id="nr-result" style="margin-top:8px"></div>
        <button class="btn btn-primary" id="nr-save-btn" style="margin-top:10px">Save Rate</button>
      </div>
      <div class="modal-actions" style="margin-top:16px">
        <button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove()">Done</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  _renderRatesList(overlay, page);

  overlay.querySelector('#nr-save-btn').addEventListener('click', async () => {
    const groupId = overlay.querySelector('#nr-group-id').value.trim();
    const label   = overlay.querySelector('#nr-label').value.trim();
    const price   = parseFloat(overlay.querySelector('#nr-price').value);
    const result  = overlay.querySelector('#nr-result');

    if (!groupId)          { result.innerHTML = '<div class="alert alert-error">Group ID is required.</div>'; return; }
    if (isNaN(price) || price < 0) { result.innerHTML = '<div class="alert alert-error">Enter a valid price.</div>'; return; }

    const res = await api(`/api/pricing/${encodeURIComponent(groupId)}`, {
      method: 'PUT',
      body: JSON.stringify({ group_label: label, price_per_tb: price }),
    });
    if (res?.ok) {
      const saved = await res.json();
      rs.pricingConfigs = [...rs.pricingConfigs.filter(c => c.group_id !== groupId), saved]
        .sort((a, b) => (a.group_label || a.group_id).localeCompare(b.group_label || b.group_id));
      _rebuildRateDropdown(page);
      result.innerHTML = '<div class="alert alert-success">Rate saved.</div>';
      overlay.querySelector('#nr-group-id').value = '';
      overlay.querySelector('#nr-label').value    = '';
      overlay.querySelector('#nr-price').value    = '';
      _renderRatesList(overlay, page);
    } else {
      result.innerHTML = '<div class="alert alert-error">Failed to save rate.</div>';
    }
  });
}

function _renderRatesList(overlay, page) {
  const listDiv = overlay.querySelector('#rates-list');
  if (!rs.pricingConfigs.length) {
    listDiv.innerHTML = '<p class="text-muted" style="font-size:0.85rem">No rates configured yet.</p>';
    return;
  }
  listDiv.innerHTML = `
    <div class="card" style="padding:0;overflow:hidden">
      <table>
        <thead><tr><th>Group ID</th><th>Label</th><th>$/TB</th><th></th></tr></thead>
        <tbody>
          ${rs.pricingConfigs.map(c => `
            <tr>
              <td style="font-family:monospace;font-size:0.85rem">${esc(c.group_id)}</td>
              <td>${esc(c.group_label || '—')}</td>
              <td>$${Number(c.price_per_tb).toFixed(4)}</td>
              <td style="white-space:nowrap">
                <button class="btn btn-sm" data-use="${esc(c.group_id)}">Use</button>
                <button class="btn btn-danger btn-sm" data-del="${esc(c.group_id)}">Delete</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  listDiv.querySelectorAll('[data-use]').forEach(btn => {
    btn.addEventListener('click', () => {
      const c = rs.pricingConfigs.find(x => x.group_id === btn.dataset.use);
      if (!c) return;
      rs.pricePerTb = c.price_per_tb;
      localStorage.setItem('rpt_pricePerTb', rs.pricePerTb);
      const inp = page.querySelector('#rpt-price-tb');
      const sel = page.querySelector('#rpt-rate-select');
      if (inp) inp.value = c.price_per_tb;
      if (sel) sel.value = c.price_per_tb;
    });
  });

  listDiv.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const gid = btn.dataset.del;
      const res = await api(`/api/pricing/${encodeURIComponent(gid)}`, { method: 'DELETE' });
      if (res?.ok) {
        rs.pricingConfigs = rs.pricingConfigs.filter(c => c.group_id !== gid);
        _rebuildRateDropdown(page);
        _renderRatesList(overlay, page);
      }
    });
  });
}

function _rebuildRateDropdown(page) {
  const select = page.querySelector('#rpt-rate-select');
  if (!select) return;
  const prev = select.value;
  while (select.options.length > 1) select.remove(1);
  rs.pricingConfigs.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.price_per_tb;
    opt.textContent = `${c.group_label || c.group_id} — $${c.price_per_tb}/TB`;
    select.appendChild(opt);
  });
  select.value = prev;
}
