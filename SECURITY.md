# Security Policy

## Supported Versions

This is an example/reference project. Security fixes are applied to the `main` branch only.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability in this project, please report it through one of the following channels:

- **GitHub Security Advisories:** Use the "Report a vulnerability" button on the repository's Security tab.
- **Email:** security@backblaze.com

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce the issue
- Any proof-of-concept code (if applicable)

You can expect an acknowledgement within **5 business days** and an update on the remediation timeline within **10 business days**.

## Scope

This policy covers the code in this repository. It does not cover:

- The Backblaze B2 service or Partner API themselves (report those to security@backblaze.com)
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

## Known Limitations

- **SQLite** is used for storage. It is appropriate for single-server deployments with moderate load. There is no built-in replication or HA.
- The credential vault uses **symmetric encryption**. The security of stored credentials depends entirely on keeping `CREDENTIAL_VAULT_KEY` secret.
- There is no **rate limiting** built in. Deploy behind a reverse proxy that provides rate limiting if the portal is internet-accessible.
- **Password reset tokens** are stored in the database. Ensure `DATA_DIR` is appropriately protected.
