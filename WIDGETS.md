# Sentinel — Widget Summary

Sentinel is the Kneuralabs *Automated Remediation Hub*. It sits behind
Kneuralabs SSO, connects to GitHub with a personal access token, and scans
repositories for new commits and open vulnerabilities. Below is a summary of
every widget in the app.

## SSO gate
- **Sign-in overlay** — full-screen iframe to `sso.kneuralabs.com`; the app only
  unlocks on a verified `kn-auth` postMessage from that origin.

## Header
- **Logo + title** — Sentinel mark and "Automated Remediation Hub" subtitle.
- **GitHub Access control** — a dot button that opens an access popover:
  - **Personal Access Token input** (requires `repo` and `security_events` scopes).
  - **Connect & Scan button** — authenticates and starts scanning.
  - **Reset button** — clears stored token / state.
- **Theme toggle** — switches the color theme.
- **Status pill** — connection status dot and text (e.g. "Not connected").

## Empty state
- **No repositories loaded card** — shown before connecting, prompting the user
  to enter a token via the header dot.

## Dashboard area
### Scan overlay
- **Scan terminal** — terminal-styled live scan output with a progress bar.

### Stats bar (KPI cells)
- **Repositories** — repo count plus an inline list of repo names.
- **New Commits** — count of new commits plus a commit list.
- **Open Vulnerabilities** — count plus a vulnerability list.
- **Last Scan** — timestamp of the most recent scan.

### Dashboard controls
- **Sort select** — order repos by security status, latest commit, commit count,
  branch count, or alphabetically.
- **Live pill** — live-update indicator (shown when streaming).
- **Rescan + Remediation button** — manually re-runs the scan and remediation.

### Repository tiles
- **Repo grid** — one tile per repository summarizing its security posture.

## Detail panel
A slide-over panel (with backdrop overlay) opened from a repo tile:
- **Repo name header** with a close button.
- **Recent Commits — Chronological** — commit history for the repo.
- **Vulnerabilities & Remediation** — open vulnerabilities and remediation steps.

## Toast
- **Toast notifications** — transient status / action feedback.

## Tweaks panel (edit-mode appearance controls)
A floating settings panel exposing live theming controls:
- **Appearance → Accent** — accent color picker.
- **Layout → Density** — compact / regular radio.
