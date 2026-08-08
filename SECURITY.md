# Security Policy

## Supported Versions

AIProxy is under active development. Security fixes are applied to the latest release.

| Version | Supported |
|---------|-----------|
| latest `master` | ✅ |
| latest release tag | ✅ |
| older versions | ❌ |

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue, please report it responsibly.

### How to Report

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please use one of these private channels:

1. **GitHub Security Advisories** (preferred):
   Go to [github.com/small-dream/AIProxy/security/advisories/new](https://github.com/small-dream/AIProxy/security/advisories/new) and create a private security advisory.

2. **Alternative**: Open a private issue using the GitHub vulnerability reporting flow at [github.com/small-dream/AIProxy/security](https://github.com/small-dream/AIProxy/security).

### What to Include

Please provide as much of the following as possible:

- A description of the vulnerability and its impact
- Steps to reproduce the issue
- Affected versions / platforms
- Suggested fix (if any)
- Your contact information for follow-up

### Response Timeline

| Step | Target |
|------|--------|
| Acknowledge receipt | Within 48 hours |
| Initial assessment | Within 5 business days |
| Fix or mitigation | Depends on severity, typically within 30 days for high-severity issues |
| Public disclosure | After a fix is released, coordinated with the reporter |

## Security Considerations

AIProxy is a proxy debugging tool that intercepts and decrypts network traffic by design. Please be aware of the following:

- **Root CA Certificate**: AIProxy generates a local root CA certificate for HTTPS MITM decryption. This certificate is stored on your machine. Do not export or share it — anyone with this certificate could intercept your HTTPS traffic.
- **AI API Keys**: If you configure AI API keys in the app, they are stored in the local SQLite database. They are not transmitted anywhere except to the AI provider you configure, but they are not encrypted at rest. Treat your database file as sensitive.
- **System Proxy**: When enabled, AIProxy sets itself as the system HTTP(S) proxy. If the application crashes, it attempts to restore your original proxy settings, but you should verify your proxy settings if you experience connectivity issues.

## Scope

The following are **in scope** for security reports:
- Vulnerabilities in the application that could lead to code execution, data leakage, or privilege escalation
- Issues with certificate handling or TLS implementation
- Weaknesses in how sensitive data (e.g., API keys) is stored or handled

The following are **out of scope**:
- The intentional MITM decryption functionality (this is the core feature of the tool)
- Issues that require physical access to an unlocked machine
- Social engineering attacks
