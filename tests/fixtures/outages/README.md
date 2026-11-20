# Outages

`readings.csv` holds checks arranged to cover every rule for finding outages; `expected.json` is what must come out.
Two implementations are held to it: `health.js` (`outages`, for the pages and the report; `node tests/health.test.js`)
and the backend's `outages_csv` (awk, for the copy on a USB drive; `python3 tests/backend.test.py`).

In order: two checks without the internet between good ones; one lost ping out of three (not an outage); the modem
unreachable too; a check without ping results (ignored); an outage cut off by two hours without checks, which is
not assumed to have gone on; a single check found down after that gap; and one still down at the last check.
