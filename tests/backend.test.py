#!/usr/bin/env python3
"""Backend test: the real `modemhealth check` against the fake modem.

Runs the backend inside an OpenWrt 23.05 container (the same sh, curl,
openssl and jsonfilter as on the router) and checks what it stored.
Needs docker and python3.

Usage: python3 tests/backend.test.py
"""

import csv
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
    """scenarios: list of (name, config text, shell run before the check)"""
    script = ["set -u", "cp -R /pkg/. /", "chmod 755 /usr/bin/modemhealth", "mkdir -p /var/run"]
    for name, cfg, before in scenarios:
        with open(os.path.join(out, name + ".uci"), "w") as f:
            f.write(cfg)
        script += [
            "mkdir -p /out/%s" % name,
            "cp /out/%s.uci /etc/config/modemhealth" % name,
            before,
            "modemhealth check > /out/%s/output.txt 2>&1; echo $? > /out/%s/exit" % (name, name),
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
        run_in_openwrt(out, [
            ("good", config(host, PASSWORD, "/out/good/data"), ":"),
            ("wrong_password", config(host, PASSWORD + "x", "/out/wrong_password/data"), ":"),
            ("no_password", config(host, "", "/out/no_password/data"), ":"),
            ("unreachable", config("modem:1", PASSWORD, "/out/unreachable/data"), ":"),
        ])

        # ------------------------------------------------------------ good
        d = os.path.join(out, "good")
        state = json.load(open(os.path.join(d, "modem_state.json")))
        output = open(os.path.join(d, "output.txt")).read()
        check(open(os.path.join(d, "exit")).read().strip() == "0", "good: check exits 0 (%s)" % output.strip())
        check(state["bad_signatures"] == 0, "good: every HNAP_AUTH signature verified by the fake modem")
        check(state["logins"] == 1 and state["login_failures"] == 0, "good: logged in once with the password proof")
        check(state["status_reads"] == 1, "good: read all status pages in one request")
        check(state["logouts"] == 1, "good: logged out afterwards")

        readings = read_csv(os.path.join(d, "data", "readings.csv"))
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

        ch = read_csv(os.path.join(d, "data", "channels.csv"))
        ds = [c for c in ch if c["dir"] == "ds"]
        us = [c for c in ch if c["dir"] == "us"]
        check(len(ds) == 34 and len(us) == 5, "good: 39 channel rows stored")
        check(all(c["ts"] == r["ts"] for c in ch), "good: channel rows carry the reading's timestamp")
        first = {k: ds[0][k] for k in ("ch", "lock", "modulation", "channel_id", "freq_hz", "power_dbmv", "snr_db", "corrected", "uncorrectable")}
        check(first == {"ch": "1", "lock": "Locked", "modulation": "256QAM", "channel_id": "20", "freq_hz": "501000000",
                        "power_dbmv": "0.9", "snr_db": "40.9", "corrected": "627773", "uncorrectable": "6793"},
              "good: downstream channel 1 parsed (leading space in power trimmed)")
        neg = [c for c in ds if c["ch"] == "29"][0]
        check(neg["power_dbmv"] == "-1.4", "good: negative power kept")
        ofdm = [c for c in ds if c["channel_id"] == "194"][0]
        check(ofdm["modulation"] == "OFDM PLC" and ofdm["corrected"] == "15038563" and ofdm["uncorrectable"] == "184527",
              "good: OFDM downstream channel parsed")
        last = {k: us[-1][k] for k in ("ch", "lock", "modulation", "channel_id", "freq_hz", "width_hz", "power_dbmv", "snr_db")}
        check(last == {"ch": "5", "lock": "Locked", "modulation": "OFDMA", "channel_id": "41", "freq_hz": "36200000",
                       "width_hz": "44400000", "power_dbmv": "44.5", "snr_db": ""},
              "good: upstream OFDMA channel parsed (frequency and width in the right columns)")
        check(us[0]["power_dbmv"] == "50.5" and us[0]["freq_hz"] == "16400000", "good: upstream SC-QAM channel 1")

        info = dict(line.split("=", 1) for line in open(os.path.join(d, "data", "modem.txt")).read().splitlines())
        check(info.get("mac") == "00:00:5E:00:53:01" and info.get("docsis") == "DOCSIS 3.1", "good: modem identity saved")

        # --------------------------------------------------------- failures
        for name, reason in (("wrong_password", "login_refused"), ("no_password", "no_password"),
                             ("unreachable", "unreachable")):
            d = os.path.join(out, name)
            readings = read_csv(os.path.join(d, "data", "readings.csv"))
            check(open(os.path.join(d, "exit")).read().strip() != "0", "%s: check exits non-zero" % name)
            check(len(readings) == 1 and readings[0]["result"] == "failed" and readings[0]["reason"] == reason,
                  "%s: stored as a failed reading, reason %s (got %s)" % (name, reason, readings[0]["reason"] if readings else "none"))
            check(len(read_csv(os.path.join(d, "data", "channels.csv"))) == 0, "%s: no channel rows" % name)
        state = json.load(open(os.path.join(out, "wrong_password", "modem_state.json")))
        check(state["login_failures"] == 1 and state["status_reads"] == 0, "wrong_password: no status read after a refused login")
        state = json.load(open(os.path.join(out, "no_password", "modem_state.json")))
        check(state["requests"] == 0, "no_password: the modem is not contacted")

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
