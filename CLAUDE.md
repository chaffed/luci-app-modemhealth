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
- The S34 answers HTTP 403 to any request whose `HNAP_AUTH` timestamp is lower than one it has already accepted (equal is fine). Busybox `date` has no milliseconds, so the backend takes real milliseconds from `ucode`'s `clock()` and never sends a timestamp below the last one (kept in `/var/run/modemhealth/last_ms`). The fake modem enforces the same rule.
- Every login adds an entry to the modem's 100-entry event log, and a check currently logs in each time. Running many checks by hand pushes real events out of the modem's log; #3 (one session between checks) fixes this.
- The modem password lives only in `/etc/config/modemhealth` (mode 600). It must never reach stored files, logs, command output or the browser; the backend test checks the first three with a password full of quoting characters.
- `tools/capture.py` saves a real modem's replies. Its output contains the modem's MAC, serial and the user's public IP: redact before anything goes into `tests/fixtures/`.
- The real test rig is a GL-BE9300 (GL firmware 4.10.1, OpenWrt 23.05), `ssh openwrt`, behind a SURFboard S34.
- `htdocs/luci-static/resources/modemhealth/health.js` holds every health limit, each with its sources (`SOURCES`: `spec`, `vendor` or `judgement`). The report cites them, so a new or changed limit needs a real source or must be marked `judgement`. No official ISP page publishes signal thresholds; the widely copied "Xfinity table" is a volunteer's forum post and is not cited. Run `node tests/health.test.js` after touching it.
- Uncorrectable error counts are reported but not judged: no published field threshold exists, and the S33/S34 doesn't report the total codewords needed for an error rate.
- S34 sessions (measured 2026-11-19): a session stays valid while used and expires after 10–15 minutes idle; an expired session is answered with HTTP 404. Several sessions can be open at once (a browser on the modem's page does not end the router's session). Checks every 5 minutes therefore keep one session for good; every login still adds a log entry.
- Storage (see the comment in the backend): daily files in `readings/` and `channels/` (days before today gzipped, days past `history_days` removed), the channel line-up in `channelmap.csv` only when it changes, and the modem's running error totals in `last`. Channel rows store the *change* in corrected/uncorrectable errors since the previous good check; empty means unknown (first check), and after a modem restart the change is the new count.
- A modem restart is detected when its uptime is shorter than the time since the previous good check (2 minutes' grace). The scheduler waits for the router's clock to be set (NTP) before checking, and runs on the router's uptime so clock steps can't stall it.
