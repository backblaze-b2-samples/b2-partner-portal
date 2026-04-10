import { api, esc, fmtDate, downloadCredentialsCsvFull } from './app.js';

export async function renderCredentials(page) {
  page.innerHTML = `
    <div class="page-header">
      <h1>Credential Vault</h1>
      <p class="page-subtitle">Retrieve encrypted B2 credentials stored at member provisioning time</p>
    </div>

    <div class="card">
      <p style="margin:0 0 16px;font-size:0.875rem;color:var(--text-muted)">
        Enter the B2 Account ID of the member whose credentials you want to retrieve.
        Every lookup is recorded in the audit log.
      </p>
      <div class="flex-gap" style="align-items:flex-end">
        <div style="flex:1;min-width:260px">
          <label class="form-label">B2 Account ID</label>
          <input id="vault-account-id" class="form-input" placeholder="e.g. abc123def456…" autocomplete="off" spellcheck="false">
        </div>
        <button class="btn btn-primary" id="vault-lookup-btn">Retrieve Credentials</button>
      </div>
      <div id="vault-result" style="margin-top:16px"></div>
    </div>
  `;

  const input  = page.querySelector('#vault-account-id');
  const btn    = page.querySelector('#vault-lookup-btn');
  const result = page.querySelector('#vault-result');

  async function doLookup() {
    const accountId = input.value.trim();
    if (!accountId) return;

    btn.disabled = true;
    btn.textContent = 'Retrieving…';
    result.innerHTML = '';

    const res  = await api(`/api/credentials/${encodeURIComponent(accountId)}`);
    const data = await res?.json();

    btn.disabled = false;
    btn.textContent = 'Retrieve Credentials';

    if (!res?.ok) {
      const msg = res?.status === 404
        ? 'No stored credentials found for that account ID.'
        : esc(data?.detail || 'An error occurred.');
      result.innerHTML = `<div class="alert alert-error">${msg}</div>`;
      return;
    }

    result.innerHTML = `
      <div class="alert alert-warning" style="margin-bottom:16px">
        ⚠️ <strong>Handle with care.</strong> Close this page or navigate away when finished.
        This lookup has been recorded in the audit log.
      </div>
      <div class="card" style="padding:16px 20px;margin-bottom:12px">
        <table style="width:100%;border:none">
          <tbody>
            <tr>
              <td style="width:160px;padding:6px 0;color:var(--text-muted);font-size:0.82rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Account ID</td>
              <td style="padding:6px 0;font-family:monospace;font-size:0.85rem">${esc(data.member_account_id)}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:var(--text-muted);font-size:0.82rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Email</td>
              <td style="padding:6px 0;font-size:0.88rem">${esc(data.account_email)}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:var(--text-muted);font-size:0.82rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Group ID</td>
              <td style="padding:6px 0;font-family:monospace;font-size:0.85rem">${esc(data.group_id)}</td>
            </tr>
            ${data.region ? `<tr>
              <td style="padding:6px 0;color:var(--text-muted);font-size:0.82rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Region</td>
              <td style="padding:6px 0;font-size:0.85rem">${esc(data.region)}</td>
            </tr>` : ''}
            ${data.s3_endpoint ? `<tr>
              <td style="padding:6px 0;color:var(--text-muted);font-size:0.82rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em">S3 Endpoint</td>
              <td style="padding:6px 0;font-family:monospace;font-size:0.85rem">${esc(data.s3_endpoint)}</td>
            </tr>` : ''}
            <tr>
              <td style="padding:6px 0;color:var(--text-muted);font-size:0.82rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Key ID</td>
              <td style="padding:6px 0;font-family:monospace;font-size:0.85rem">${esc(data.application_key_id)}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:var(--text-muted);font-size:0.82rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Application Key</td>
              <td style="padding:6px 0;font-family:monospace;font-size:0.85rem">${esc(data.application_key)}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:var(--text-muted);font-size:0.82rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Stored At</td>
              <td style="padding:6px 0;font-size:0.85rem;color:var(--text-muted)">${fmtDate(data.created_at)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <button class="btn" id="vault-download-btn">⬇ Download Credentials CSV</button>
    `;

    result.querySelector('#vault-download-btn').addEventListener('click', () => {
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

  btn.addEventListener('click', doLookup);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doLookup(); });
}
