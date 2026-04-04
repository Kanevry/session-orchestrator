# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.0.x-alpha | Yes |
| 1.x | No |

## Reporting a Vulnerability

If you discover a security vulnerability in Session Orchestrator, please report it responsibly.

**Email:** [security@gotzendorfer.at](mailto:security@gotzendorfer.at)

Please include:
- Description of the vulnerability
- Steps to reproduce
- Affected files/skills
- Potential impact

**Response time:** We aim to acknowledge reports within 48 hours and provide a fix or mitigation plan within 7 days.

## Scope

Session Orchestrator is a **Claude Code plugin** composed entirely of Markdown instructions and shell scripts. It does not:
- Run a web server or accept network connections
- Store credentials or secrets
- Execute user-provided code directly

Security concerns are most likely to involve:
- **Hook scripts** (`hooks/enforce-scope.sh`, `hooks/enforce-commands.sh`) — command injection via crafted file paths or tool input
- **Skill instructions** — prompt injection that could bypass scope enforcement or safety constraints
- **Agent dispatch** — unintended tool access or scope escalation during wave execution

## Disclosure

We follow [responsible disclosure](https://en.wikipedia.org/wiki/Responsible_disclosure). Fixes are committed with a security advisory once a patch is available.
