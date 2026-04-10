import { api, esc, fmtDate, renderApiInspector } from './app.js';

export async function renderGroups(page) {
  page.innerHTML = `
    <div class="page-header flex-between">
      <div>
        <h1>Groups</h1>
        <p class="page-subtitle">Backblaze Partner API — b2_list_groups &nbsp;·&nbsp; Max 500 groups per admin</p>
      </div>
      <button class="btn btn-primary" id="refresh-btn">↻ Refresh from B2</button>
    </div>
    <div id="groups-content"><div class="empty-state"><div class="spinner"></div></div></div>
  `;

  document.getElementById('refresh-btn').addEventListener('click', () => loadGroups(page, true));
  await loadGroups(page, false);
}

async function loadGroups(page, forceRefresh) {
  const btn = document.getElementById('refresh-btn');
  if (btn) btn.disabled = true;

  const res = await api(`/api/groups${forceRefresh ? '?refresh=true' : ''}`);
  if (btn) btn.disabled = false;
  if (!res?.ok) return;

  const data = await res.json();

  document.getElementById('groups-content').innerHTML = `
    <div class="card" style="padding:0;overflow:hidden">
      ${data.groups.length === 0
        ? '<div class="empty-state"><div class="icon">🗂️</div><p>No groups found.</p></div>'
        : `<table>
            <thead>
              <tr><th>Group Name</th><th>Group ID</th><th>Standing</th><th>Members</th><th>Products</th><th>Storage</th><th>Cached</th><th></th></tr>
            </thead>
            <tbody>
              ${data.groups.map(g => {
                const standing = g.raw.accountStandingDetails?.state || '';
                const memberCount = g.raw.groupStats?.memberCount ?? '–';
                const products = (g.raw.groupProducts || []).join(', ') || '–';
                const b2 = g.raw.b2Stats;
                const storedGb = b2 ? (b2.b2BytesStoredCount / 1e9).toFixed(2) + ' GB' : '–';
                const standingBadge = standing.includes('GOOD')
                  ? `<span class="badge badge-active">Good Standing</span>`
                  : standing
                    ? `<span class="badge badge-inactive">${esc(standing)}</span>`
                    : '–';
                return `
                <tr>
                  <td><strong>${esc(g.group_name)}</strong></td>
                  <td class="text-muted" style="font-family:monospace;font-size:0.78rem">${esc(g.group_id)}</td>
                  <td>${standingBadge}</td>
                  <td class="text-muted" style="font-size:0.85rem">${memberCount}</td>
                  <td class="text-muted" style="font-size:0.78rem">${esc(products)}</td>
                  <td class="text-muted" style="font-size:0.78rem">${storedGb}</td>
                  <td class="text-muted" style="font-size:0.78rem">${fmtDate(g.cached_at)}</td>
                  <td>
                    <button class="btn btn-sm" onclick="viewMembers('${esc(g.group_id)}', '${esc(g.group_name)}')">
                      View Members
                    </button>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>`}
    </div>
    <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:8px">
      ${data.total} group(s) · cached at ${fmtDate(data.cached_at)}
    </div>

    ${renderApiInspector(data.b2_api_call)}
  `;

  // Wire up view-members buttons
  window.viewMembers = (groupId, groupName) => {
    location.hash = `members?group=${groupId}`;
  };
}
