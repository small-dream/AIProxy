# Product

## Register

product

## Users

Developers and QA engineers using AIProxy as a desktop HTTP/HTTPS interception proxy (Tauri + React). They work in technical, task-driven contexts: configuring the proxy, capturing traffic, writing rules, and diffing sessions. Settings are touched infrequently but must be scannable and trustworthy when they are.

## Product Purpose

AIProxy is a desktop proxy/capture tool for inspecting and controlling HTTP(S) traffic. It exists to give developers precise, reliable control over requests and responses. Success = users find the setting they need in seconds, understand the consequence of each toggle (especially security-sensitive ones like TLS verification), and never lose work to unclear UI.

## Brand Personality

Professional and restrained (Linear-like): precise, quiet, trustworthy. Three words: precise, calm, dependable. The UI should feel like a native macOS utility — grouped settings lists, inline controls, plain-spoken descriptions — not a marketing surface.

## Anti-references

- SaaS-dashboard clichés: oversized hero metrics, decorative cards-in-cards, gradient accents, uppercase tracked eyebrows.
- Over-rounded "playful" consumer UI; heavy shadows; glassmorphism as decoration.
- Dense enterprise admin panels with walls of undifferentiated form fields.

## Design Principles

- Design serves the task: every visual choice reduces time-to-setting or clarifies consequence.
- Native over novel: prefer platform conventions (grouped lists, inline switches) users already know.
- Say the consequence: security-sensitive options state what happens, in plain language, next to the control.
- One accent, used sparingly: color communicates state and primary action only.
- Quiet by default: no decoration that doesn't carry information.

## Accessibility & Inclusion

WCAG 2.1 AA: body text ≥4.5:1 contrast, focus visible on all controls, full keyboard operability. Respect `prefers-reduced-motion`. Follow the system light/dark theme via the existing theme system.
