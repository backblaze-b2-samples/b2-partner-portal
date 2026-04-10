import { api, esc, fmtDate } from './app.js';

const ACTION_LABELS = {
  'auth.login':                   { label: 'Login',                   color: 'var(--text-muted)' },
  'auth.login_failed':            { label: 'Failed Login',            color: 'var(--danger)'  },
  'member.create':                { label: 'Member Created',          color: 'var(--success)' },
  'member.eject':                 { label: 'Member Ejected',          color: 'var(--danger)'  },
  'credentials.retrieve':         { label: 'Credentials Viewed',      color: 'var(--warning)' },
  'user.create':                  { label: 'User Created',            color: 'var(--success)' },
  'user.update':                  { label: 'User Updated',            color: 'var(--info)'    },
  'user.deactivate':              { label: 'User Deactivated',        color: 'var(--danger)'  },
  'user.bulk_import':             { label: 'Bulk User Import',        color: 'var(--info)'    },
  'user.password_reset_issued':   { label: 'Password Reset Issued',   color: 'var(--warning)' },
  'user.password_reset_complete': { label: 'Password Reset Complete', color: 'var(--text-muted)' },
};

function actionBadge(action) {
  const a = ACTION_LABELS[action];
  const color = a?.color ?? 'var(--text-muted)';
  const label = a?.label ?? esc(action);
  return `<span style="color:${color};font-weight:500;font-size:0.8rem">${label}</span>`;
}

export async function renderAudit(page) {
  page.innerHTML = `
    <div class="page-header flex-between">
      <div>
        <h1>Audit Log</h1>
        <p class="page-subtitle">All member and credential actions taken through this portal</p>
      </div>
      <button class="btn" id="export-btn">⬇ Export CSV</button>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="flex-gap" style="flex-wrap:wrap">
        <div>
          <label class="form-label">Action</label>
          <select id="filter-action" class="form-select" style="min-width:180px">
            <option value="">All actions</option>
            <optgroup label="Auth">
              <option value="auth.login">Login</option>
              <option value="auth.login_failed">Failed Login</option>
            </optgroup>
            <optgroup label="Members">
              <option value="member.create">Member Created</option>
              <option value="member.eject">Member Ejected</option>
              <option value="credentials.retrieve">Credentials Viewed</option>
            </optgroup>
            <optgroup label="Portal Users">
              <option value="user.create">User Created</option>
              <option value="user.update">User Updated</option>
              <option value="user.deactivate">User Deactivated</option>
              <option value="user.bulk_import">Bulk User Import</option>
              <option value="user.password_reset_issued">Password Reset Issued</option>
              <option value="user.password_reset_complete">Password Reset Complete</option>
            </optgroup>
          </select>
        </div>
        <div>
          <label class="form-label">User email</label>
          <input id="filter-email" class="form-input" placeholder="Search…" style="width:180px">
        </div>
        <div>
          <label class="form-label">From</label>
          <input id="filter-since" type="date" class="form-input">
        </div>
        <div>
          <label class="form-label">To</label>
          <input id="filter-until" type="date" class="form-input">
        </div>
        <div style="align-self:flex-end">
          <button class="btn btn-primary" id="apply-btn">Apply</button>
          <button class="btn" id="clear-btn" style="margin-left:6px">Clear</button>
        </div>
      </div>
    </div>

    <div id="audit-content"></div>
  `;

  const content = page.querySelector('#audit-content');

  function filters() {
    return {
      action:     page.querySelector('#filter-action').value,
      user_email: page.querySelector('#filter-email').value.trim(),
      since:      page.querySelector('#filter-since').value,
      until:      page.querySelector('#filter-until').value,
    };
  }

  async function load(offset = 0) {
    content.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
    const f = filters();
    const params = new URLSearchParams({ limit: 200, offset });
    if (f.action)     params.set('action', f.action);
    if (f.user_email) params.set('user_email', f.user_email);
    if (f.since)      params.set('since', f.since);
    if (f.until)      params.set('until', f.until);

    const res  = await api(`/api/audit?${params}`);
    const data = await res?.json();

    if (!res?.ok) {
      content.innerHTML = `<div class="alert alert-error">${esc(data?.detail || 'Failed to load audit log.')}</div>`;
      return;
    }

    if (data.entries.length === 0) {
      content.innerHTML = '<div class="empty-state"><div class="icon">📋</div><p>No entries match your filters.</p></div>';
      return;
    }

    const rows = data.entries.map(e => {
      const details = Object.entries(e.details || {})
        .filter(([k]) => k !== 'vault_access')
        .map(([k, v]) => `<span style="color:var(--text-muted)">${esc(k)}:</span> ${esc(String(v))}`)
        .join(' &nbsp;·&nbsp; ');
      return `
        <tr>
          <td style="white-space:nowrap;font-size:0.78rem;color:var(--text-muted)">${esc(fmtDate(e.occurred_at))}</td>
          <td style="font-size:0.82rem">${esc(e.user_email || '—')}</td>
          <td>${actionBadge(e.action)}</td>
          <td style="font-family:monospace;font-size:0.75rem;color:var(--text-muted)">${esc(e.target_id || '—')}</td>
          <td style="font-size:0.78rem;color:var(--text-muted)">${details}</td>
          <td style="font-size:0.78rem;color:var(--text-muted)">${esc(e.ip_address || '—')}</td>
        </tr>`;
    }).join('');

    const showing = offset + data.entries.length;
    content.innerHTML = `
      <div style="margin-bottom:8px;font-size:0.8rem;color:var(--text-muted)">
        Showing ${offset + 1}–${showing} of ${data.total.toLocaleString()} entries
      </div>
      <div class="card" style="padding:0;overflow:hidden">
        <table>
          <thead>
            <tr>
              <th>When</th><th>User</th><th>Action</th><th>Account ID</th><th>Details</th><th>IP</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${data.total > showing ? `
        <button class="btn" id="load-more-btn" style="margin-top:12px" data-offset="${showing}">
          Load more (${data.total - showing} remaining)
        </button>` : ''}
    `;

    page.querySelector('#load-more-btn')?.addEventListener('click', e => {
      load(parseInt(e.target.dataset.offset));
    });
  }

  page.querySelector('#apply-btn').addEventListener('click', () => load(0));
  page.querySelector('#clear-btn').addEventListener('click', () => {
    page.querySelector('#filter-action').value = '';
    page.querySelector('#filter-email').value  = '';
    page.querySelector('#filter-since').value  = '';
    page.querySelector('#filter-until').value  = '';
    load(0);
  });
  page.querySelector('#filter-email').addEventListener('keydown', e => {
    if (e.key === 'Enter') load(0);
  });

  page.querySelector('#export-btn').addEventListener('click', () => {
    const f = filters();
    const params = new URLSearchParams();
    if (f.action)     params.set('action', f.action);
    if (f.user_email) params.set('user_email', f.user_email);
    if (f.since)      params.set('since', f.since);
    if (f.until)      params.set('until', f.until);
    const token = localStorage.getItem('access_token');
    // Fetch as blob so we can pass the auth header
    api(`/api/audit/export?${params}`)
      .then(r => r?.blob())
      .then(blob => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href     = url;
        a.download = 'audit_log.csv';
        a.click();
        URL.revokeObjectURL(url);
      });
  });

  await load(0);
}
