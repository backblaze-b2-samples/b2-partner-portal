# Contributing to Backblaze Partner Portal

Thank you for your interest in contributing! This document describes how to get involved.

## Ways to Contribute

- **Bug reports** — open a GitHub issue with steps to reproduce, expected vs. actual behavior, and your environment (Python version, OS).
- **Feature requests** — open a GitHub issue describing the use case. Issues with a clear problem statement and real-world motivation are most likely to be acted on.
- **Pull requests** — welcome for bug fixes, documentation improvements, and features that have been discussed in an issue first.

## Ground Rules

- This is an **example project** for the Backblaze Partner API. Changes should remain focused on that use case. Large architectural changes or third-party service integrations are unlikely to be accepted without prior discussion.
- Keep the "no build step" constraint for the frontend. The UI is intentionally vanilla JavaScript — please do not introduce a bundler or framework.
- Do not add new Python dependencies without discussion. The current stack is deliberately minimal.
- All new endpoints must use `require_permission()` — no unauthenticated or implicitly authorized routes.

## Development Setup

```bash
git clone https://github.com/backblaze/partner-portal.git
cd partner-portal
python3 -m venv venv
venv/bin/pip install -r requirements.txt
cp .env.example .env
# Edit .env — set SECRET_KEY at minimum
bash run.sh
```

The server starts with `--reload`, so Python changes are picked up automatically. The API docs are at http://localhost:8080/api/docs.

## Pull Request Process

1. **Open or reference an issue first** for any non-trivial change.
2. Fork the repository and create a branch from `main`.
3. Make your changes. Keep commits focused — one logical change per commit.
4. Test your changes manually against the live server. There is currently no automated test suite; please describe what you tested in the PR description.
5. Update `README.md` if you are adding or changing user-facing behavior (new config options, new endpoints, changed permissions, etc.).
6. Open a pull request against `main`. Fill in the PR template.

## Commit Messages

Use the imperative mood and a short summary line (under 72 characters). If the change is non-obvious, add a body explaining *why*.

```
Add credentials:read permission to viewer role

The viewer role is used by support staff who need to look up member
credentials after provisioning. Previously this required a custom role.
```

## Code Style

- Python: follow [PEP 8](https://peps.python.org/pep-0008/). Use type hints for function signatures.
- Keep functions short and focused. Prefer explicit over clever.
- Do not add comments that restate what the code does. Comments should explain *why*.
- Match the style of the surrounding code.

## Sensitive Information

- Never commit `.env` files, API keys, or credentials.
- The `.gitignore` already excludes `.env`, `data/`, and `*.db`. Do not remove these entries.
- If you discover a security vulnerability, please follow the process in [SECURITY.md](SECURITY.md) rather than opening a public issue.

## License

By contributing, you agree that your contributions will be licensed under the [Apache 2.0 License](LICENSE) that covers this project.
