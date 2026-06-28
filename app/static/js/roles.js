import { api, esc, fmtDate } from './app.js';

export async function renderRoles(page) {
  const res = await api('/api/roles');
  const roles = res?.ok ? await res.json() : [];

  page.innerHTML = `
    <div class="page-header flex-between">
      <div>
        <h1>Roles</h1>
        <p class="page-subtitle">Define permission sets — add new roles without code changes</p>
      </div>
      <button class="btn btn-primary" id="add-role-btn">+ New Role</button>
    </div>

    <div id="role-form-area"></div>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px">
      ${roles.map(r => roleCardHtml(r)).join('')}
    </div>
  `;

  document.getElementById('add-role-btn').addEventListener('click', () => showRoleForm());

  page.querySelectorAll('[data-delete-role]').forEach(btn => {
    btn.addEventListener('click', () => deleteRole(btn.dataset.deleteRole));
  });
}

function roleCardHtml(r) {
  const isBuiltin = r.id === 'admin' || r.id === 'viewer';
  return `
    <div class="card" id="role-card-${esc(r.id)}">
      <div class="flex-between" style="margin-bottom:12px">
        <div>
          <strong>${esc(r.name)}</strong>
          <span class="badge badge-role" style="margin-left:8px">${esc(r.id)}</span>
        </div>
        ${!isBuiltin ? `<button class="btn btn-danger btn-sm" data-delete-role="${esc(r.id)}">Delete</button>` : ''}
      </div>
      <p class="text-muted" style="font-size:0.8rem;margin-bottom:12px">${esc(r.description || '—')}</p>
      <div style="display:flex;flex-wrap:wrap;gap:4px">
        ${r.permissions.map(p => `<span class="badge" style="background:rgba(96,165,250,0.1);color:var(--info)">${esc(p)}</span>`).join('')}
      </div>
      <div style="margin-top:12px;font-size:0.72rem;color:var(--text-muted)">Created ${fmtDate(r.created_at)}</div>
    </div>
  `;
}

const ALL_PERMS = [
  'users:read','users:write','settings:read','settings:write',
  'groups:read','members:read','members:write','members:eject',
  'reports:read','roles:read','roles:write',
  'credentials:read','audit:read',
];

function showRoleForm(existing = null) {
  const area = document.getElementById('role-form-area');
  area.innerHTML = `
    <div class="card mb-4">
      <h3>${existing ? 'Edit Role' : 'New Role'}</h3>
      <div id="role-form-result"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:16px">
        <div class="form-group">
          <label class="form-label">Role ID (slug)</label>
          <input type="text" id="role-id" class="form-input" placeholder="billing"
            value="${esc(existing?.id || '')}" ${existing ? 'disabled' : ''}>
        </div>
        <div class="form-group">
          <label class="form-label">Display Name</label>
          <input type="text" id="role-name" class="form-input" placeholder="Billing Manager"
            value="${esc(existing?.name || '')}">
        </div>
        <div class="form-group">
          <label class="form-label">Description</label>
          <input type="text" id="role-desc" class="form-input" placeholder="Can view billing reports"
            value="${esc(existing?.description || '')}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Permissions</label>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">
          ${ALL_PERMS.map(p => `
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:0.8rem">
              <input type="checkbox" value="${p}" ${existing?.permissions.includes(p) ? 'checked' : ''}>
              ${p}
            </label>
          `).join('')}
        </div>
      </div>
      <div class="flex-gap">
        <button class="btn btn-primary" id="save-role-btn">
          ${existing ? 'Save Changes' : 'Create Role'}
        </button>
        <button class="btn" onclick="document.getElementById('role-form-area').innerHTML=''">Cancel</button>
      </div>
    </div>
  `;

  document.getElementById('save-role-btn').addEventListener('click', () => saveRole(existing));
}

async function saveRole(existing) {
  const id = document.getElementById('role-id').value.trim();
  const name = document.getElementById('role-name').value.trim();
  const description = document.getElementById('role-desc').value.trim();
  const permissions = [...document.querySelectorAll('#role-form-area input[type=checkbox]:checked')]
    .map(el => el.value);

  const resultDiv = document.getElementById('role-form-result');

  const url = existing ? `/api/roles/${existing.id}` : '/api/roles';
  const method = existing ? 'PATCH' : 'POST';
  const body = existing
    ? { name, description, permissions }
    : { id, name, description, permissions };

  const res = await api(url, { method, body: JSON.stringify(body) });
  const data = await res?.json();

  if (res?.ok) {
    resultDiv.innerHTML = `<div class="alert alert-success">✅ Role saved.</div>`;
    // Refresh page
    setTimeout(() => renderRoles(document.getElementById('page-content')), 800);
  } else {
    resultDiv.innerHTML = `<div class="alert alert-error">${esc(data?.detail || 'Failed')}</div>`;
  }
}

async function deleteRole(roleId) {
  if (!confirm(`Delete role "${roleId}"? This will fail if any users are assigned to it.`)) return;
  const res = await api(`/api/roles/${roleId}`, { method: 'DELETE' });
  const data = await res?.json().catch(() => ({}));
  if (res?.ok) {
    document.getElementById(`role-card-${roleId}`)?.remove();
  } else {
    const resultDiv = document.getElementById('role-form-result');
    if (resultDiv) resultDiv.innerHTML = `<div class="alert alert-error">${esc(data?.detail || 'Delete failed')}</div>`;
  }
}
