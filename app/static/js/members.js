import { api, esc, fmtDate, renderApiInspector, hasPermission, downloadCredentialsCsvFull } from './app.js';

function friendlyMemberError(detail) {
  if (!detail) return 'An unknown error occurred.';
  if (detail.includes('[invalid_sms_phone]'))
    return 'The Group Admin account must have a valid SMS phone number configured on backblaze.com before members can be created.';
  if (detail.includes('[too_many_members]'))
    return 'This group has reached the maximum of 5,000 members allowed by the Partner API.';
  if (detail.includes('[method_failure]'))
    return 'The Backblaze API reported a temporary failure. Please try again.';
  if (detail.includes('[expired_auth_token]'))
    return 'Authentication token expired. Please retry — the token has been refreshed.';
  // Strip code prefix like "[some_code] " for cleaner display
  return detail.replace(/^\[[^\]]+\]\s*/, '');
}

export async function renderMembers(page) {
  // Load groups for the selector
  const groupsRes = await api('/api/groups');
  const groupsData = groupsRes?.ok ? await groupsRes.json() : { groups: [] };

  // Check if a group was pre-selected via URL hash
  const params = new URLSearchParams(location.hash.includes('?') ? location.hash.split('?')[1] : '');
  const preSelected = params.get('group') || '';

  page.innerHTML = `
    <div class="page-header">
      <h1>Members</h1>
      <p class="page-subtitle">Backblaze Partner API — b2_list_group_members · b2_create_group_member · b2_eject_group_member</p>
    </div>

    <div class="card">
      <div class="flex-gap" style="flex-wrap:wrap">
        <div style="flex:1;min-width:240px">
          <label class="form-label">Select Group</label>
          <select id="group-select" class="form-select">
            <option value="">— choose a group —</option>
            ${groupsData.groups.map(g =>
              `<option value="${esc(g.group_id)}" ${g.group_id === preSelected ? 'selected' : ''}>${esc(g.group_name)}</option>`
            ).join('')}
          </select>
        </div>
        <div style="align-self:flex-end">
          <button class="btn btn-primary" id="load-btn">Load Members</button>
        </div>
        ${hasPermission('members:write') ? `
          <div style="align-self:flex-end;display:flex;gap:8px">
            <button class="btn" id="bulk-btn" disabled>⬆ Bulk Import CSV</button>
            <button class="btn" id="add-btn" disabled>+ Add Member</button>
          </div>` : ''}
      </div>
    </div>

    <div id="members-content"></div>
    <div id="add-member-form" style="display:none"></div>

    <!-- Bulk import modal -->
    <div id="bulk-modal" class="modal-overlay" style="display:none">
      <div class="modal" style="max-width:600px">
        <div class="modal-title">Bulk Import Members via Partner API</div>
        <p class="text-muted" style="margin-bottom:16px;font-size:0.85rem">
          CSV must have an <code>email</code> column. <code>region</code> is optional (defaults to <code>us-west</code>).<br>
          Valid regions: <code>us-west</code>, <code>us-east</code>, <code>eu-central</code>, <code>ca-east</code>.<br>
          Each row calls <code>b2_create_group_member</code> — credentials are returned in the results.
        </p>
        <pre class="api-code" style="margin-bottom:16px">email,region
alice@example.com,us-west
bob@example.com,ca-east</pre>
        <div class="form-group">
          <label class="form-label">CSV File</label>
          <input type="file" id="bulk-csv-file" accept=".csv,text/csv" class="form-input" style="padding:6px">
        </div>
        <div id="bulk-member-result"></div>
        <div class="modal-actions">
          <button class="btn" onclick="document.getElementById('bulk-modal').style.display='none'">Cancel</button>
          <button class="btn btn-primary" id="bulk-submit-btn">Import</button>
        </div>
      </div>
    </div>
  `;

  const loadBtn = document.getElementById('load-btn');
  const addBtn = document.getElementById('add-btn');
  const groupSelect = document.getElementById('group-select');

  const bulkBtn = document.getElementById('bulk-btn');

  loadBtn.addEventListener('click', () => {
    const gid = groupSelect.value;
    if (!gid) return;
    if (addBtn) addBtn.disabled = false;
    if (bulkBtn) bulkBtn.disabled = false;
    loadMembers(gid);
  });

  if (addBtn) {
    addBtn.addEventListener('click', () => showAddForm(groupSelect.value));
  }

  if (bulkBtn) {
    bulkBtn.addEventListener('click', () => {
      document.getElementById('bulk-member-result').innerHTML = '';
      document.getElementById('bulk-csv-file').value = '';
      document.getElementById('bulk-modal').style.display = 'flex';
    });
    document.getElementById('bulk-submit-btn').addEventListener('click', () => doBulkImport(groupSelect.value));
  }

  // Auto-load if pre-selected
  if (preSelected && groupsData.groups.find(g => g.group_id === preSelected)) {
    if (addBtn) addBtn.disabled = false;
    if (bulkBtn) bulkBtn.disabled = false;
    await loadMembers(preSelected);
  }
}

async function loadMembers(groupId, cursor = null) {
  const content = document.getElementById('members-content');
  content.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';

  const url = `/api/groups/${groupId}/members${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
  const res = await api(url);
  if (!res?.ok) {
    content.innerHTML = '<div class="alert alert-error">Failed to load members.</div>';
    return;
  }
  const data = await res.json();

  content.innerHTML = `
    <div class="flex-between mb-4">
      <h2 style="margin:0">${data.group_name ? esc(data.group_name) : 'Members'}</h2>
      <span class="text-muted" style="font-size:0.8rem">${data.members.length} member(s) shown &nbsp;·&nbsp; max 5,000 per group</span>
    </div>

    <div class="card" style="padding:0;overflow:hidden">
      ${data.members.length === 0
        ? '<div class="empty-state"><div class="icon">👥</div><p>No members found.</p></div>'
        : `<table>
            <thead>
              <tr>
                <th>Email</th><th>Account ID</th><th>Region</th><th>S3 Endpoint</th><th>B2 Storage</th>
                <th style="width:1%;white-space:nowrap">&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              ${data.members.map(m => {
                const b2 = m.raw?.b2Stats;
                const storedGb = b2 ? (b2.b2BytesStoredCount / 1e9).toFixed(2) + ' GB' : '–';
                const buckets = b2 ? `${b2.bucketCount} bucket${b2.bucketCount !== 1 ? 's' : ''}` : '';
                return `
                <tr>
                  <td>${esc(m.email)}</td>
                  <td class="text-muted" style="font-family:monospace;font-size:0.78rem">${esc(m.account_id)}</td>
                  <td><span class="badge badge-role">${esc(m.region)}</span></td>
                  <td class="text-muted" style="font-size:0.78rem">${esc(m.s3_endpoint || '–')}</td>
                  <td class="text-muted" style="font-size:0.78rem">${storedGb}${buckets ? `<br><span style="font-size:0.72rem">${esc(buckets)}</span>` : ''}</td>
                  <td style="white-space:nowrap">
                    <button class="btn btn-sm"
                      onclick="location.hash='reports?account_id=${esc(m.account_id)}'">
                      📈 Usage
                    </button>
                    ${hasPermission('credentials:read') ? `
                      <button class="btn btn-sm"
                        onclick="showVaultCredentials('${esc(m.account_id)}', '${esc(m.email)}')">
                        🔐 Credentials
                      </button>` : ''}
                    ${hasPermission('members:eject') ? `
                      <button class="btn btn-danger btn-sm"
                        onclick="ejectMember('${esc(groupId)}', '${esc(m.account_id)}', '${esc(m.email)}')">
                        Eject
                      </button>` : ''}
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>`}
    </div>

    ${data.next_cursor ? `
      <button class="btn" id="next-page-btn">Load More →</button>` : ''}

    ${renderApiInspector(data.b2_api_call)}
  `;

  if (data.next_cursor) {
    document.getElementById('next-page-btn')?.addEventListener('click', () => {
      loadMembers(groupId, data.next_cursor);
    });
  }

  window.ejectMember = (groupId, accountId, email) => showEjectModal(groupId, accountId, email);
  window.showVaultCredentials = (accountId, email) => showVaultModal(accountId, email);
}

function showEjectModal(groupId, accountId, currentEmail) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:520px">
      <div class="modal-title">Eject Member</div>

      <div class="alert alert-warning" style="margin-bottom:16px">
        <strong>This action has permanent consequences:</strong>
        <ul style="margin:8px 0 0 16px;line-height:1.8">
          <li>The member will be removed from this group immediately.</li>
          <li>They cannot be re-added via the Partner API — only re-invited via the Backblaze web UI.</li>
          <li>If re-invited later, their email address cannot be changed again.</li>
          <li>They will be required to reset their password and agree to the Backblaze Terms of Service on next login.</li>
        </ul>
      </div>

      <div class="form-group">
        <label class="form-label">Member being ejected</label>
        <input type="text" class="form-input" value="${esc(currentEmail)}" disabled>
      </div>

      <div class="form-group">
        <label class="form-label">Change email on ejection <span style="color:var(--text-muted);font-weight:400;text-transform:none">(optional)</span></label>
        <input type="email" id="eject-new-email" class="form-input"
          placeholder="Leave blank to keep current email">
        <div class="form-hint">
          If provided, the member's email will be changed to this address upon ejection.
          Must be a valid email that does not already exist as a Backblaze account.
        </div>
      </div>

      <div class="form-group">
        <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:0.85rem">
          <input type="checkbox" id="eject-confirm-check" style="margin-top:3px;flex-shrink:0">
          <span>I confirm the email address is valid and I understand this action cannot be undone via the API.</span>
        </label>
      </div>

      <div id="eject-result"></div>

      <div class="modal-actions">
        <button class="btn" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn btn-danger" id="eject-confirm-btn" disabled>Eject Member</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const confirmCheck = overlay.querySelector('#eject-confirm-check');
  const confirmBtn   = overlay.querySelector('#eject-confirm-btn');
  confirmCheck.addEventListener('change', () => { confirmBtn.disabled = !confirmCheck.checked; });

  confirmBtn.addEventListener('click', async () => {
    const newEmail = overlay.querySelector('#eject-new-email').value.trim() || null;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Ejecting…';
    await doEject(groupId, accountId, newEmail, overlay);
  });
}

async function doEject(groupId, accountId, newEmail, overlay) {
  const res = await api(`/api/groups/${groupId}/members/${accountId}`, {
    method: 'DELETE',
    body: JSON.stringify({ email: newEmail }),
  });
  const data = await res?.json();
  if (!res?.ok) {
    const resultDiv = overlay?.querySelector('#eject-result');
    if (resultDiv) {
      resultDiv.innerHTML = `<div class="alert alert-error">${esc(data?.detail || 'Eject failed.')}</div>`;
      overlay.querySelector('#eject-confirm-btn').disabled = false;
      overlay.querySelector('#eject-confirm-btn').textContent = 'Eject Member';
    }
    return;
  }

  // Replace modal content with success state
  overlay.querySelector('.modal').innerHTML = `
    <div class="modal-title">✅ Member Ejected</div>
    <p style="margin-bottom:16px">${esc(data.message)}</p>
    ${renderApiInspector(data.b2_api_call)}
    <div class="modal-actions">
      <button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove(); document.getElementById('load-btn').click()">
        Reload Members
      </button>
    </div>
  `;
}

async function doBulkImport(groupId) {
  const file = document.getElementById('bulk-csv-file')?.files?.[0];
  if (!file) return;
  const resultDiv = document.getElementById('bulk-member-result');
  resultDiv.innerHTML = '<div class="spinner"></div>';

  const form = new FormData();
  form.append('file', file);

  const token = localStorage.getItem('access_token');
  const res = await fetch(`/api/groups/${groupId}/members/bulk`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const data = await res?.json();

  if (!res?.ok) {
    resultDiv.innerHTML = `<div class="alert alert-error">${esc(friendlyMemberError(data?.detail || 'Import failed'))}</div>`;
    return;
  }

  const rows = data.results.map(r => `
    <tr>
      <td>${esc(r.email)}</td>
      <td><span class="badge badge-role">${esc(r.region)}</span></td>
      <td>${r.success
        ? '<span class="badge badge-active">Created</span>'
        : '<span class="badge badge-inactive">Failed</span>'}</td>
      <td style="font-family:monospace;font-size:0.75rem">${r.success
        ? `<div>${esc(r.account_id || '')}</div><div style="color:var(--text-muted)">KeyID: ${esc(r.application_key_id || '')}</div><div style="color:var(--warning)">Key: ${esc(r.application_key || '')}</div>`
        : esc(friendlyMemberError(r.error || ''))}</td>
    </tr>
  `).join('');

  const succeeded = data.results.filter(r => r.success);

  resultDiv.innerHTML = `
    <div class="alert alert-${data.failed === 0 ? 'success' : 'warning'}">
      ✅ Created: <strong>${data.created}</strong> &nbsp; Failed: <strong>${data.failed}</strong>
    </div>
    ${succeeded.length > 0 ? `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <p class="text-muted" style="font-size:0.8rem;margin:0">⚠️ <strong>Save the application keys below</strong> — they will not be shown again.</p>
        <button class="btn btn-sm" id="bulk-download-btn">⬇ Download All Credentials CSV</button>
      </div>` : ''}
    <div style="overflow-x:auto">
      <table>
        <thead><tr><th>Email</th><th>Region</th><th>Status</th><th>Credentials / Error</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  // Replace Cancel/Import buttons with a single Done button
  const modalActions = document.querySelector('#bulk-modal .modal-actions');
  if (modalActions) {
    modalActions.innerHTML = `
      <button class="btn btn-primary" onclick="document.getElementById('bulk-modal').style.display='none'">Done</button>
    `;
  }

  if (succeeded.length > 0) {
    resultDiv.querySelector('#bulk-download-btn').addEventListener('click', () => {
      const csvRows = [
        ['Account ID', 'Email', 'Region', 'S3 Endpoint', 'Application Key ID', 'Application Key'],
        ...succeeded.map(r => [r.account_id, r.email, r.region, r.s3_endpoint || '', r.application_key_id, r.application_key]),
      ];
      const csv  = csvRows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `b2-bulk-credentials-${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }
}

async function showVaultModal(accountId, email) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:540px">
      <div class="modal-title">🔐 Stored Credentials</div>
      <p style="margin:0 0 16px;font-size:0.85rem;color:var(--text-muted)">${esc(email)} · <code>${esc(accountId)}</code></p>
      <div id="vault-modal-body"><div class="empty-state"><div class="spinner"></div></div></div>
      <div class="modal-actions">
        <button class="btn" onclick="this.closest('.modal-overlay').remove()">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const body = overlay.querySelector('#vault-modal-body');
  const res  = await api(`/api/credentials/${encodeURIComponent(accountId)}`);
  const data = await res?.json();

  if (!res?.ok) {
    const msg = res?.status === 404
      ? 'No stored credentials found for this member.'
      : esc(data?.detail || 'An error occurred.');
    body.innerHTML = `<div class="alert alert-error">${msg}</div>`;
    return;
  }

  body.innerHTML = `
    <div class="alert alert-warning" style="margin-bottom:16px;font-size:0.82rem">
      ⚠️ This lookup has been recorded in the audit log.
    </div>
    <table style="width:100%;border:none;margin-bottom:16px">
      <tbody>
        ${data.region ? `<tr>
          <td style="width:120px;padding:5px 0;color:var(--text-muted);font-size:0.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Region</td>
          <td style="padding:5px 0;font-size:0.83rem">${esc(data.region)}</td>
        </tr>` : ''}
        ${data.s3_endpoint ? `<tr>
          <td style="padding:5px 0;color:var(--text-muted);font-size:0.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em">S3 Endpoint</td>
          <td style="padding:5px 0;font-family:monospace;font-size:0.83rem">${esc(data.s3_endpoint)}</td>
        </tr>` : ''}
        <tr>
          <td style="width:120px;padding:5px 0;color:var(--text-muted);font-size:0.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Key ID</td>
          <td style="padding:5px 0;font-family:monospace;font-size:0.83rem">${esc(data.application_key_id)}</td>
        </tr>
        <tr>
          <td style="padding:5px 0;color:var(--text-muted);font-size:0.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em">App Key</td>
          <td style="padding:5px 0;font-family:monospace;font-size:0.83rem">${esc(data.application_key)}</td>
        </tr>
        <tr>
          <td style="padding:5px 0;color:var(--text-muted);font-size:0.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Stored</td>
          <td style="padding:5px 0;font-size:0.83rem;color:var(--text-muted)">${fmtDate(data.created_at)}</td>
        </tr>
      </tbody>
    </table>
    <button class="btn btn-sm" id="vault-modal-download-btn">⬇ Download CSV</button>
  `;

  overlay.querySelector('#vault-modal-download-btn').addEventListener('click', () => {
    downloadCredentialsCsvFull({
      accountId:        data.member_account_id,
      email:            data.account_email,
      region:           data.region,
      s3Endpoint:       data.s3_endpoint,
      applicationKeyId: data.application_key_id,
      applicationKey:   data.application_key,
    });
  });
}

async function showAddForm(groupId) {
  const formDiv = document.getElementById('add-member-form');
  formDiv.style.display = 'block';
  formDiv.innerHTML = `
    <div class="card">
      <h3>Add New Member — b2_create_group_member</h3>
      <div id="add-result"></div>
      <div class="form-group">
        <label class="form-label">Email</label>
        <input type="email" id="new-email" class="form-input" placeholder="user@example.com">
      </div>
      <div class="form-group">
        <label class="form-label">Region</label>
        <select id="new-region" class="form-select">
          <option value="us-west">us-west</option>
          <option value="us-east">us-east</option>
          <option value="eu-central">eu-central</option>
          <option value="ca-east">ca-east</option>
        </select>
        <div class="form-hint">The B2 data residency region for this account. Groups support up to 5,000 members.</div>
      </div>
      <div class="flex-gap">
        <button class="btn btn-primary" id="submit-add-btn">Create Member</button>
        <button class="btn" id="cancel-add-member-btn">Cancel</button>
      </div>
    </div>
  `;

  document.getElementById('cancel-add-member-btn').addEventListener('click', () => {
    document.getElementById('add-member-form').style.display = 'none';
  });

  document.getElementById('submit-add-btn').addEventListener('click', async () => {
    const email = document.getElementById('new-email').value.trim();
    const region = document.getElementById('new-region').value;
    if (!email) return;

    const res = await api(`/api/groups/${groupId}/members`, {
      method: 'POST',
      body: JSON.stringify({ email, region }),
    });
    const data = await res?.json();
    const resultDiv = document.getElementById('add-result');

    if (!res?.ok) {
      resultDiv.innerHTML = `<div class="alert alert-error">${esc(friendlyMemberError(data?.detail))}</div>`;
      return;
    }

    resultDiv.innerHTML = `
      <div class="alert alert-success">✅ Member created: ${esc(data.member.email)}</div>
      <div class="alert alert-warning">
        ⚠️ <strong>Save these credentials now</strong> — they will not be shown again.<br>
        <strong>Application Key ID:</strong> <code>${esc(data.credentials.application_key_id)}</code><br>
        <strong>Application Key:</strong> <code>${esc(data.credentials.application_key)}</code>
      </div>
      <button class="btn btn-sm" id="create-download-btn" style="margin-bottom:16px">⬇ Download Credentials CSV</button>
      ${renderApiInspector(data.b2_api_call)}
    `;
    resultDiv.querySelector('#create-download-btn').addEventListener('click', () => {
      downloadCredentialsCsvFull({
        accountId:        data.member.account_id,
        email:            data.member.email,
        region:           data.member.region,
        s3Endpoint:       data.member.s3_endpoint,
        applicationKeyId: data.credentials.application_key_id,
        applicationKey:   data.credentials.application_key,
      });
    });
  });
}
