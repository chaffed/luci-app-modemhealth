#!/usr/bin/env python3
"""Backend test: the real `modemhealth check` against the fake modem.

Runs the backend inside an OpenWrt 23.05 container (the same sh, curl,
openssl and jsonfilter as on the router) and checks what it stored.
Needs docker and python3.

Usage: python3 tests/backend.test.py
"""

import calendar
import csv
import gzip
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMAGE = "modemhealth-test-openwrt"
PORT = 18443
# Characters that break naive quoting in shell, JSON, UCI and HMAC keys.
PASSWORD = "Pa ss,w\"o'r$d\\`1"

failures = []


def check(cond, what):
    print(("ok   " if cond else "FAIL ") + what)
    if not cond:
        failures.append(what)


def control(path):
    ctx = ssl._create_unverified_context()
    with urllib.request.urlopen("https://127.0.0.1:%d/_control/%s" % (PORT, path), context=ctx, timeout=5) as r:
        return json.load(r)


def uci_quote(value):
    return "'" + value.replace("'", "'\\''") + "'"


def config(host, password, data_dir):
    return "\n".join([
        "config modemhealth 'main'",
        "\toption host %s" % uci_quote(host),
        "\toption username 'admin'",
        "\toption password %s" % uci_quote(password),
        "\toption timeout '5'",
        "\toption data_dir %s" % uci_quote(data_dir),
        ""])


def run_in_openwrt(out, scenarios):
    """scenarios: (name, config text, shell before, [shell after, [command]]);
    the command defaults to `modemhealth check`"""
    script = ["set -u", "cp -R /pkg/. /", "chmod 755 /usr/bin/modemhealth", "mkdir -p /var/run"]
    for scenario in scenarios:
        name, cfg, before = scenario[:3]
        after = scenario[3] if len(scenario) > 3 else ":"
        command = scenario[4] if len(scenario) > 4 else "modemhealth check"
        with open(os.path.join(out, name + ".uci"), "w") as f:
            f.write(cfg)
        script += [
            "rm -rf /var/run/modemhealth",  # each scenario starts without a session
            "mkdir -p /out/%s" % name,
            "cp /out/%s.uci /etc/config/modemhealth" % name,
            before,
            "%s > /out/%s/output.txt 2>&1; echo $? > /out/%s/exit" % (command, name, name),
            after,
            "curl -sk https://modem:%d/_control/state > /out/%s/modem_state.json" % (PORT, name),
            "curl -sk https://modem:%d/_control/reset > /dev/null" % PORT,
        ]
    subprocess.run([
        "docker", "run", "--rm", "--platform", "linux/amd64",
        "--add-host", "modem:host-gateway",
        "-v", os.path.join(ROOT, "luci-app-modemhealth", "root") + ":/pkg:ro",
        "-v", out + ":/out",
        IMAGE, "sh", "-c", "\n".join(script)], check=True)


def read_csv(path):
    with open(path) as f:
        return list(csv.DictReader(f))


def stored(d, kind):
    """All rows of a scenario's daily files (readings or channels), oldest first."""
    folder = os.path.join(d, "data", kind)
    rows = []
    if os.path.isdir(folder):
        for name in sorted(os.listdir(folder)):
            path = os.path.join(folder, name)
            opener = gzip.open if name.endswith(".gz") else open
            with opener(path, "rt") as f:
                rows += list(csv.DictReader(f))
    return rows


def files_text(folder):
    text = ""
    for dirpath, _, names in os.walk(folder):
        for n in names:
            with open(os.path.join(dirpath, n), errors="replace") as f:
                text += f.read()
    return text


def main():
    subprocess.run(["docker", "build", "-q", "--platform", "linux/amd64", "-t", IMAGE,
                    os.path.join(ROOT, "tests", "openwrt")], check=True, stdout=subprocess.DEVNULL)
    modem = subprocess.Popen([sys.executable, os.path.join(ROOT, "tests", "fake_modem.py"),
                              "--port", str(PORT), "--password", PASSWORD])
    os.makedirs(os.path.join(ROOT, ".test-out"), exist_ok=True)
    # Inside the repo: Docker Desktop does not share the system temp folder.
    out = tempfile.mkdtemp(prefix="backend-", dir=os.path.join(ROOT, ".test-out"))
    try:
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", PORT), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        control("reset")

        # The fake modem must refuse what the real one would, or the backend
        # tests prove nothing about signing.
        ctx = ssl._create_unverified_context()
        req = urllib.request.Request("https://127.0.0.1:%d/HNAP1/" % PORT, method="POST",
                                     data=b'{"Login":{"Action":"request","Username":"admin"}}',
                                     headers={"Content-Type": "application/json",
                                              "SOAPAction": '"http://purenetworks.com/HNAP1/Login"',
                                              "HNAP_AUTH": "0123ABCD 1234567890123"})
        with urllib.request.urlopen(req, context=ctx, timeout=5) as r:
            reply = json.load(r)
        check(reply == {"LoginResponse": {"LoginResult": "ERROR"}} and control("state")["bad_signatures"] == 1,
              "fake modem: refuses a request with a wrong HNAP_AUTH signature")
        control("reset")

        host = "modem:%d" % PORT
        CTL = "curl -sk \"https://modem:%d/_control/set?%%s\" >/dev/null" % PORT
        run_in_openwrt(out, [
            ("good", config(host, PASSWORD, "/out/good/data"), ":"),
            ("wrong_password", config(host, PASSWORD + "x", "/out/wrong_password/data"), ":"),
            ("no_password", config(host, "", "/out/no_password/data"), ":"),
            ("unreachable", config("modem:1", PASSWORD, "/out/unreachable/data"), ":"),
            # Back-to-back checks: every timestamp must be >= the last one.
            ("rapid", config(host, PASSWORD, "/out/rapid/data"),
             "modemhealth check >/dev/null; modemhealth check >/dev/null; modemhealth check >/dev/null"),
            # The router's clock stepped back a minute since the last check
            # (simulated by a last check made a minute in the future).
            ("clock_back", config(host, PASSWORD, "/out/clock_back/data"),
             "mkdir -p /var/run/modemhealth; f=$(( $(date +%%s) * 1000 + 60000 )); echo $f > /var/run/modemhealth/last_ms; "
             "curl -sk \"https://modem:%d/_control/set?last_ts=$f\" >/dev/null" % PORT),
            # One session across checks: the modem sees one login.
            ("reuse", config(host, PASSWORD, "/out/reuse/data"),
             "modemhealth check >/dev/null; modemhealth check >/dev/null",
             "ls -l /var/run/modemhealth/session > /out/reuse/session_ls; "
             "cat /var/run/modemhealth/session > /out/reuse/session_copy"),
            # The modem forgets the session: log in again, no failure stored.
            ("expired", config(host, PASSWORD, "/out/expired/data"),
             "modemhealth check >/dev/null; curl -sk \"https://modem:%d/_control/set?expire=1\" >/dev/null" % PORT),
            # Password changed on the modem while a session was kept: one
            # refused login, stored as such, and no retry loop.
            ("expired_wrong_password", config(host, PASSWORD, "/out/expired_wrong_password/data"),
             "modemhealth check >/dev/null; "
             "curl -sk \"https://modem:%d/_control/set?expire=1&password=changed\" >/dev/null" % PORT,
             "test -e /var/run/modemhealth/session && echo kept > /out/expired_wrong_password/session_state || "
             "echo dropped > /out/expired_wrong_password/session_state"),
            # Settings saved after the session began: start a new session.
            ("settings_changed", config(host, PASSWORD, "/out/settings_changed/data"),
             "modemhealth check >/dev/null; sleep 1; touch /etc/config/modemhealth"),
            # modemhealth logout ends the kept session.
            ("logout", config(host, PASSWORD, "/out/logout/data"),
             "modemhealth check >/dev/null",
             "test -e /var/run/modemhealth/session && echo kept > /out/logout/session_state || "
             "echo dropped > /out/logout/session_state",
             "modemhealth logout"),
            # Error counters grow by 100 between two checks.
            ("deltas", config(host, PASSWORD, "/out/deltas/data"),
             "modemhealth check >/dev/null; " + CTL % "counter_add=100&uptime=6700"),
            # The modem restarted: uptime 60 s, counters start again at 7.
            ("restart", config(host, PASSWORD, "/out/restart/data"),
             "modemhealth check >/dev/null; " + CTL % "restart=1&counter_add=7"),
            # A failed check in between: changes count from the last good one.
            ("failed_between", config(host, PASSWORD, "/out/failed_between/data"),
             "modemhealth check >/dev/null; uci set modemhealth.main.host=modem:1; modemhealth check >/dev/null; "
             "uci revert modemhealth; " + CTL % "counter_add=50"),
            # Days before today are gzipped; days past history_days removed.
            ("tidy", config(host, PASSWORD, "/out/tidy/data"),
             "mkdir -p /out/tidy/data/readings /out/tidy/data/channels; "
             "y=$(date -d @$(( $(date +%s) - 86400 )) +%Y-%m-%d); "
             "for k in readings channels; do echo header > /out/tidy/data/$k/2020-01-01.csv; "
             "echo header > /out/tidy/data/$k/$y.csv; done; echo $y > /out/tidy/yesterday"),
            ("history", config(host, PASSWORD, "/out/history/data"),
             "modemhealth check >/dev/null; uci set modemhealth.main.host=modem:1; modemhealth check >/dev/null; uci revert modemhealth",
             ":", "modemhealth history"),
            # The scheduler checks at once when there is no recent reading, and
            # logs out of the modem when stopped.
            # The modem log: stored once; new entries added as it rotates.
            ("events", config(host, PASSWORD, "/out/events/data"),
             "modemhealth check >/dev/null; modemhealth check >/dev/null; " + CTL % "new_events=5"),
            ("daemon", config(host, PASSWORD, "/out/daemon/data"),
             "mkdir -p /var/state; touch /var/state/dnsmasqsec",
             "pgrep -f 'modemhealth daemon' > /out/daemon/left_running || true",
             "modemhealth daemon & p=$!; sleep 8; kill $p; sleep 3; echo stopped"),
        ])

        # ------------------------------------------------------------ good
        d = os.path.join(out, "good")
        state = json.load(open(os.path.join(d, "modem_state.json")))
        output = open(os.path.join(d, "output.txt")).read()
        check(open(os.path.join(d, "exit")).read().strip() == "0", "good: check exits 0 (%s)" % output.strip())
        check(state["bad_signatures"] == 0, "good: every HNAP_AUTH signature verified by the fake modem")
        check(state["logins"] == 1 and state["login_failures"] == 0, "good: logged in once with the password proof")
        check(state["status_reads"] == 1, "good: read all status pages in one request")
        check(state["logouts"] == 0, "good: the session is kept for the next check, not logged out")

        readings = stored(d, "readings")
        check(len(readings) == 1, "good: one reading stored")
        r = readings[0]
        check(r["result"] == "ok" and r["reason"] == "", "good: reading marked ok")
        check(r["model"] == "S34" and r["firmware"] == "AT01.01.010.042324_S3.04.735", "good: model and firmware")
        check(r["uptime_s"] == str(1 * 3600 + 46 * 60 + 5), "good: uptime 0 day(s) 01h:46m:05s = 6365 s")
        check(r["connectivity"] == "Operational" and r["boot"] == "Operational", "good: startup status")
        check(r["network_access"] == "Allowed", "good: network access")
        check(r["modem_time"] == "11/19/2026 14:13:57", "good: modem clock")
        check(r["ds_channels"] == "34" and r["us_channels"] == "5", "good: 34 downstream and 5 upstream channels counted")
        check(abs(int(r["ts"]) - time.time()) < 300, "good: timestamp is now")

        ch = stored(d, "channels")
        ds = [c for c in ch if c["dir"] == "ds"]
        us = [c for c in ch if c["dir"] == "us"]
        check(len(ds) == 34 and len(us) == 5, "good: 39 channel rows stored")
        check(all(c["ts"] == r["ts"] for c in ch), "good: channel rows carry the reading's timestamp")
        first = {k: ds[0][k] for k in ("channel_id", "lock", "power_dbmv", "snr_db", "corrected", "uncorrectable")}
        check(first == {"channel_id": "20", "lock": "Locked", "power_dbmv": "0.9", "snr_db": "40.9",
                        "corrected": "", "uncorrectable": ""},
              "good: downstream channel 1 stored (power trimmed; error changes unknown on the first check)")
        neg = [c for c in ds if c["channel_id"] == "41"][0]
        check(neg["power_dbmv"] == "-1.4", "good: negative power kept")
        check(us[-1]["channel_id"] == "41" and us[-1]["power_dbmv"] == "44.5" and us[-1]["snr_db"] == "",
              "good: upstream OFDMA channel stored")
        check(us[0]["power_dbmv"] == "50.5", "good: upstream SC-QAM channel 1")

        cmap = read_csv(os.path.join(d, "data", "channelmap.csv"))
        check(len(cmap) == 39 and all(c["ts"] == r["ts"] for c in cmap), "good: channel line-up stored once, with the reading's time")
        m = {(c["dir"], c["channel_id"]): c for c in cmap}
        check({k: m[("ds", "20")][k] for k in ("ch", "modulation", "freq_hz", "width_hz")} ==
              {"ch": "1", "modulation": "256QAM", "freq_hz": "501000000", "width_hz": ""}, "good: downstream line-up parsed")
        check(m[("ds", "194")]["modulation"] == "OFDM PLC", "good: OFDM downstream in the line-up")
        check({k: m[("us", "41")][k] for k in ("ch", "modulation", "freq_hz", "width_hz")} ==
              {"ch": "5", "modulation": "OFDMA", "freq_hz": "36200000", "width_hz": "44400000"},
              "good: upstream OFDMA line-up (frequency and width in the right columns)")
        last_state = open(os.path.join(d, "data", "last")).read().splitlines()
        check(last_state[0] == "%s 6365" % r["ts"] and "ds,20,627773,6793" in last_state and "ds,194,15038563,184527" in last_state,
              "good: the modem's running error totals kept for the next check")

        info = dict(line.split("=", 1) for line in open(os.path.join(d, "data", "modem.txt")).read().splitlines())
        check(info.get("mac") == "00:00:5E:00:53:01" and info.get("docsis") == "DOCSIS 3.1", "good: modem identity saved")

        # --------------------------------------------------------- failures
        for name, reason in (("wrong_password", "login_refused"), ("no_password", "no_password"),
                             ("unreachable", "unreachable")):
            d = os.path.join(out, name)
            readings = stored(d, "readings")
            check(open(os.path.join(d, "exit")).read().strip() != "0", "%s: check exits non-zero" % name)
            check(len(readings) == 1 and readings[0]["result"] == "failed" and readings[0]["reason"] == reason,
                  "%s: stored as a failed reading, reason %s (got %s)" % (name, reason, readings[0]["reason"] if readings else "none"))
            check(len(stored(d, "channels")) == 0, "%s: no channel rows" % name)
        state = json.load(open(os.path.join(out, "wrong_password", "modem_state.json")))
        check(state["login_failures"] == 1 and state["status_reads"] == 0, "wrong_password: no status read after a refused login")
        state = json.load(open(os.path.join(out, "no_password", "modem_state.json")))
        check(state["requests"] == 0, "no_password: the modem is not contacted")

        # ------------------------------------------------------- timestamps
        d = os.path.join(out, "rapid")
        readings = stored(d, "readings")
        state = json.load(open(os.path.join(d, "modem_state.json")))
        check([r["result"] for r in readings] == ["ok"] * 4, "rapid: four back-to-back checks all ok")
        check(state["stale_timestamps"] == 0, "rapid: no timestamp ever went backwards")
        d = os.path.join(out, "clock_back")
        readings = stored(d, "readings")
        state = json.load(open(os.path.join(d, "modem_state.json")))
        check(len(readings) == 1 and readings[0]["result"] == "ok" and state["stale_timestamps"] == 0,
              "clock_back: check still ok after the router clock went back (got %s)" % (readings[0]["reason"] if readings else "none"))
        good_state = json.load(open(os.path.join(out, "good", "modem_state.json")))
        check(good_state["stale_timestamps"] == 0, "good: no stale timestamps")

        # ----------------------------------------------------------- history
        def channels_at(rows, ts):
            return {c["channel_id"]: c for c in rows if c["ts"] == ts and c["dir"] == "ds"}

        d = os.path.join(out, "deltas")
        readings, ch = stored(d, "readings"), stored(d, "channels")
        check([(r["result"], r["reboot"]) for r in readings] == [("ok", "0"), ("ok", "0")], "deltas: two good readings, no restart")
        second = channels_at(ch, readings[1]["ts"])
        check(len(second) == 34 and all(c["corrected"] == "100" and c["uncorrectable"] == "100" for c in second.values()),
              "deltas: every downstream channel stores the change since the last check (100)")
        check(all(c["corrected"] == "" for c in ch if c["dir"] == "us"), "deltas: upstream channels have no error counts")
        check(len(read_csv(os.path.join(d, "data", "channelmap.csv"))) == 39, "deltas: an unchanged line-up is not stored again")

        d = os.path.join(out, "restart")
        readings, ch = stored(d, "readings"), stored(d, "channels")
        r2 = readings[-1]
        check(len(readings) == 2 and r2["reboot"] == "1" and r2["uptime_s"] == "60", "restart: the restart is recorded")
        check(r2["boot_ts"] != "" and abs(int(r2["ts"]) - 60 - int(r2["boot_ts"])) <= 1, "restart: restart time = reading time - uptime")
        second = channels_at(ch, r2["ts"])
        check(all(c["corrected"] == "7" and c["uncorrectable"] == "7" for c in second.values()),
              "restart: the change is the new count, never negative or a huge jump")
        check(readings[0]["reboot"] == "0", "restart: the first reading is not a restart")

        d = os.path.join(out, "failed_between")
        readings, ch = stored(d, "readings"), stored(d, "channels")
        check([r["result"] for r in readings] == ["ok", "failed", "ok"], "failed_between: ok, failed, ok stored")
        check(readings[1]["reason"] == "unreachable" and readings[2]["reboot"] == "0", "failed_between: reason kept, no false restart")
        third = channels_at(ch, readings[2]["ts"])
        check(all(c["corrected"] == "50" for c in third.values()), "failed_between: changes count from the last good check")

        d = os.path.join(out, "tidy")
        y = open(os.path.join(d, "yesterday")).read().strip()
        for kind in ("readings", "channels"):
            names = sorted(os.listdir(os.path.join(d, "data", kind)))
            today = [n for n in names if n.endswith(".csv")]
            check("2020-01-01.csv" not in names and "2020-01-01.csv.gz" not in names, "tidy: %s older than 90 days removed" % kind)
            check(y + ".csv.gz" in names and y + ".csv" not in names, "tidy: yesterday's %s gzipped" % kind)
            check(len(today) == 1, "tidy: today's %s file is plain text" % kind)
        check(len(stored(d, "readings")) == 1, "tidy: readings still readable across plain and gzipped days")

        out_text = open(os.path.join(out, "history", "output.txt")).read().splitlines()
        check(len(out_text) == 2 and "  ok  " in out_text[0] and "34 ds / 5 us" in out_text[0] and "FAILED  unreachable" in out_text[1],
              "history: prints the readings, failures included (%s)" % out_text)

        d = os.path.join(out, "events")
        readings, events = stored(d, "readings"), stored(d, "events")
        out_text = open(os.path.join(d, "output.txt")).read()
        check(len(readings) == 3, "events: three checks")
        check(len(events) == 87 + 5, "events: 87 entries stored once (100 less 13 web logins), then the 5 new ones (got %d)" % len(events))
        check("5 new events" in out_text, "events: the check reports 5 new events")
        check(not any("WebGUI" in e["message"] for e in events), "events: the modem's web logins are not stored")
        text = files_text(os.path.join(d, "data", "events")) + open(os.path.join(d, "data", "events.seen")).read()
        check("203.0.113.7" not in text and "00:00:5E:00:53" not in text, "events: no IP or MAC address in the stored events")
        at = [e["message"] for e in events if e["modem_time"] == "11/19/2026 12:29:02"]
        check(len(at) == 2 and any(m.startswith("RNG-RSP") for m in at) and any(m.startswith("REG-RSP") for m in at),
              "events: two entries with the same time and different messages are both stored")
        check(events[0]["modem_time"] == "11/19/2026 12:06:13" and events[-1]["message"].endswith("Loss of Sync"),
              "events: stored oldest first; the new entries last")
        check(all(e["level"] in ("Critical", "Warning", "Notice") for e in events), "events: levels kept")
        cs = [e for e in events if e["message"].startswith("CM-STATUS")][0]["message"]
        check(cs.endswith("OFDM/OFDMA Profile ID: N/A.") , "events: CM-STATUS lines without the MAC/version suffix (%s)" % cs[-40:])
        modem_epoch = calendar.timegm(time.strptime("11/19/2026 14:13:57", "%m/%d/%Y %H:%M:%S"))
        offs = [int(r["clock_offset_s"]) - (modem_epoch - int(r["ts"])) for r in readings]
        check(all(o == 0 for o in offs), "events: clock offset = modem clock - router clock (container in UTC)")
        check(all(e["clock_offset_s"] != "" for e in events), "events: each event keeps the clock offset when it was first seen")

        d = os.path.join(out, "daemon")
        state = json.load(open(os.path.join(d, "modem_state.json")))
        readings = stored(d, "readings")
        check(len(readings) == 1 and readings[0]["result"] == "ok", "daemon: checks at once on start")
        check(state["logouts"] == 1, "daemon: logs out of the modem when stopped")
        check(open(os.path.join(d, "left_running")).read().strip() == "", "daemon: stops when told to")

        # ---------------------------------------------------------- sessions
        def scenario(name):
            d = os.path.join(out, name)
            return (json.load(open(os.path.join(d, "modem_state.json"))),
                    stored(d, "readings"))

        state, readings = scenario("reuse")
        check([r["result"] for r in readings] == ["ok"] * 3, "reuse: three checks ok")
        check(state["logins"] == 1 and state["status_reads"] == 3 and state["logouts"] == 0,
              "reuse: one login for three checks (logins %d, reads %d)" % (state["logins"], state["status_reads"]))
        ls = open(os.path.join(out, "reuse", "session_ls")).read()
        check(ls.startswith("-rw------- ") and " root " in ls, "reuse: the session file is root only")
        session_text = open(os.path.join(out, "reuse", "session_copy")).read()
        check(PASSWORD not in session_text and "Pa ss" not in session_text, "reuse: the session file holds no password")
        check(not os.path.exists(os.path.join(out, "reuse", "data", "session")), "reuse: the session is not kept in the data folder (flash)")

        state, readings = scenario("expired")
        check([r["result"] for r in readings] == ["ok", "ok"], "expired: the check after expiry is ok, no failure stored")
        check(state["logins"] == 2 and state["status_reads"] == 2 and state["unauthorised"] == 1,
              "expired: the modem answered 404 once; logged in again and read the status")

        state, readings = scenario("expired_wrong_password")
        check([(r["result"], r["reason"]) for r in readings] == [("ok", ""), ("failed", "login_refused")],
              "expired_wrong_password: stored as a refused login")
        check(state["login_failures"] == 1 and state["logins"] == 1, "expired_wrong_password: exactly one failed login, no retry loop")
        check(open(os.path.join(out, "expired_wrong_password", "session_state")).read().strip() == "dropped",
              "expired_wrong_password: the dead session is dropped")

        state, readings = scenario("settings_changed")
        check([r["result"] for r in readings] == ["ok", "ok"] and state["logins"] == 2,
              "settings_changed: new settings start a new session")

        state, _ = scenario("logout")
        check(open(os.path.join(out, "logout", "exit")).read().strip() == "0" and state["logouts"] == 1,
              "logout: modemhealth logout ends the session at the modem")
        check(open(os.path.join(out, "logout", "session_state")).read().strip() == "dropped", "logout: the session file is removed")

        # ----------------------------------------------------------- secrecy
        for name in ("good", "wrong_password", "unreachable"):
            text = files_text(os.path.join(out, name))
            check(PASSWORD not in text and "Pa ss" not in text, "%s: the password appears in no stored file or output" % name)
    finally:
        modem.terminate()
        shutil.rmtree(out, ignore_errors=True)

    print()
    if failures:
        print("%d check(s) failed" % len(failures))
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
