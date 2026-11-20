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
import re
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


ISPY_HEADER = ("ts,backend,server,ping_ms,jitter_ms,loss_pct,loaded_down_ms,loaded_up_ms,down_mbps,up_mbps,bytes,status,message,"
               "wan_down_mbps,wan_up_mbps,bg_down_mbps,bg_up_mbps,cpu_down_pct,cpu_up_pct,link_mbps,dev")
ISPY_CONFIG = "printf '%s\\n' \"config ispy 'main'\" \"\toption plan_down '1000'\" \"\toption plan_up '40'\" {} > /etc/config/ispy; "
ISPY_GONE = "rm -rf /etc/ispy /etc/config/ispy"


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


def config(host, password, data_dir, ping_host="modem", export_dir=None):
    return "\n".join([
        "config modemhealth 'main'",
        "\toption host %s" % uci_quote(host),
        "\toption username 'admin'",
        "\toption password %s" % uci_quote(password),
        "\toption timeout '5'",
        "\toption ping_host %s" % uci_quote(ping_host),
        "\toption data_dir %s" % uci_quote(data_dir)]
        + (["\toption export_dir %s" % uci_quote(export_dir)] if export_dir else [])
        + ["\toption subscriber 'Zoe Example'", ""])


def run_in_openwrt(out, scenarios):
    """scenarios: (name, config text, shell before, [shell after, [command]]);
    the command defaults to `modemhealth check`"""
    script = ["set -u", "cp -R /pkg/. /", "mkdir -p /www && cp -R /htdocs/. /www/", "chmod 755 /usr/bin/modemhealth", "mkdir -p /var/run"]
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
        "-v", os.path.join(ROOT, "luci-app-modemhealth", "htdocs") + ":/htdocs:ro",
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
        shutil.copy(os.path.join(ROOT, "tests", "fixtures", "outages", "readings.csv"), os.path.join(out, "outages_fixture.csv"))
        # ISPy's results file, as ISPy 1.2.0 writes it, with rows that must
        # not get through as they are: a failed test whose message holds
        # markup, values that are not numbers, a row without a time, a
        # status ISPy does not have.
        now = int(time.time())
        with open(os.path.join(out, "ispy.csv"), "w") as f:
            f.write("\n".join([
                ISPY_HEADER,
                "%d,cloudflare,SJC,12.1,0.4,0.0,30.6,60.7,930.01,39.79,1488019284,ok,,933.73,39.95,0.31,0.05,41,23,2500,eth0" % (now - 9000),
                "%d,cloudflare,SJC,12.1,0.4,0.0,30.6,60.7,701.50,38.20,1488019284,ok,,,,0.31,0.05,41,23,2500,eth0" % (now - 3000),
                "%d,cloudflare,,,,,,,,,0,error,<img src=x onerror=alert(1)> no route,,,0.02,0.00,,,2500,eth0" % (now - 2400),
                "%d,cloudflare,,,,,,,,,0,skipped,line busy (61.20 Mbit/s > 50),,,,,,,,eth0" % (now - 1800),
                "%d,ookla,x,1,1,0,1,1,<b>9</b>,1e3,1,ok,,\"7\",-5,,,,,2500,eth0" % (now - 1200),
                "%d,ookla,x,1,1,0,1,1,5,5,1,<script>,,5,5,,,,,2500,eth0" % (now - 900),
                "soon,ookla,x,1,1,0,1,1,5,5,1,ok,,5,5,,,,,2500,eth0",
                "%d,ookla,Example Fiber,13.379,0.099,,26.845,8.632,2342.23,297.90,3461861598,ok,,2351.02,298.11,0.01,0.00,,,2500,eth0" % (now - 600), ""]))
        # The same tests from a file with its columns in another order, and
        # a file that is not ISPy's results at all.
        with open(os.path.join(out, "ispy_other.csv"), "w") as f:
            f.write("status,up_mbps,down_mbps,ts,extra\nok,39.79,930.01,%d,x\nerror,,,%d,y\n" % (now - 9000, now - 2400))
        with open(os.path.join(out, "not_ispy.csv"), "w") as f:
            f.write("root:x:0:0:root:/root:/bin/ash\n%d,ok,1,1\n" % (now - 600))
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
        with open(os.path.join(out, "pw"), "w") as f:
            f.write(PASSWORD)
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
            # The line-up: a channel that loses lock and finds it again changes
            # nothing in it; a channel that moves adds one entry.
            ("lineup", config(host, PASSWORD, "/out/lineup/data"),
             "modemhealth check >/dev/null; " + CTL % "unlock=25,194" + "; modemhealth check >/dev/null; "
             + CTL % "unlock=" + "; modemhealth check >/dev/null; " + CTL % "retune=13:465000000"),
            # Once a day the line-up file is tidied: entries that say nothing
            # new go, and those from before the kept history, bar the newest
            # of each channel.
            ("lineup_tidy", config(host, PASSWORD, "/out/lineup_tidy/data"),
             "mkdir -p /out/lineup_tidy/data; n=$(date +%s); printf '%s\\n' ts,dir,ch,channel_id,modulation,freq_hz,width_hz "
             "1000,ds,1,20,256QAM,501000000, 1000,us,1,1,SC-QAM,16400000,6400000 2000,ds,1,20,Unknown,501000000, "
             "3000,ds,1,20,256QAM,501000000, 3000,us,1,1,SC-QAM,16400000,6400000 "
             "$((n-100)),ds,1,20,256QAM,501000000, $((n-50)),ds,2,99,256QAM,459000000, $((n-40)),ds,2,99,256QAM,459000000, "
             "> /out/lineup_tidy/data/channelmap.csv",
             "cat /var/run/modemhealth/lineup_tidied > /out/lineup_tidy/stamp; date +%Y-%m-%d >> /out/lineup_tidy/stamp"),
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
            # The internet doesn't answer pings (an outage) while the modem does.
            ("no_internet", config(host, PASSWORD, "/out/no_internet/data", ping_host="nonexistent.invalid"), ":"),
            # Web interface commands.
            ("web_status", config(host, PASSWORD, "/out/web_status/data"), "modemhealth check >/dev/null", ":", "modemhealth status"),
            ("web_data", config(host, PASSWORD, "/out/web_data/data"),
             "modemhealth check >/dev/null; modemhealth check >/dev/null",
             "modemhealth data $(( $(date +%s) + 3600 )) > /out/web_data/future.json", "modemhealth data 0"),
            # The line-up for a period: as it was at its start, and every change in it.
            ("web_lineup", config(host, PASSWORD, "/out/web_lineup/data"),
             "mkdir -p /out/web_lineup/data; printf '%s\\n' ts,dir,ch,channel_id,modulation,freq_hz,width_hz "
             "100,ds,1,20,256QAM,501000000, 100,us,1,1,SC-QAM,16400000,6400000 200,ds,1,20,Unknown,501000000, "
             "300,ds,1,20,256QAM,501000000, 400,us,1,1,SC-QAM,16400000,3200000 > /out/web_lineup/data/channelmap.csv",
             ":", "modemhealth data 250 350"),
            # ISPy's speed tests, when it is installed: the tests of the period,
            # numbers only. Its file is where its own settings say, or at its
            # default. (Every other scenario runs without ISPy.)
            ("speed", config(host, PASSWORD, "/out/speed/data", export_dir="/out/speed/drive/modemhealth"),
             ISPY_CONFIG.format("") + "mkdir -p /etc/ispy; cp /out/ispy.csv /etc/ispy/results.csv; modemhealth check >/dev/null; "
             "cp /out/speed/drive/modemhealth/modemhealth-report.html /out/speed/report.html",
             "modemhealth data 0 $(( $(date +%s) - 5000 )) > /out/speed/earlier.json; " + ISPY_GONE,
             "modemhealth data $(( $(date +%s) - 4000 ))"),
            ("speed_elsewhere", config(host, PASSWORD, "/out/speed_elsewhere/data"),
             ISPY_CONFIG.format("\"\toption results_file '/out/ispy_other.csv'\"")
             + "uci set ispy.main.plan_down='9\"},\"x\":\"1'; uci delete ispy.main.plan_up; uci commit ispy",
             ISPY_GONE, "modemhealth data 0"),
            ("speed_not_ispy", config(host, PASSWORD, "/out/speed_not_ispy/data"),
             ISPY_CONFIG.format("\"\toption results_file '/out/not_ispy.csv'\""),
             "uci set ispy.main.results_file=/etc/passwd; uci commit ispy; modemhealth data 0 > /out/speed_not_ispy/passwd.json; " + ISPY_GONE,
             "modemhealth data 0"),
            # The copy on a drive. /out is a folder of the host shared with the
            # container: to the backend, a mounted drive.
            ("export", config(host, PASSWORD, "/out/export/data", export_dir="/out/export/drive/modemhealth"),
             "modemhealth check >/dev/null; md5sum < /out/export/drive/modemhealth/modemhealth-report.html > /out/export/report1.md5; "
             "cp /out/export/drive/modemhealth/modemhealth-channels.csv /out/export/channels1.csv; mount > /out/export/mounts",
             "md5sum < /out/export/drive/modemhealth/modemhealth-report.html > /out/export/report2.md5; "
             "modemhealth status > /out/export/status.json; sleep 1; modemhealth export > /out/export/export.json; "
             "md5sum < /out/export/drive/modemhealth/modemhealth-report.html > /out/export/report3.md5; ls /out/export/drive/modemhealth > /out/export/ls"),
            # A folder that is not on a drive: nothing may be created there.
            ("export_nodrive", config(host, PASSWORD, "/out/export_nodrive/data", export_dir="/tmp/nodrive/modemhealth"),
             ":", "ls -d /tmp/nodrive > /out/export_nodrive/ls 2>&1; modemhealth status > /out/export_nodrive/status.json; "
             "logread 2>/dev/null | grep -c 'not saved' > /out/export_nodrive/logged || true"),
            # The drive comes back: the next check brings its files up to date.
            ("export_back", config(host, PASSWORD, "/out/export_back/data", export_dir="/tmp/nodrive/modemhealth"),
             "modemhealth check >/dev/null; modemhealth check >/dev/null; "
             "uci set modemhealth.main.export_dir=/out/export_back/drive/modemhealth; uci commit modemhealth"),
            # Clearing the history sets the copy on the drive aside under a dated name.
            ("clear", config(host, PASSWORD, "/out/clear/data", export_dir="/out/clear/drive/modemhealth"),
             "modemhealth check >/dev/null; modemhealth check >/dev/null",
             "ls /out/clear/drive/modemhealth > /out/clear/ls; cat /out/clear/data/readings/*.csv | wc -l > /out/clear/left; "
             "ls /out/clear/data > /out/clear/data_ls; modemhealth check >/dev/null; "
             "wc -l < /out/clear/drive/modemhealth/modemhealth-readings.csv > /out/clear/new",
             "modemhealth clear"),
            # The outages file, from the fixture the pages' own rule is held to.
            ("outages", config(host, PASSWORD, "/out/outages/data"), ":", ":",
             "sh -c 'MODEMHEALTH_LIB=1 . /usr/bin/modemhealth; load_config; outages_csv /out/outages_fixture.csv'"),
            # Test connection with what is typed (password in the environment),
            # storing nothing and leaving the kept session alone.
            ("web_test", config(host, "", "/out/web_test/data"), ":",
             "ls /var/run/modemhealth/session > /out/web_test/session 2>&1 || true",
             "MH_PASSWORD=$(cat /out/pw) modemhealth test"),
            ("web_test_bad", config(host, "", "/out/web_test_bad/data"), ":", ":",
             "MH_PASSWORD=wrong modemhealth test"),
            # The same from the GL.iNet panel, which can only pass arguments:
            # what is typed goes into a root-only file the backend made.
            ("web_test_file", config("192.0.2.1", "", "/out/web_test_file/data"),
             "f=$(modemhealth test-input); ls -ld /var/run/modemhealth \"$f\" > /out/web_test_file/ls; "
             "{ echo modem:%d; echo admin; cat /out/pw; } > \"$f\"; echo \"$f\" > /out/web_test_file/name" % PORT,
             "ls /var/run/modemhealth/ > /out/web_test_file/after; "
             "modemhealth test /etc/passwd > /out/web_test_file/other.txt; "
             "modemhealth test /var/run/modemhealth/test-input.x/../../../etc/passwd >> /out/web_test_file/other.txt; "
             "modemhealth test test-input.x >> /out/web_test_file/other.txt; "
             "grep -c root /etc/passwd > /out/web_test_file/passwd",
             "modemhealth test \"$f\""),
            # A new password saved from the web page goes to modemhealth_auth;
            # one kept with the settings by an older version is removed.
            ("set_password", config(host, "old-password", "/out/set_password/data"), ":",
             "ls -l /etc/config/modemhealth_auth > /out/set_password/auth_ls; "
             "grep -c \"option password\" /etc/config/modemhealth > /out/set_password/legacy || true; "
             "modemhealth check > /out/set_password/check.txt 2>&1",
             "modemhealth set-password < /out/pw"),
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

        r = stored(os.path.join(out, "good"), "readings")[0]
        check(r["modem_ping_loss"] == "0" and float(r["modem_ping_ms"]) > 0 and r["inet_ping_loss"] == "0" and float(r["inet_ping_ms"]) > 0,
              "pings: modem and internet pinged on every check (loss and average time stored)")
        r = stored(os.path.join(out, "unreachable"), "readings")[0]
        check(r["result"] == "failed" and r["modem_ping_loss"] != "" and r["inet_ping_loss"] != "",
              "pings: stored with failed readings too")
        r = stored(os.path.join(out, "no_internet"), "readings")[0]
        check(r["result"] == "ok" and r["inet_ping_loss"] == "100" and r["inet_ping_ms"] == "" and r["modem_ping_loss"] == "0",
              "pings: no answer from the internet is 100%% loss with no time; the modem still answers")

        d = os.path.join(out, "web_status")
        raw = open(os.path.join(d, "output.txt")).read()
        st = json.loads(raw)
        check(st["password_set"] is True and PASSWORD not in raw and "Pa ss" not in raw, "web status: says a password is set, never what it is")
        check(st["modem"].get("model") == "S34" and st["modem"].get("mac") == "00:00:5E:00:53:01", "web status: modem identity")
        check(st["last"].split(",")[1] == "ok" and st["readings_header"].startswith("ts,result,"), "web status: latest reading and its columns")
        check(st["enabled"] is True and st["interval"] == 5 and st["scheduler"] is False, "web status: settings and scheduler state")

        d = os.path.join(out, "web_data")
        data = json.loads(open(os.path.join(d, "output.txt")).read())
        lines = lambda k: [l for l in data[k].split("\n") if l]
        check(len(lines("readings")) == 3 and len(lines("channels")) == 1 + 2 * 39, "web data: readings and channels of both checks, with headers")
        check(len(lines("events")) == 1 + 87 and len(lines("channelmap")) == 1 + 39, "web data: events and the channel line-up")
        future = json.loads(open(os.path.join(d, "future.json")).read())
        check(len([l for l in future["readings"].split("\n") if l]) == 1, "web data: nothing outside the period asked for")

        lineup = json.loads(open(os.path.join(out, "web_lineup", "output.txt")).read())["channelmap"].split("\n")
        check(lineup[1:4] == ["200,ds,1,20,Unknown,501000000,", "100,us,1,1,SC-QAM,16400000,6400000", "300,ds,1,20,256QAM,501000000,"]
              and lineup[0].startswith("ts,dir,") and lineup[4:] == [""],
              "web data: the line-up as it was at the start of the period, then each change in it, nothing later (%s)" % lineup[1:])
        check(st.get("version") == "0.1.0", "web status: the version")

        # ------------------------------------------------ ISPy's speed tests
        check("speed" not in data and "speed" not in future, "speed tests: without ISPy the data says nothing about speed")
        d = os.path.join(out, "speed")
        sp = json.loads(open(os.path.join(d, "output.txt")).read())["speed"]
        tests = [l.split(",") for l in sp["tests"].split("\n") if l]
        check(tests[0] == "ts,status,down_mbps,up_mbps,wan_down_mbps,wan_up_mbps".split(",") and [t[1:] for t in tests[1:]] == [
            ["ok", "701.50", "38.20", "", ""], ["error", "", "", "", ""], ["ok", "", "", "", ""], ["ok", "2342.23", "297.90", "2351.02", "298.11"]],
            "speed tests: the tests of the period with their speeds; a skipped test, a row without a time and an unknown status are left out (%s)" % tests[1:])
        check(re.fullmatch(r"[a-z_0-9,.\n]+", sp["tests"]) is not None and [sp["plan_down"], sp["plan_up"]] == ["1000", "40"],
              "speed tests: nothing but numbers and the status gets through, whatever ISPy's file holds; the advertised speeds come from ISPy's settings")
        earlier = json.loads(open(os.path.join(d, "earlier.json")).read())["speed"]["tests"].split("\n")
        check(len(earlier) == 3 and earlier[1].endswith(",ok,930.01,39.79,933.73,39.95") and earlier[2] == "", "speed tests: only those of the period asked for")
        report = open(os.path.join(d, "report.html")).read()
        held = report.split('<pre hidden id="mh-speedtests">')[1].split("</pre>")[0].strip().split("\n")
        ctx = json.loads(report.split('<script type="application/json" id="mh-ctx">')[1].split("</script>")[0])
        check(len(held) == 1 + 5 and held[1].endswith(",ok,930.01,39.79,933.73,39.95") and ctx["speed"] == {"plan_down": "1000", "plan_up": "40"}
              and "onerror" not in report.split("<script>")[0] and "no route" not in report,
              "speed tests: the report file on the drive carries them and the advertised speeds, and nothing else of ISPy's file")
        sp = json.loads(open(os.path.join(out, "speed_elsewhere", "output.txt")).read())["speed"]
        check(sp["tests"].split("\n")[1:3] == ["%d,ok,930.01,39.79,," % (now - 9000), "%d,error,,,," % (now - 2400)]
              and sp["plan_down"] == '9"},"x":"1' and sp["plan_up"] == "",
              "speed tests: read from where ISPy's settings say, columns found by name; an advertised speed that is not a number stays text (%s)" % sp["plan_down"])
        other = json.loads(open(os.path.join(out, "speed_not_ispy", "output.txt")).read())
        passwd = json.loads(open(os.path.join(out, "speed_not_ispy", "passwd.json")).read())
        check("speed" not in other and "speed" not in passwd and "root" not in json.dumps(other) + json.dumps(passwd),
              "speed tests: a file that is not ISPy's results is not passed on, nor one that is not a .csv file")

        d = os.path.join(out, "web_test")
        res = json.loads(open(os.path.join(d, "output.txt")).read())
        check(res == {"ok": True, "model": "S34", "firmware": "AT01.01.010.042324_S3.04.735", "downstream": 34, "upstream": 5},
              "web test: logs in with the typed password and reports the modem (%s)" % res)
        check(stored(d, "readings") == [] and "No such file" in open(os.path.join(d, "session")).read(),
              "web test: stores nothing and keeps no session")
        check(json.load(open(os.path.join(d, "modem_state.json")))["logouts"] == 1, "web test: logs out afterwards")
        res = json.loads(open(os.path.join(out, "web_test_bad", "output.txt")).read())
        check(res == {"ok": False, "reason": "login_refused"}, "web test: a wrong password is reported as refused")

        d = os.path.join(out, "web_test_file")
        res = json.loads(open(os.path.join(d, "output.txt")).read())
        check(res.get("ok") is True and res.get("model") == "S34",
              "web test from a file: address, user name and password are read from it (%s)" % res)
        ls = open(os.path.join(d, "ls")).read().split("\n")
        check(ls[0].startswith("drwx------ ") and ls[1].startswith("-rw------- ") and "/var/run/modemhealth/test-input." in ls[1],
              "web test from a file: the file is root only, in a root-only folder")
        check("test-input" not in open(os.path.join(d, "after")).read(), "web test from a file: the file is removed once read")
        other = [json.loads(l) for l in open(os.path.join(d, "other.txt")).read().split("\n") if l]
        check(other == [{"ok": False, "reason": "bad_input"}] * 3 and open(os.path.join(d, "passwd")).read().strip() != "0",
              "web test from a file: any other file is refused and left alone")

        d = os.path.join(out, "set_password")
        check(json.loads(open(os.path.join(d, "output.txt")).read()) == {"ok": True}, "set password: done")
        check(open(os.path.join(d, "auth_ls")).read().startswith("-rw------- "), "set password: modemhealth_auth is root only")
        check(open(os.path.join(d, "legacy")).read().strip() == "0",
              "set password: the old password is removed from the settings (%r)" % open(os.path.join(d, "legacy")).read())
        check(open(os.path.join(d, "check.txt")).read().startswith("ok:"), "set password: checks log in with the new password")

        d = os.path.join(out, "daemon")
        state = json.load(open(os.path.join(d, "modem_state.json")))
        readings = stored(d, "readings")
        check(len(readings) == 1 and readings[0]["result"] == "ok", "daemon: checks at once on start")
        check(state["logouts"] == 1, "daemon: logs out of the modem when stopped")
        check(open(os.path.join(d, "left_running")).read().strip() == "", "daemon: stops when told to")

        d = os.path.join(out, "lineup")
        cmap, readings, ch = read_csv(os.path.join(d, "data", "channelmap.csv")), stored(d, "readings"), stored(d, "channels")
        t = [r["ts"] for r in readings]
        check(len(readings) == 4 and [c["ts"] for c in cmap].count(t[0]) == 39, "line-up: stored whole at the first check")
        check([(c["ts"], c["dir"], c["channel_id"], c["freq_hz"]) for c in cmap[39:]] == [(t[3], "ds", "13", "465000000")],
              "line-up: two channels losing lock and finding it again add nothing; a channel that moved adds one entry (%s)" % cmap[39:])
        check(not any(c["modulation"] == "Unknown" for c in cmap), "line-up: a channel that lost lock keeps its modulation")
        lost = [(c["channel_id"], c["lock"]) for c in ch if c["ts"] == t[1] and c["lock"] != "Locked"]
        check(sorted(lost) == [("194", "Not Locked"), ("25", "Not Locked")] and all(c["lock"] == "Locked" for c in ch if c["ts"] == t[2]),
              "line-up: the loss of lock itself is in the channel rows of that check")
        last = open(os.path.join(d, "data", "channelmap.last")).read().split("\n")
        check(len([l for l in last if l]) == 39 and "ds,2,13,256QAM,465000000," in last and "ds,34,194,OFDM PLC,957000000," in last,
              "line-up: the line-up of the latest check is kept for the next comparison")

        d = os.path.join(out, "lineup_tidy")
        cmap, readings = read_csv(os.path.join(d, "data", "channelmap.csv")), stored(d, "readings")
        before = [(c["ts"], c["dir"], c["channel_id"], c["modulation"]) for c in cmap if c["ts"] != readings[0]["ts"]]
        check(before[:2] == [("3000", "ds", "20", "256QAM"), ("1000", "us", "1", "SC-QAM")] and len(before) == 3 and before[2][1:3] == ("ds", "99"),
              "line-up tidy: of the entries before the kept history only the newest of each channel stays; repeats go (%s)" % before)
        stamp = open(os.path.join(d, "stamp")).read().split()
        check(len(stamp) == 2 and stamp[0] == stamp[1], "line-up tidy: done once a day")

        # --------------------------------------------------- copy on a drive
        d = os.path.join(out, "export")
        drive = os.path.join(d, "drive", "modemhealth")
        rows = lambda name: [l for l in open(os.path.join(drive, name)).read().split("\n") if l]
        check(sorted(open(os.path.join(d, "ls")).read().split()) == ["modemhealth-channels.csv", "modemhealth-events.csv", "modemhealth-lineup.csv",
              "modemhealth-outages.csv", "modemhealth-readings.csv", "modemhealth-report.html"], "copy: the history and the report are on the drive, and nothing else")
        check([len(rows("modemhealth-readings.csv")), len(rows("modemhealth-channels.csv")), len(rows("modemhealth-events.csv")),
               len(rows("modemhealth-lineup.csv")), len(rows("modemhealth-outages.csv"))] == [1 + 2, 1 + 2 * 39, 1 + 87, 1 + 39, 1],
              "copy: two checks' readings and channels, the events, the line-up and (no) outages, each with its header")
        first = open(os.path.join(d, "channels1.csv")).read()
        check(open(os.path.join(drive, "modemhealth-channels.csv")).read().startswith(first) and first.count("\n") == 1 + 39,
              "copy: the second check added its rows after the first check's, which were not rewritten")
        md5 = [open(os.path.join(d, "report%d.md5" % i)).read() for i in (1, 2, 3)]
        check(md5[0] == md5[1] and md5[2] != md5[0], "copy: the report file is not rewritten at every check, only when asked for (or once a day)")
        report = open(os.path.join(drive, "modemhealth-report.html")).read()
        check(report.startswith("<!doctype html>") and report.rstrip().endswith("</html>") and 'id="mh-readings"' in report
              and "MH_MODULES.report = function" in report and report.count("\n1") > 80 and "Zoe Example" in report,
              "copy: the report file carries the history, the report details and the report's code (%d KB)" % (len(report) // 1024))
        ctx = json.loads(report.split('<script type="application/json" id="mh-ctx">')[1].split("</script>")[0])
        check(ctx["modem"].get("mac") == "00:00:5E:00:53:01" and ctx["version"] == "0.1.0" and ctx["interval"] == 5 and ctx["sub"]["subscriber"] == "Zoe Example"
              and ctx["limits"] == {}, "copy: its settings are valid JSON with the modem's identity (%s)" % sorted(ctx))
        text = files_text(drive)
        check("mh-speedtests" not in report.split("<script>")[0] and ctx["speed"] == {"plan_down": "", "plan_up": ""},
              "copy: without ISPy the report file holds no speed tests")
        check(PASSWORD not in text and "Pa ss" not in text and "password" not in json.dumps(ctx).lower(),
              "copy: the modem password is in none of the files on the drive, and no setting of that name is carried")
        st = json.loads(open(os.path.join(d, "status.json")).read())
        check(st["export"]["dir"] == "/out/export/drive/modemhealth" and st["export"]["mounted"] is True and st["export"]["ok"] is True
              and abs(st["export"]["ts"] - time.time()) < 600, "copy: the status says where the copy goes and that it was saved (%s)" % st["export"])
        check("/out" in st["drives"], "copy: the shared folder is offered as a drive (%s)" % st["drives"])
        ex = json.loads(open(os.path.join(d, "export.json")).read())
        check(ex["ok"] is True and ex["mounted"] is True, "copy: 'save now' answers with the state of the copy")

        d = os.path.join(out, "export_nodrive")
        st = json.loads(open(os.path.join(d, "status.json")).read())
        check("No such file" in open(os.path.join(d, "ls")).read(), "no drive: nothing is created in a folder that is not on a drive")
        check(st["export"]["mounted"] is False and st["export"]["ok"] is False and st["export"]["message"] == "the folder is not on a connected drive",
              "no drive: the status says the copy was not saved, and why (%s)" % st["export"])
        check(stored(d, "readings")[0]["result"] == "ok", "no drive: the check itself is stored on the router as usual")

        d = os.path.join(out, "export_back")
        back = [l for l in open(os.path.join(d, "drive", "modemhealth", "modemhealth-readings.csv")).read().split("\n") if l]
        check(len(back) == 1 + 3 and [l.split(",")[0] for l in back[1:]] == [r["ts"] for r in stored(d, "readings")],
              "drive back: the next check brings the copy up to date with the checks made while it was away")

        d = os.path.join(out, "clear")
        names = sorted(open(os.path.join(d, "ls")).read().split())
        check(json.loads(open(os.path.join(d, "output.txt")).read()) == {"cleared": True} and len(names) == 6
              and all("-until-20" in n and n.startswith("modemhealth-") for n in names) and sum(n.endswith(".html") for n in names) == 1,
              "clear: the copy on the drive is kept under dated names (%s)" % names[:2])
        kept = [n for n in os.listdir(os.path.join(d, "drive", "modemhealth")) if n.startswith("modemhealth-readings-until-")]
        check(len(kept) == 1 and open(os.path.join(d, "drive", "modemhealth", kept[0])).read().count("\n") == 1 + 2, "clear: with the two checks it held")
        check(open(os.path.join(d, "left")).read().strip() == "1" and "channelmap.last" not in open(os.path.join(d, "data_ls")).read()
              and "events.seen" not in open(os.path.join(d, "data_ls")).read(), "clear: the router's own history is empty")
        check(open(os.path.join(d, "new")).read().strip() == "2", "clear: the next check starts new files on the drive")

        expected = json.load(open(os.path.join(ROOT, "tests", "fixtures", "outages", "expected.json")))
        got = read_csv(os.path.join(out, "outages", "output.txt"))
        norm = [dict(start=int(o["start"]), end=int(o["end"]), kind=o["kind"], checks=int(o["checks"]), minS=int(o["min_s"]),
                     maxS=int(o["max_s"]) if o["max_s"] else None, ongoing=o["ongoing"] == "1") for o in got]
        check(norm == expected, "outages file: the same five outages as the pages find in the shared fixture (%d)" % len(norm))
        check(all(len(o["start_time"]) == 19 and o["start_time"][:2] == "20" for o in got), "outages file: with the time in words")

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
