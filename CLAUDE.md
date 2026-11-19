# luci-app-modemhealth

## Agent skills

### Issue tracker

Issues are tracked in this repo's GitHub Issues, using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Working on this repo

- Sibling project: ISPy (`chaffed/luci-app-ispy`). Its CLAUDE.md has the LuCI and GL.iNet admin-panel rules this app follows; read it before touching the web UI or the GL panel.
- The results are meant to stand up as evidence for the ISP. A reading that failed (modem unreachable, login refused) is stored as *failed* with its reason, never as an empty or healthy reading.
- Run `python3 tests/backend.test.py` after touching the backend (`luci-app-modemhealth/root/usr/bin/modemhealth`). It runs the real backend in an OpenWrt 23.05 container (needs Docker) against `tests/fake_modem.py`, which replays the captured S34 replies in `tests/fixtures/s34/` and checks every signature. Test output goes to `.test-out/` because Docker Desktop on macOS doesn't share the system temp folder.
- SURFboard S33/S34 login (from the modem's own JavaScript): HNAP over JSON, HMAC-SHA256, uppercase hex. Login step 2 is signed with the *new* PrivateKey (the page stores it before sending), not with `withoutloginkey`. A `GetMultipleHNAPs` reply is wrapped in `GetMultipleHNAPsResponse` only when more than one action was asked for, so the backend always asks for several.
- The modem password lives only in `/etc/config/modemhealth` (mode 600). It must never reach stored files, logs, command output or the browser; the backend test checks the first three with a password full of quoting characters.
- `tools/capture.py` saves a real modem's replies. Its output contains the modem's MAC, serial and the user's public IP: redact before anything goes into `tests/fixtures/`.
- The real test rig is a GL-BE9300 (GL firmware 4.10.1, OpenWrt 23.05), `ssh openwrt`, behind a SURFboard S34.
