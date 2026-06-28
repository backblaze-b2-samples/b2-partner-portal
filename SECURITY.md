# Security Policy

## Supported Versions

This is an example/reference project. Security fixes are applied to the `main` branch only.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use the **"Report a vulnerability"** button on the **Security tab** of this repository on GitHub (look for the "Security" tab at the top of the repo page, then click "Report a vulnerability"). This opens a private disclosure directly with the maintainers and allows you to attach proof-of-concept files safely.

If you are unable to use that button, visit [backblaze.com/cloud-storage/security](https://www.backblaze.com/cloud-storage/security) for alternative reporting options.

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce the issue
- Any proof-of-concept code or files

You can expect an acknowledgement within **5 business days** and an update on the remediation timeline within **10 business days**.

## Scope

This policy covers the code in this repository. It does not cover:

- The Backblaze B2 service or Partner API themselves
- Third-party dependencies (report those upstream)
- Vulnerabilities that require physical access to the server

## Deployment Security Reminders

If you are running this portal, make sure to:

- Set a strong, random `SECRET_KEY` (never use the default)
- Change the default admin credentials immediately after first login
- Run behind a TLS-terminating reverse proxy — do not expose the portal directly on the public internet without HTTPS
- Restrict filesystem permissions on `DATA_DIR` — it contains the SQLite database, downloaded report files, and (if vault is enabled) Fernet-encrypted credentials
- Back up `CREDENTIAL_VAULT_KEY` securely if the vault feature is enabled — loss of the key means encrypted credentials cannot be recovered
- Review the audit log (`audit_log` table) regularly for unexpected access

## OIDC / SSO Security

The portal enforces two protections against SSO-based account attacks:

**Email verification enforcement** — ID tokens where `email_verified` is explicitly `false` are rejected at the callback. This prevents identity providers that allow unverified addresses (some Okta, Cognito, or self-hosted configurations) from being used to claim an arbitrary email. Providers that omit the claim entirely (Azure Entra ID, Google Workspace) are accepted — they verify addresses at the directory level before issuing tokens.

**Account takeover protection** — SSO cannot silently merge into a pre-existing local account. If a portal user with `auth_source = 'local'` already exists for the incoming email, the SSO login is blocked with an `account_conflict` error rather than overwriting the account. To migrate a local user to SSO, an admin must remove the local account and have the user re-authenticate via SSO to trigger JIT provisioning.

## Known Limitations

- **SQLite** is used for storage. It is appropriate for single-server deployments with moderate load. There is no built-in replication or HA.
- The credential vault uses **symmetric encryption**. The security of stored credentials depends entirely on keeping `CREDENTIAL_VAULT_KEY` secret.
- **Rate limiting trusts proxy headers.** The portal keys per-IP rate limits from `X-Real-IP` / `X-Forwarded-For`. If the portal is exposed directly to the internet (not behind a reverse proxy), clients can rotate these headers to bypass login and password-reset rate limits. Always deploy behind a trusted reverse proxy such as nginx or Caddy, and configure the proxy to overwrite these headers rather than append to them. Do not expose the portal's port directly.
- **Password reset tokens** are stored in the database. Ensure `DATA_DIR` is appropriately protected.
- **SSO account migration** requires manual intervention — remove the local account first, then re-provision via SSO. There is no automated account-linking flow.
