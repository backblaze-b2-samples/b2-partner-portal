/**
 * app.js — Router, global state, auth, shared helpers
 * All other JS modules import from here.
 */

// ── State ─────────────────────────────────────────────────────────────────

export const state = {
  user: null,           // {id, email, role_id, permissions: []}
  accessToken: localStorage.getItem('access_token') || '',
  refreshToken: localStorage.getItem('refresh_token') || '',
  apiInspectorEnabled: false,
};

// ── Auth helpers ──────────────────────────────────────────────────────────

export async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.accessToken) headers['Authorization'] = `Bearer ${state.accessToken}`;

  let res = await fetch(path, { ...options, headers });

  // Try refresh on 401
  if (res.status === 401 && state.refreshToken) {
    const refreshRes = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: state.refreshToken }),
    });
    if (refreshRes.ok) {
      const data = await refreshRes.json();
      state.accessToken  = data.access_token;
      state.refreshToken = data.refresh_token;
      localStorage.setItem('access_token',  data.access_token);
      localStorage.setItem('refresh_token', data.refresh_token);
      headers['Authorization'] = `Bearer ${state.accessToken}`;
      res = await fetch(path, { ...options, headers });
    } else {
      logout();
      return null;
    }
  }

  if (res.status === 401) { logout(); return null; }
  return res;
}

export function logout() {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  window.location.href = '/login';
}

export function hasPermission(perm) {
  return state.user?.permissions?.includes(perm) ?? false;
}

// ── Formatting helpers ────────────────────────────────────────────────────

export function fmtBytes(n) {
  if (!n && n !== 0) return '–';
  const units = ['B','KB','MB','GB','TB','PB'];
  const i = Math.max(0, Math.floor(Math.log(Math.abs(n)) / Math.log(1024)));
  return (n / Math.pow(1024, Math.min(i, units.length - 1))).toFixed(i > 0 ? 2 : 0) + ' ' + units[Math.min(i, units.length - 1)];
}

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

export function fmtDate(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString();
}

// ── Credentials CSV download ─────────────────────────────────────────────

function _csvSafe(v) {
  const s = String(v ?? '');
  return (s && '=+-@\t\r'.includes(s[0])) ? '\t' + s : s;
}

export function downloadCredentialsCsv({ accountId, email, applicationKeyId, applicationKey }) {
  const rows = [
    ['Account ID', 'Email', 'Application Key ID', 'Application Key'],
    [accountId, email, applicationKeyId, applicationKey].map(_csvSafe),
  ];
  _triggerCsvDownload(rows, `b2-credentials-${accountId}.csv`);
}

export function downloadCredentialsCsvFull({ accountId, email, region, s3Endpoint, applicationKeyId, applicationKey }) {
  const rows = [
    ['Account ID', 'Email', 'Region', 'S3 Endpoint', 'Application Key ID', 'Application Key'],
    [accountId, email, region || '', s3Endpoint || '', applicationKeyId, applicationKey].map(_csvSafe),
  ];
  _triggerCsvDownload(rows, `b2-credentials-${accountId}.csv`);
}

function _triggerCsvDownload(rows, filename) {
  const csv  = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── API Inspector component ───────────────────────────────────────────────
// Shows the raw Backblaze API call made by the backend.
// Every response that touches B2 includes a `b2_api_call` field.

export function renderApiInspector(b2ApiCall) {
  if (!b2ApiCall || !state.apiInspectorEnabled) return '';

  const methodClass = {POST:'post', GET:'get', DELETE:'delete'}[b2ApiCall.method] || 'get';
  const statusClass = b2ApiCall.response_status === 200 ? 'ok' : 'err';

  const reqBody = b2ApiCall.request_body
    ? `<div class="api-section">
         <div class="api-section-label">Request Body</div>
         <pre class="api-code">${esc(JSON.stringify(b2ApiCall.request_body, null, 2))}</pre>
       </div>`
    : '';

  const headers = Object.entries(b2ApiCall.request_headers || {})
    .map(([k,v]) => `${esc(k)}: ${esc(v)}`).join('\n');

  return `
    <div class="api-inspector">
      <div class="api-inspector-header" onclick="this.nextElementSibling.classList.toggle('open'); this.querySelector('.toggle').textContent = this.nextElementSibling.classList.contains('open') ? '▲' : '▼'">
        <div class="api-inspector-title">
          <span class="api-inspector-badge">B2 API Call</span>
          <span>See the Backblaze API request this action made</span>
        </div>
        <span class="toggle">▼</span>
      </div>
      <div class="api-inspector-body">
        <div class="api-section">
          <div class="api-section-label">Endpoint</div>
          <div>
            <span class="api-method api-method-${methodClass}">${esc(b2ApiCall.method)}</span>
            <span class="api-url">${esc(b2ApiCall.url)}</span>
          </div>
        </div>
        <div class="api-section">
          <div class="api-section-label">Request Headers</div>
          <pre class="api-code">${esc(headers)}</pre>
        </div>
        ${reqBody}
        <div class="api-section">
          <div class="api-section-label">Response</div>
          <span class="api-status api-status-${statusClass}">HTTP ${b2ApiCall.response_status}</span>
          <span class="api-duration">${b2ApiCall.duration_ms}ms</span>
          <pre class="api-code" style="margin-top:8px">${esc(JSON.stringify(b2ApiCall.response_body, null, 2))}</pre>
        </div>
      </div>
    </div>
  `;
}

// ── Router ────────────────────────────────────────────────────────────────

import { renderDashboard } from './dashboard.js';
import { renderGroups } from './groups.js';
import { renderMembers } from './members.js';
import { renderReports } from './reports.js';
import { renderUsers } from './users.js';
import { renderRoles } from './roles.js';
import { renderSettings } from './settings.js';
import { renderCredentials } from './credentials.js';
import { renderAudit } from './audit.js';

const VIEWS = {
  dashboard:   renderDashboard,
  groups:      renderGroups,
  members:     renderMembers,
  reports:     renderReports,
  users:       renderUsers,
  roles:       renderRoles,
  settings:    renderSettings,
  credentials: renderCredentials,
  audit:       renderAudit,
};

let _currentView = null;

async function navigate(view) {
  if (!VIEWS[view]) view = 'dashboard';
  _currentView = view;

  // Update active nav link
  document.querySelectorAll('.nav-link').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });

  const content = document.getElementById('page-content');
  content.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';

  await VIEWS[view](content);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

async function boot() {
  // Load current user
  const res = await api('/api/auth/me');
  if (!res || !res.ok) { logout(); return; }
  state.user = await res.json();
  state.apiInspectorEnabled = state.user.api_inspector_enabled ?? false;

  // Update sidebar
  document.getElementById('sidebar-email').textContent = state.user.email;
  document.getElementById('sidebar-role').textContent = state.user.role_id;

  // Hide admin nav items from non-admins
  if (!hasPermission('users:read')) document.getElementById('nav-users')?.remove();
  if (!hasPermission('roles:read')) document.getElementById('nav-roles')?.remove();
  if (!hasPermission('settings:read')) document.getElementById('nav-settings')?.remove();
  if (!hasPermission('credentials:read')) document.getElementById('nav-credentials')?.remove();
  if (!hasPermission('audit:read')) document.getElementById('nav-audit')?.remove();

  // Remove the Admin section header if all items beneath it were removed
  const adminSection = document.getElementById('admin-section');
  if (adminSection && !adminSection.nextElementSibling?.classList.contains('nav-link')) {
    adminSection.remove();
  }

  // Logout button
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: state.refreshToken }),
    });
    logout();
  });

  // Nav clicks
  document.querySelectorAll('.nav-link[data-view]').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.view));
  });

  // Initial route
  const hash = (location.hash.replace('#', '') || 'dashboard').split('?')[0];
  await navigate(hash);

  // Update URL hash on navigate
  window.addEventListener('hashchange', () => {
    const view = (location.hash.replace('#', '') || 'dashboard').split('?')[0];
    navigate(view);
  });
}

boot();
