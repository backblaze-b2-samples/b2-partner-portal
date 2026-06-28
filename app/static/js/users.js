import { api, esc, fmtDate, hasPermission } from './app.js';

export async function renderUsers(page) {
  const [usersRes, rolesRes] = await Promise.all([api('/api/users'), api('/api/roles')]);
  const users = usersRes?.ok ? await usersRes.json() : [];
  const roles = rolesRes?.ok ? await rolesRes.json() : [];

  const inactive = users.filter(u => !u.is_active);

  page.innerHTML = `
    <div class="page-header flex-between">
      <div>
        <h1>Portal Users</h1>
        <p class="page-subtitle">Manage who can access this portal and their roles</p>
      </div>
      ${hasPermission('users:write') ? `
        <div class="flex-gap">
          <button class="btn" id="bulk-btn">⬆ Bulk Import CSV</button>
          <button class="btn btn-primary" id="add-user-btn">+ Add User</button>
        </div>` : ''}
    </div>

    <div id="user-form-area"></div>

    <div class="card" style="padding:0;overflow:hidden">
      <table>
        <thead>
          <tr><th>Email</th><th>Role</th><th>Status</th><th>Auth</th><th>Created</th><th>Last Login</th>
            ${hasPermission('users:write') ? '<th></th>' : ''}
          </tr>
        </thead>
        <tbody id="users-tbody">
          ${users.filter(u => u.is_active).map(u => userRowHtml(u)).join('')}
          ${inactive.map(u => userRowHtml(u, true)).join('')}
        </tbody>
      </table>
    </div>

    ${inactive.length > 0 ? `
      <div style="margin-top:8px;text-align:right">
        <button class="btn btn-sm" id="toggle-inactive-btn">
          Show removed users (${inactive.length})
        </button>
      </div>` : ''}

    <!-- Bulk import modal -->
    <div id="bulk-modal" class="modal-overlay" style="display:none">
      <div class="modal">
        <div class="modal-title">Bulk Import Users from CSV</div>
        <p class="text-muted" style="margin-bottom:16px;font-size:0.85rem">
          CSV must have <code>email</code> and <code>role</code> columns.<br>
          Optionally include a <code>password</code> column. If omitted, a random password is generated.
        </p>
        <pre class="api-code" style="margin-bottom:16px">email,role,password
alice@example.com,admin,secret123
bob@example.com,viewer,</pre>
        <div class="form-group">
          <label class="form-label">CSV File</label>
          <input type="file" id="csv-file" accept=".csv,text/csv" class="form-input" style="padding:6px">
        </div>
        <div id="bulk-result"></div>
        <div class="modal-actions">
          <button class="btn" onclick="document.getElementById('bulk-modal').style.display='none'">Cancel</button>
          <button class="btn btn-primary" id="bulk-submit-btn">Import</button>
        </div>
      </div>
    </div>
  `;

  // Hide inactive rows by default
  document.querySelectorAll('.user-row-inactive').forEach(r => r.style.display = 'none');

  document.getElementById('toggle-inactive-btn')?.addEventListener('click', (e) => {
    const rows = document.querySelectorAll('.user-row-inactive');
    const showing = rows[0]?.style.display !== 'none';
    rows.forEach(r => r.style.display = showing ? 'none' : '');
    e.target.textContent = showing
      ? `Show removed users (${inactive.length})`
      : `Hide removed users`;
  });

  if (hasPermission('users:write')) {
    document.getElementById('add-user-btn').addEventListener('click', () => showAddForm(roles));
    document.getElementById('bulk-btn').addEventListener('click', () => {
      document.getElementById('bulk-modal').style.display = 'flex';
    });
    document.getElementById('bulk-submit-btn').addEventListener('click', doBulkImport);
    wireUserActions();
  }
}

function userRowHtml(u, isInactive = false) {
  const roleBadge = `<span class="badge badge-role">${esc(u.role_name)}</span>`;
  const statusBadge = u.is_active
    ? '<span class="badge badge-active">Active</span>'
    : '<span class="badge badge-inactive">Removed</span>';
  const authBadge = u.auth_source === 'sso'
    ? '<span class="badge" style="background:var(--info-bg,#e8f4fd);color:var(--info,#1a73e8)">SSO</span>'
    : '<span class="badge" style="background:var(--bg-secondary,#f5f5f5);color:var(--text-muted)">Local</span>';
  return `
    <tr id="user-row-${esc(u.id)}" ${isInactive ? 'class="user-row-inactive"' : ''}>
      <td>${esc(u.email)}</td>
      <td>${roleBadge}</td>
      <td>${statusBadge}</td>
      <td>${authBadge}</td>
      <td class="text-muted" style="font-size:0.78rem">${fmtDate(u.created_at)}</td>
      <td class="text-muted" style="font-size:0.78rem">${fmtDate(u.last_login_at)}</td>
      ${hasPermission('users:write') ? `
        <td style="white-space:nowrap">
          ${u.is_active ? `
            ${u.auth_source !== 'sso' ? `<button class="btn btn-sm" data-action="reset-pwd" data-uid="${esc(u.id)}" data-email="${esc(u.email)}">Reset Pwd</button>` : ''}
            <button class="btn btn-danger btn-sm" data-action="remove-user" data-uid="${esc(u.id)}" data-email="${esc(u.email)}">Remove</button>
          ` : `
            <button class="btn btn-sm" data-action="restore-user" data-uid="${esc(u.id)}">Restore</button>
          `}
        </td>` : ''}
    </tr>
  `;
}

function showAddForm(roles) {
  const area = document.getElementById('user-form-area');
  area.innerHTML = `
    <div class="card mb-4">
      <h3>Add New Portal User</h3>
      <div id="add-user-result"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px">
        <div class="form-group">
          <label class="form-label">Email</label>
          <input type="email" id="new-user-email" class="form-input" placeholder="user@example.com">
        </div>
        <div class="form-group">
          <label class="form-label">Password</label>
          <input type="password" id="new-user-pwd" class="form-input" placeholder="••••••••">
        </div>
        <div class="form-group">
          <label class="form-label">Role</label>
          <select id="new-user-role" class="form-select">
            ${roles.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="flex-gap">
        <button class="btn btn-primary" id="create-user-btn">Create User</button>
        <button class="btn" onclick="document.getElementById('user-form-area').innerHTML=''">Cancel</button>
      </div>
    </div>
  `;
  document.getElementById('create-user-btn').addEventListener('click', doCreateUser);
}

async function doCreateUser() {
  const email = document.getElementById('new-user-email')?.value?.trim();
  const password = document.getElementById('new-user-pwd')?.value;
  const role_id = document.getElementById('new-user-role')?.value;
  const resultDiv = document.getElementById('add-user-result');

  const res = await api('/api/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, role_id }),
  });
  const data = await res?.json();
  if (res?.ok) {
    resultDiv.innerHTML = `<div class="alert alert-success">✅ User created: ${esc(data.email)}</div>`;
    // Append new row to table
    const tbody = document.getElementById('users-tbody');
    if (tbody) tbody.insertAdjacentHTML('afterbegin', userRowHtml(data));
  } else {
    resultDiv.innerHTML = `<div class="alert alert-error">${esc(data?.detail || 'Failed')}</div>`;
  }
}

async function doBulkImport() {
  const file = document.getElementById('csv-file')?.files?.[0];
  if (!file) return;
  const resultDiv = document.getElementById('bulk-result');
  resultDiv.innerHTML = '<div class="spinner"></div>';

  const form = new FormData();
  form.append('file', file);

  const token = localStorage.getItem('access_token');
  const res = await fetch('/api/users/bulk-import', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const data = await res?.json();
  if (res?.ok) {
    resultDiv.innerHTML = `
      <div class="alert alert-success">
        ✅ Created: <strong>${data.created}</strong> &nbsp;
        Skipped: <strong>${data.skipped}</strong>
        ${data.errors.length ? `&nbsp; Errors: <strong>${data.errors.length}</strong>` : ''}
      </div>
      ${data.errors.length ? `<pre class="api-code">${esc(JSON.stringify(data.errors, null, 2))}</pre>` : ''}
    `;
  } else {
    resultDiv.innerHTML = `<div class="alert alert-error">${esc(data?.detail || 'Import failed')}</div>`;
  }

  const modalActions = document.querySelector('#bulk-modal .modal-actions');
  if (modalActions) {
    modalActions.innerHTML = `
      <button class="btn btn-primary" onclick="document.getElementById('bulk-modal').style.display='none'">Done</button>
    `;
  }
}

function wireUserActions() {
  const tbody = document.getElementById('users-tbody');
  if (!tbody || tbody._wired) return;
  tbody._wired = true;
  tbody.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, uid, email } = btn.dataset;
    if (action === 'reset-pwd')    resetPwd(uid, email);
    if (action === 'remove-user')  removeUser(uid, email);
    if (action === 'restore-user') restoreUser(uid);
  });
}

function removeUser(userId, email) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:460px">
        <div class="modal-title">Remove Portal User</div>
        <p style="margin-bottom:16px;font-size:0.875rem">
          Remove <strong>${esc(email)}</strong> from the portal?
        </p>
        <div class="alert alert-warning" style="margin-bottom:16px;font-size:0.82rem">
          This will immediately revoke all active sessions. The user's audit history
          is preserved. You can restore their access at any time.
        </div>
        <div id="remove-user-error"></div>
        <div class="modal-actions">
          <button class="btn" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button class="btn btn-danger" id="confirm-remove-btn">Remove User</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#confirm-remove-btn').addEventListener('click', async () => {
      const btn = overlay.querySelector('#confirm-remove-btn');
      btn.disabled = true;
      btn.textContent = 'Removing…';

      const res = await api(`/api/users/${userId}`, { method: 'DELETE' });
      if (res?.ok) {
        overlay.remove();
        const row = document.getElementById(`user-row-${userId}`);
        if (row) {
          row.classList.add('user-row-inactive');
          row.style.display = 'none';
          row.outerHTML = row.outerHTML.replace(
            /userRowHtml called inline/,  // placeholder — just re-render
            '',
          );
          // Re-render row as removed
          const newRow = document.getElementById(`user-row-${userId}`);
          if (newRow) newRow.outerHTML = userRowHtml({ id: userId, email, role_name: '—', is_active: false, created_at: null, last_login_at: null }, true);
        }
        // Update the toggle button count
        const inactiveRows = document.querySelectorAll('.user-row-inactive');
        const toggleBtn = document.getElementById('toggle-inactive-btn');
        if (toggleBtn) {
          toggleBtn.textContent = `Show removed users (${inactiveRows.length})`;
        } else if (inactiveRows.length === 1) {
          // First removed user — insert the toggle button
          const card = document.querySelector('.card');
          card?.insertAdjacentHTML('afterend', `
            <div style="margin-top:8px;text-align:right">
              <button class="btn btn-sm" id="toggle-inactive-btn">
                Show removed users (1)
              </button>
            </div>`);
          document.getElementById('toggle-inactive-btn')?.addEventListener('click', (e) => {
            const rows = document.querySelectorAll('.user-row-inactive');
            const showing = rows[0]?.style.display !== 'none';
            rows.forEach(r => r.style.display = showing ? 'none' : '');
            e.target.textContent = showing ? `Show removed users (${rows.length})` : 'Hide removed users';
          });
        }
      } else {
        const data = await res?.json();
        overlay.querySelector('#remove-user-error').innerHTML =
          `<div class="alert alert-error">${esc(data?.detail || 'Failed to remove user.')}</div>`;
        btn.disabled = false;
        btn.textContent = 'Remove User';
      }
    });
}

async function restoreUser(userId) {
  const res = await api(`/api/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ is_active: true }),
  });
  if (res?.ok) {
    const data = await res.json();
    const row = document.getElementById(`user-row-${userId}`);
    if (row) row.outerHTML = userRowHtml(data, false);
    // Event delegation on tbody still covers the replaced row — no re-wiring needed
    const inactiveRows = document.querySelectorAll('.user-row-inactive');
    const toggleBtn = document.getElementById('toggle-inactive-btn');
    if (toggleBtn) {
      if (inactiveRows.length === 0) toggleBtn.closest('div').remove();
      else toggleBtn.textContent = `Show removed users (${inactiveRows.length})`;
    }
  }
}

async function resetPwd(userId, email) {
  if (!confirm(`Generate a password reset link for ${email}?`)) return;
  const res = await api(`/api/users/${userId}/reset-password`, { method: 'POST' });
  const data = await res?.json();
  if (res?.ok) {
    const fullUrl = `${location.origin}${data.reset_url}`;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:560px">
        <div class="modal-title">Password Reset Link</div>
        <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:16px">
          Send this link to <strong>${esc(email)}</strong> out-of-band (email, Slack, etc.).
          It expires in <strong>1 hour</strong> and can only be used once.
        </p>
        <div class="alert alert-warning" style="font-size:0.82rem;margin-bottom:16px">
          ⚠️ Do not share this link in a channel where others can see it.
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="text" class="form-input" id="reset-url-input"
            value="${esc(fullUrl)}" readonly style="font-family:monospace;font-size:0.8rem;flex:1">
          <button class="btn" id="copy-reset-btn">Copy</button>
        </div>
        <div class="modal-actions" style="margin-top:20px">
          <button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove()">Done</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#reset-url-input').select();
    overlay.querySelector('#copy-reset-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(fullUrl).then(() => {
        overlay.querySelector('#copy-reset-btn').textContent = 'Copied!';
      });
    });
  }
}
