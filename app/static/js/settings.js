import { api, esc, hasPermission, renderApiInspector } from './app.js';

export async function renderSettings(page) {
  const [settingsRes, rolesRes, oidcRes] = await Promise.all([
    api('/api/settings'),
    api('/api/roles'),
    api('/api/auth/oidc/config'),
  ]);
  const cfg      = settingsRes?.ok ? await settingsRes.json() : {};
  const roles = rolesRes?.ok ? await rolesRes.json() : [];
  const oidcCfg  = oidcRes?.ok ? await oidcRes.json() : null;

  const canWrite = hasPermission('settings:write');

  page.innerHTML = `
    <div class="page-header">
      <h1>Settings</h1>
      <p class="page-subtitle">Backblaze Partner API credentials, report bucket, and automation</p>
    </div>

    <div class="card">
      <h3>Partner API Credentials</h3>
      <p class="text-muted" style="font-size:0.85rem;margin-bottom:20px">
        Your master application key for the Backblaze Partner API.
        Generate one at <strong>Backblaze → App Keys</strong> with all capabilities.<br>
        This key is used to call <code>b2_authorize_account</code>, then <code>b2_list_groups</code>,
        <code>b2_create_group_member</code>, etc.
      </p>

      <div id="settings-result"></div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div class="form-group">
          <label class="form-label">Account ID</label>
          <input type="text" id="account-id" class="form-input"
            placeholder="123456789abc" value="${esc(cfg.account_id || '')}">
        </div>
        <div class="form-group">
          <label class="form-label">Application Key ID</label>
          <input type="text" id="key-id" class="form-input"
            placeholder="001abc..." value="${esc(cfg.application_key_id || '')}">
        </div>
        <div class="form-group">
          <label class="form-label">Application Key</label>
          <input type="password" id="app-key" class="form-input"
            placeholder="${cfg.application_key_masked || 'Enter new key to update'}">
          ${cfg.application_key_masked ? `<div class="form-hint">Current: ${esc(cfg.application_key_masked)}</div>` : ''}
        </div>
      </div>

      <h3 style="margin-top:8px">Usage Reports Bucket</h3>
      <p class="text-muted" style="font-size:0.85rem;margin-bottom:16px">
        The B2 bucket where your daily report CSVs are stored.
        Typically set up by Backblaze as part of your partner agreement.
      </p>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div class="form-group">
          <label class="form-label">Report Bucket Name</label>
          <input type="text" id="report-bucket" class="form-input"
            placeholder="b2-reports-{account-id}" value="${esc(cfg.report_bucket || '')}">
        </div>
        <div class="form-group">
          <label class="form-label">Object Prefix</label>
          <input type="text" id="report-prefix" class="form-input"
            placeholder="(empty — files are at bucket root)" value="${esc(cfg.report_prefix || '')}">
          <div class="form-hint">Path prefix before the date folder. Leave empty if reports are at the bucket root.</div>
        </div>
      </div>

      <div class="flex-gap" style="margin-top:8px">
        <button class="btn btn-primary" id="save-btn">Save Settings</button>
        <button class="btn" id="test-btn">Test Connection</button>
      </div>
    </div>

    <div id="test-result"></div>

    ${canWrite ? `
    <div class="card" id="automation-card">
      <h3>Report Automation</h3>
      <p class="text-muted" style="font-size:0.85rem;margin-bottom:20px">
        Automatically fetch daily reports on a schedule and optionally purge old cached files.
        The scheduler runs server-side — no external cron job needed.
      </p>
      <div id="automation-loading" class="text-muted" style="font-size:0.85rem">Loading…</div>
    </div>` : ''}

    ${canWrite && oidcCfg !== null ? `
    <div class="card" id="oidc-card">
      <h3>Single Sign-On (OIDC)</h3>
      <p class="text-muted" style="font-size:0.85rem;margin-bottom:20px">
        Allow users to sign in via any OIDC-compliant identity provider — Azure Entra ID, Google Workspace,
        Okta, Auth0, Keycloak, and others. Group memberships from the provider are mapped to portal roles below.
        Local accounts always remain active as a fallback.
      </p>

      <div id="oidc-result"></div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
        <div class="form-group" style="margin:0;grid-column:1/-1">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="oidc-enabled" ${oidcCfg.enabled ? 'checked' : ''}>
            <span class="form-label" style="margin:0">Enable SSO</span>
          </label>
          <div class="form-hint">Shows the SSO login button on the login page when enabled.</div>
        </div>
        <div class="form-group" style="margin:0;grid-column:1/-1">
          <label class="form-label">Issuer URL</label>
          <input type="text" id="oidc-issuer-url" class="form-input"
            placeholder="https://login.microsoftonline.com/{tenant-id}/v2.0"
            value="${esc(oidcCfg.issuer_url || '')}" autocomplete="off" spellcheck="false">
          <div class="form-hint">
            The base URL for your OIDC provider. The portal fetches
            <code>{issuer_url}/.well-known/openid-configuration</code> to discover all endpoints automatically.<br>
            <strong>Azure:</strong> <code>https://login.microsoftonline.com/{tenant-id}/v2.0</code> &nbsp;·&nbsp;
            <strong>Google:</strong> <code>https://accounts.google.com</code> &nbsp;·&nbsp;
            <strong>Okta:</strong> <code>https://{org}.okta.com</code> &nbsp;·&nbsp;
            <strong>Keycloak:</strong> <code>https://{host}/realms/{realm}</code>
          </div>
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Client (Application) ID</label>
          <input type="text" id="oidc-client-id" class="form-input"
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            value="${esc(oidcCfg.client_id || '')}" autocomplete="off" spellcheck="false">
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Client Secret ${oidcCfg.client_secret_set ? '<span style="color:var(--success);font-weight:400;text-transform:none">(set)</span>' : ''}</label>
          <input type="password" id="oidc-client-secret" class="form-input"
            placeholder="${oidcCfg.client_secret_set ? 'Leave blank to keep existing' : 'Enter client secret'}">
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Redirect URI</label>
          <div style="display:flex;gap:8px">
            <input type="text" id="oidc-redirect-uri" class="form-input"
              placeholder="https://yourportal.example.com/api/auth/oidc/callback"
              value="${esc(oidcCfg.redirect_uri || '')}" autocomplete="off" style="flex:1">
            <button type="button" class="btn" id="copy-redirect-uri-btn" title="Copy callback URL">Copy</button>
          </div>
          <div class="form-hint">
            Must match exactly what's registered with your identity provider.
            This portal's callback URL is: <code id="suggested-redirect-uri"></code>
          </div>
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Groups claim name</label>
          <input type="text" id="oidc-groups-claim" class="form-input"
            placeholder="groups"
            value="${esc(oidcCfg.groups_claim || 'groups')}" autocomplete="off" spellcheck="false">
          <div class="form-hint">
            The ID token claim that contains group memberships. <code>groups</code> works for
            Azure, Okta, and Keycloak. Configure group claims in your provider's app settings.
          </div>
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Login button label</label>
          <input type="text" id="oidc-button-label" class="form-input"
            placeholder="Sign in with SSO"
            value="${esc(oidcCfg.button_label || 'Sign in with SSO')}">
          <div class="form-hint">Text shown on the SSO button on the login page.</div>
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Default role <span style="color:var(--text-muted);font-weight:400;text-transform:none">(optional)</span></label>
          <select id="oidc-default-role" class="form-select">
            <option value="">— deny access if no group matches —</option>
            ${roles.map(r =>
              `<option value="${esc(r.id)}" ${oidcCfg.default_role_id === r.id ? 'selected' : ''}>${esc(r.name)}</option>`
            ).join('')}
          </select>
          <div class="form-hint">Assigned when no group mapping matches. Leave blank to deny access.</div>
        </div>
      </div>

      <button class="btn btn-primary" id="save-oidc-btn">Save SSO Settings</button>

      <hr style="margin:24px 0;border:none;border-top:1px solid var(--border)">

      <h4 style="margin:0 0 8px">Group → Role Mappings</h4>
      <p class="text-muted" style="font-size:0.85rem;margin-bottom:16px">
        Map Azure group Object IDs to portal roles. On login, the <strong>first matching group</strong> wins.
        Use the arrows to set priority — higher in the list = higher priority.
        Configure group claims in your Azure App Registration under <em>Token configuration → Add groups claim</em>.
      </p>
      <div id="oidc-mappings-list"></div>
      <div class="card" style="padding:16px;margin-top:12px">
        <h4 style="margin:0 0 12px;font-size:0.9rem">Add Mapping</h4>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:12px;align-items:flex-end">
          <div class="form-group" style="margin:0">
            <label class="form-label">Group identifier</label>
            <input type="text" id="new-group-id" class="form-input" placeholder="e.g. group-guid or group-name" autocomplete="off" spellcheck="false">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Label <span style="color:var(--text-muted);font-weight:400">(optional)</span></label>
            <input type="text" id="new-group-label" class="form-input" placeholder="e.g. Portal Admins">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Portal Role</label>
            <select id="new-group-role" class="form-select">
              ${roles.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}
            </select>
          </div>
          <button class="btn btn-primary" id="add-mapping-btn">Add</button>
        </div>
        <div id="add-mapping-result" style="margin-top:8px"></div>
      </div>
    </div>` : ''}

    <!-- API reference card -->
    <div class="card">
      <h3>How Authentication Works</h3>
      <p class="text-muted" style="font-size:0.85rem;margin-bottom:16px">
        Every request to the Partner API starts with <code>b2_authorize_account</code>.
        The response contains an <code>authorizationToken</code> valid for up to 24 hours.
        This portal caches that token and re-authorizes automatically when it expires.
      </p>
      <pre class="api-code"># Step 1: Authorize
GET https://api.backblazeb2.com/b2api/v3/b2_authorize_account
Authorization: Basic base64(applicationKeyId:applicationKey)

# Response includes:
# - authorizationToken (use for all subsequent calls)
# - apiInfo.groupsApi.groupsApiUrl (base URL for Partner API calls)
# - apiInfo.storageApi.apiUrl (base URL for B2 Native API calls)
# - apiInfo.storageApi.downloadUrl (base URL for file downloads)

# Step 2: Use the token
POST {groupsApiUrl}/b2api/v3/b2_list_groups
Authorization: {authorizationToken}
Content-Type: application/json

{
  "adminAccountId": "{accountId}",
  "maxGroupCount": 100
}</pre>
    </div>
  `;

  document.getElementById('save-btn').addEventListener('click', saveSettings);
  document.getElementById('test-btn').addEventListener('click', testConnection);

  if (canWrite && oidcCfg !== null) {
    document.getElementById('save-oidc-btn').addEventListener('click', saveOidcConfig);
    document.getElementById('add-mapping-btn').addEventListener('click', addMapping);
    loadMappings();

    // Populate suggested redirect URI and wire up copy button
    const suggestedUri = `${location.origin}/api/auth/oidc/callback`;
    const suggestedEl = document.getElementById('suggested-redirect-uri');
    if (suggestedEl) suggestedEl.textContent = suggestedUri;

    const redirectInput = document.getElementById('oidc-redirect-uri');
    if (redirectInput && !redirectInput.value) redirectInput.value = suggestedUri;

    document.getElementById('copy-redirect-uri-btn')?.addEventListener('click', () => {
      const val = document.getElementById('oidc-redirect-uri')?.value || suggestedUri;
      navigator.clipboard.writeText(val).then(() => {
        const btn = document.getElementById('copy-redirect-uri-btn');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      });
    });

    // Strip .well-known/openid-configuration if pasted by mistake
    document.getElementById('oidc-issuer-url')?.addEventListener('blur', e => {
      const v = e.target.value.trim().replace(/\/\.well-known\/openid-configuration\/?$/, '').replace(/\/$/, '');
      if (v !== e.target.value) e.target.value = v;
    });
  }

  // Auto-fill report bucket from account ID
  document.getElementById('account-id').addEventListener('input', e => {
    const bucketInput = document.getElementById('report-bucket');
    const id = e.target.value.trim();
    if (!bucketInput.dataset.userEdited) {
      bucketInput.value = id ? `b2-reports-${id}` : '';
    }
  });
  document.getElementById('report-bucket').addEventListener('input', e => {
    const accountId = document.getElementById('account-id').value.trim();
    const expected = accountId ? `b2-reports-${accountId}` : '';
    e.target.dataset.userEdited = e.target.value !== expected ? '1' : '';
  });

  if (canWrite) {
    loadScheduleCard();
  }
  loadDiskUsageCard();
}

async function loadDiskUsageCard() {
  const res = await api('/api/settings/disk-usage');
  if (!res?.ok) return;
  const data = await res.json();

  function fmt(bytes) {
    if (bytes >= 1_073_741_824) return (bytes / 1_073_741_824).toFixed(2) + ' GB';
    if (bytes >= 1_048_576)     return (bytes / 1_048_576).toFixed(1) + ' MB';
    if (bytes >= 1_024)         return (bytes / 1_024).toFixed(1) + ' KB';
    return bytes + ' B';
  }

  // Rough growth guidance
  const guidance = `
    <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
      <div style="font-size:0.8rem;font-weight:600;margin-bottom:8px;color:var(--text-muted)">WHAT TO EXPECT</div>
      <ul style="font-size:0.8rem;color:var(--text-muted);margin:0;padding-left:18px;line-height:1.8">
        <li><strong>Database</strong> — stays small (typically under 10 MB). Grows slowly with audit log entries and cached group metadata.</li>
        <li><strong>Report cache</strong> — grows with the number of groups and retention period. Rough estimate: ~5–50 KB per group per day. With 50 groups and 90-day retention, expect 20–200 MB.</li>
        <li>Configure <strong>Report Automation → Retention</strong> above to automatically purge old cached reports.</li>
      </ul>
    </div>`;

  const rowsHtml = data.entries.map(e => `
    <div style="display:flex;align-items:baseline;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-size:0.875rem;font-weight:500">${esc(e.label)}</div>
        <div style="font-size:0.78rem;color:var(--text-muted);margin-top:2px">${esc(e.description)}</div>
      </div>
      <div style="font-size:0.875rem;font-weight:600;white-space:nowrap;margin-left:24px">${fmt(e.bytes)}</div>
    </div>
  `).join('');

  const card = document.createElement('div');
  card.className = 'card';
  card.id = 'disk-usage-card';
  card.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
      <h3 style="margin:0">Local Disk Usage</h3>
      <span style="font-size:0.78rem;color:var(--text-muted)">${esc(data.data_dir)}</span>
    </div>
    <p class="text-muted" style="font-size:0.85rem;margin-bottom:16px">
      Storage used by the portal on this server.
    </p>
    ${rowsHtml}
    <div style="display:flex;justify-content:flex-end;padding-top:10px">
      <div style="font-size:0.875rem">
        <span style="color:var(--text-muted)">Total&nbsp;</span>
        <strong>${fmt(data.total_bytes)}</strong>
      </div>
    </div>
    ${guidance}
  `;

  // Append after the last card on the page
  document.getElementById('page-content').appendChild(card);
}

async function loadScheduleCard() {
  const card = document.getElementById('automation-card');
  if (!card) return;

  let sched = {};
  try {
    const res = await api('/api/reports/schedule');
    if (res?.ok) sched = await res.json();
  } catch (_) { /* schedule endpoint not available yet — show defaults */ }

  const lastRunHtml = sched.last_run_at ? `
    <div class="alert alert-info" style="font-size:0.82rem;margin-bottom:16px">
      Last run: ${esc(new Date(sched.last_run_at).toLocaleString())}
      ${sched.last_result
        ? ` — fetched ${sched.last_result.fetched}, skipped ${sched.last_result.skipped}, failed ${sched.last_result.failed}`
        : ''}
    </div>` : '';

  card.innerHTML = `
    <h3>Report Automation</h3>
    <p class="text-muted" style="font-size:0.85rem;margin-bottom:20px">
      Automatically fetch daily reports on a schedule and optionally purge old cached files.
      The scheduler runs server-side — no external cron job needed.
    </p>

    <div id="schedule-result"></div>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;margin-bottom:20px">
      <div class="form-group" style="margin:0">
        <label class="form-label">Auto-fetch</label>
        <label style="display:flex;align-items:center;gap:8px;margin-top:6px;cursor:pointer">
          <input type="checkbox" id="sched-enabled" ${sched.auto_fetch ? 'checked' : ''}>
          <span>Enable daily fetch</span>
        </label>
      </div>
      <div class="form-group" style="margin:0">
        <label class="form-label">Fetch time (server local)</label>
        <input type="time" id="sched-time" class="form-input" value="${esc(sched.fetch_time || '02:00')}">
      </div>
      <div class="form-group" style="margin:0">
        <label class="form-label">Lookback days</label>
        <input type="number" id="sched-lookback" class="form-input" min="1" max="30"
          value="${sched.lookback_days ?? 2}">
        <div class="form-hint">How many past days to attempt (re-fetches missing dates).</div>
      </div>
      <div class="form-group" style="margin:0">
        <label class="form-label">Retention (days)</label>
        <input type="number" id="sched-retention" class="form-input" min="0"
          value="${sched.retention_days ?? 90}">
        <div class="form-hint">Local cache lifetime. 0 = keep forever.</div>
      </div>
    </div>

    ${lastRunHtml}

    <div class="flex-gap">
      <button class="btn btn-primary" id="save-sched-btn">Save Schedule</button>
      <button class="btn" id="run-retention-btn">Run Cleanup Now</button>
    </div>
    <div id="retention-result" style="margin-top:12px"></div>
  `;

  card.querySelector('#save-sched-btn').addEventListener('click', saveSchedule);
  card.querySelector('#run-retention-btn').addEventListener('click', runRetention);
}

async function saveSettings() {
  const accountId = document.getElementById('account-id').value.trim();
  const keyId = document.getElementById('key-id').value.trim();
  const appKey = document.getElementById('app-key').value.trim();
  const reportBucket = document.getElementById('report-bucket').value.trim();
  const reportPrefix = document.getElementById('report-prefix').value.trim();
  const resultDiv = document.getElementById('settings-result');

  if (!accountId || !keyId || !appKey) {
    resultDiv.innerHTML = '<div class="alert alert-error">Account ID, Key ID, and Application Key are required.</div>';
    return;
  }

  const res = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      account_id: accountId,
      application_key_id: keyId,
      application_key: appKey,
      report_bucket: reportBucket || null,
      report_prefix: reportPrefix,
    }),
  });

  const data = await res?.json();
  if (res?.ok) {
    resultDiv.innerHTML = '<div class="alert alert-success">✅ Settings saved.</div>';
  } else {
    resultDiv.innerHTML = `<div class="alert alert-error">${esc(data?.detail || 'Save failed')}</div>`;
  }
}

async function testConnection() {
  const resultDiv = document.getElementById('test-result');
  resultDiv.innerHTML = '<div class="alert alert-info">Testing connection…</div>';

  const res = await api('/api/settings/test-connection', { method: 'POST' });
  const data = await res?.json();

  resultDiv.innerHTML = `
    <div class="alert alert-${data.success ? 'success' : 'error'}">
      ${data.success ? '✅' : '❌'} ${esc(data.message)}
    </div>
    ${renderApiInspector(data.b2_api_call)}
  `;
}

async function saveSchedule() {
  const resultDiv = document.getElementById('schedule-result');
  const enabled   = document.getElementById('sched-enabled').checked;
  const fetchTime = document.getElementById('sched-time').value;
  const lookback  = parseInt(document.getElementById('sched-lookback').value, 10);
  const retention = parseInt(document.getElementById('sched-retention').value, 10);

  if (!fetchTime.match(/^\d{2}:\d{2}$/)) {
    resultDiv.innerHTML = '<div class="alert alert-error">Invalid time format.</div>';
    return;
  }
  if (isNaN(lookback) || lookback < 1 || lookback > 30) {
    resultDiv.innerHTML = '<div class="alert alert-error">Lookback must be 1–30 days.</div>';
    return;
  }
  if (isNaN(retention) || retention < 0) {
    resultDiv.innerHTML = '<div class="alert alert-error">Retention must be 0 or more days.</div>';
    return;
  }

  const res = await api('/api/reports/schedule', {
    method: 'PUT',
    body: JSON.stringify({
      auto_fetch:     enabled,
      fetch_time:     fetchTime,
      lookback_days:  lookback,
      retention_days: retention,
    }),
  });

  if (res?.ok) {
    resultDiv.innerHTML = `<div class="alert alert-success">✅ Schedule saved.${enabled ? ` Fetches daily at ${fetchTime}.` : ' Auto-fetch disabled.'}</div>`;
  } else {
    const data = await res?.json();
    resultDiv.innerHTML = `<div class="alert alert-error">${esc(data?.detail || 'Save failed')}</div>`;
  }
}

async function runRetention() {
  const resultDiv = document.getElementById('retention-result');
  resultDiv.innerHTML = '<div class="alert alert-info">Running cleanup…</div>';

  const res  = await api('/api/reports/retention/enforce', { method: 'POST' });
  const data = await res?.json();

  if (res?.ok) {
    if (data.message) {
      resultDiv.innerHTML = `<div class="alert alert-info">${esc(data.message)}</div>`;
    } else {
      resultDiv.innerHTML = `<div class="alert alert-success">✅ Cleanup complete — removed ${data.deleted_dates} date(s), ${data.deleted_files} file(s).</div>`;
    }
  } else {
    resultDiv.innerHTML = `<div class="alert alert-error">${esc(data?.detail || 'Cleanup failed')}</div>`;
  }
}

// ── OIDC Settings ─────────────────────────────────────────────────────────────

async function saveOidcConfig() {
  const resultDiv = document.getElementById('oidc-result');
  const issuerUrl = document.getElementById('oidc-issuer-url').value.trim()
    .replace(/\/\.well-known\/openid-configuration\/?$/, '').replace(/\/$/, '');
  const res = await api('/api/auth/oidc/config', {
    method: 'PUT',
    body: JSON.stringify({
      enabled:         document.getElementById('oidc-enabled').checked,
      issuer_url:      issuerUrl,
      client_id:       document.getElementById('oidc-client-id').value.trim(),
      client_secret:   document.getElementById('oidc-client-secret').value,
      redirect_uri:    document.getElementById('oidc-redirect-uri').value.trim(),
      groups_claim:    document.getElementById('oidc-groups-claim').value.trim() || 'groups',
      button_label:    document.getElementById('oidc-button-label').value.trim() || 'Sign in with SSO',
      default_role_id: document.getElementById('oidc-default-role').value || null,
    }),
  });
  if (res?.ok) {
    resultDiv.innerHTML = '<div class="alert alert-success">✅ SSO settings saved.</div>';
    document.getElementById('oidc-client-secret').value = '';
  } else {
    const data = await res?.json();
    resultDiv.innerHTML = `<div class="alert alert-error">${esc(data?.detail || 'Save failed')}</div>`;
  }
}

let _mappings = [];

async function loadMappings() {
  const list = document.getElementById('oidc-mappings-list');
  if (!list) return;
  const res  = await api('/api/auth/oidc/mappings');
  _mappings  = res?.ok ? await res.json() : [];
  renderMappings();
}

function renderMappings() {
  const list = document.getElementById('oidc-mappings-list');
  if (!list) return;
  if (_mappings.length === 0) {
    list.innerHTML = '<p class="text-muted" style="font-size:0.85rem;margin:0 0 8px">No mappings yet. Add one below.</p>';
    return;
  }
  list.innerHTML = `
    <div class="card" style="padding:0;overflow:hidden;margin-bottom:4px">
      <table>
        <thead>
          <tr>
            <th style="width:32px"></th>
            <th>Group identifier</th>
            <th>Label</th>
            <th>Portal Role</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${_mappings.map((m, i) => `
            <tr data-id="${esc(m.id)}">
              <td style="text-align:center">
                <div style="display:flex;flex-direction:column;gap:2px">
                  <button class="btn btn-sm" onclick="moveMapping('${esc(m.id)}', -1)" ${i === 0 ? 'disabled' : ''} title="Move up">▲</button>
                  <button class="btn btn-sm" onclick="moveMapping('${esc(m.id)}', 1)" ${i === _mappings.length - 1 ? 'disabled' : ''} title="Move down">▼</button>
                </div>
              </td>
              <td style="font-family:monospace;font-size:0.8rem">${esc(m.group_id)}</td>
              <td style="font-size:0.85rem;color:var(--text-muted)">${esc(m.label || '–')}</td>
              <td><span class="badge badge-role">${esc(m.role_id)}</span></td>
              <td>
                <button class="btn btn-danger btn-sm" onclick="deleteMapping('${esc(m.id)}')">Remove</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="text-muted" style="font-size:0.78rem;margin:4px 0 0">First match wins. Higher in the list = higher priority.</p>
  `;
}

window.moveMapping = async function(id, direction) {
  const idx = _mappings.findIndex(m => m.id === id);
  if (idx < 0) return;
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= _mappings.length) return;
  [_mappings[idx], _mappings[swapIdx]] = [_mappings[swapIdx], _mappings[idx]];
  renderMappings();
  await api('/api/auth/oidc/mappings/reorder', {
    method: 'POST',
    body: JSON.stringify({ ordered_ids: _mappings.map(m => m.id) }),
  });
};

window.deleteMapping = async function(id) {
  await api(`/api/auth/oidc/mappings/${id}`, { method: 'DELETE' });
  _mappings = _mappings.filter(m => m.id !== id);
  renderMappings();
};

async function addMapping() {
  const groupId = document.getElementById('new-group-id').value.trim();
  const label   = document.getElementById('new-group-label').value.trim();
  const roleId  = document.getElementById('new-group-role').value;
  const result  = document.getElementById('add-mapping-result');

  if (!groupId) {
    result.innerHTML = '<div class="alert alert-error">Azure Group Object ID is required.</div>';
    return;
  }

  const res  = await api('/api/auth/oidc/mappings', {
    method: 'POST',
    body: JSON.stringify({ group_id: groupId, role_id: roleId, label }),
  });
  const data = await res?.json();

  if (res?.ok) {
    _mappings.push(data);
    renderMappings();
    document.getElementById('new-group-id').value    = '';
    document.getElementById('new-group-label').value = '';
    result.innerHTML = '';
  } else {
    result.innerHTML = `<div class="alert alert-error">${esc(data?.detail || 'Failed to add mapping')}</div>`;
  }
}
