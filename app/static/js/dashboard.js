import { api, fmtBytes, fmtDate, esc, state } from './app.js';

export async function renderDashboard(page) {
  // Fetch groups summary
  const groupsRes = await api('/api/groups');
  const groups = groupsRes?.ok ? await groupsRes.json() : { groups: [], total: 0 };

  const configRes = await api('/api/settings/status');
  const config = configRes?.ok ? await configRes.json() : {};

  page.innerHTML = `
    <div class="page-header">
      <h1>Dashboard</h1>
      <p class="page-subtitle">Overview of your Backblaze Partner account</p>
    </div>

    ${!config.configured ? `
      <div class="alert alert-warning">
        ⚠️ Partner API credentials not configured.
        ${state.user?.permissions?.includes('settings:write')
          ? '<a href="#settings" onclick="location.hash=\'settings\'">Go to Settings</a> to add your API key.'
          : 'Contact an administrator to configure the Partner API.'}
      </div>` : ''}

    <div class="stats-grid">
      <div class="stat-card">
        <div class="label">Groups</div>
        <div class="value">${groups.total ?? 0}</div>
        <div class="sub">Active B2 groups</div>
      </div>
      <div class="stat-card">
        <div class="label">API Status</div>
        <div class="value" style="font-size:1.2rem;margin-top:8px">
          ${config.configured
            ? '<span class="badge badge-active">Configured</span>'
            : '<span class="badge badge-inactive">Not Configured</span>'}
        </div>
      </div>
      <div class="stat-card">
        <div class="label">Signed In As</div>
        <div class="value" style="font-size:1rem;margin-top:8px;word-break:break-all">${esc(state.user?.email || '–')}</div>
        <div class="sub">${esc(state.user?.role_id || '')}</div>
      </div>
    </div>

    <h2>Groups</h2>
    <div class="card" style="padding:0;overflow:hidden">
      ${groups.groups.length === 0
        ? '<div class="empty-state"><div class="icon">🗂️</div><p>No groups found. Configure your API credentials and refresh.</p></div>'
        : `<table>
            <thead><tr><th>Group Name</th><th>Group ID</th><th>Cached At</th></tr></thead>
            <tbody>
              ${groups.groups.map(g => `
                <tr>
                  <td><strong>${esc(g.group_name)}</strong></td>
                  <td class="text-muted" style="font-family:monospace;font-size:0.8rem">${esc(g.group_id)}</td>
                  <td class="text-muted">${fmtDate(g.cached_at)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>`}
    </div>

    <div style="margin-top:8px;font-size:0.78rem;color:var(--text-muted)">
      Groups cached at ${fmtDate(groups.cached_at)} ·
      <a href="#groups" onclick="location.hash='groups'" style="color:var(--primary)">View all →</a>
    </div>
  `;
}
