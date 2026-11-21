#!/usr/bin/env python3
"""Backend test for T-Mobile 5G gateways: the real `modemhealth check`, in an
OpenWrt 23.05 container, against tests/fake_gateway.py in three shapes
(KVD21 with both radios on "port 80", G4AR on 5G only on "port 8080", G5AR
with a null 4G block and no clock). Checks detection, what is stored for a
good check, tower/band changes and restarts, values outside the 3GPP
ranges, every kind of failure, Test connection and the data reply.

The fixtures are synthetic (#28): nobody on the project has a gateway.
Needs docker and python3. Run: python3 tests/backend_gateway.test.py
"""
import csv
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMAGE = "modemhealth-test-openwrt"
FAKES = {"kvd21": (18781, 18782), "g4ar": (18783, 18784), "g5ar": (18785, 18786)}
failures = []


def check(cond, what):
    print(("ok   " if cond else "FAIL ") + what)
    if not cond:
        failures.append(what)


def config(host, data_dir, modem_type="auto", password=None):
    lines = ["config modemhealth 'main'", "\toption modem_type '%s'" % modem_type, "\toption host '%s'" % host,
             "\toption username 'admin'", "\toption timeout '3'", "\toption ping_host 'gw'", "\toption data_dir '%s'" % data_dir, ""]
    return "\n".join(lines) + ("\nconfig auth 'main'\n\toption password '%s'\n" % password if password else "")


def rows(d, kind):
    out = []
    folder = os.path.join(d, kind)
    if os.path.isdir(folder):
        for name in sorted(os.listdir(folder)):
            with open(os.path.join(folder, name)) as f:
                out += list(csv.DictReader(f))
    return out


def main():
    subprocess.run(["docker", "build", "-q", "--platform", "linux/amd64", "-t", IMAGE, os.path.join(ROOT, "tests", "openwrt")],
                   check=True, stdout=subprocess.DEVNULL)
    fakes = [subprocess.Popen([sys.executable, os.path.join(ROOT, "tests", "fake_gateway.py"), "--model", m, "--bind", "0.0.0.0",
                               "--port", str(a), "--port", str(b)], stdout=subprocess.DEVNULL) for m, (a, b) in FAKES.items()]
    os.makedirs(os.path.join(ROOT, ".test-out"), exist_ok=True)
    out = tempfile.mkdtemp(prefix="gateway-", dir=os.path.join(ROOT, ".test-out"))
    try:
        for _, (a, _b) in FAKES.items():
            for _ in range(50):
                try:
                    socket.create_connection(("127.0.0.1", a), timeout=0.2).close()
                    break
                except OSError:
                    time.sleep(0.1)
        k1, k2 = FAKES["kvd21"]
        g1, _ = FAKES["g4ar"]
        f1, _ = FAKES["g5ar"]

        def ctl(port, what):
            return "curl -s 'http://gw:%d/_control/%s' >/dev/null" % (port, what)

        steps = []

        def scenario(name, cfg, before=":", command="modemhealth check", env="", keep=False):
            data = "/out/%s/data" % name
            steps.append("mkdir -p /out/%s" % name)
            if not keep:
                steps.append("rm -rf /var/run/modemhealth")
            with open(os.path.join(out, name + ".uci"), "w") as f:
                f.write(cfg.replace("DATA", data))
            steps.append("cp /out/%s.uci /etc/config/modemhealth; touch -d '2000-01-01 00:00:00' /etc/config/modemhealth" % name)
            steps.append(before)
            steps.append("%s %s > /out/%s/output.txt 2>&1; echo $? > /out/%s/exit" % (env, command, name, name))

        # 1. Detection: a KVD21 whose API is on the second port ("80").
        both = "MODEMHEALTH_GW_PORTS='%d %d'" % (k1, k2)
        scenario("kvd21", config("gw", "DATA"), ctl(k1, "reset"), env=both)
        steps.append("cp /var/run/modemhealth/device /var/run/modemhealth/gateway.port /out/kvd21/ 2>/dev/null")
        # 2. The same gateway again: nothing changed; then a new tower and band; then a restart.
        steps.append("sleep 1")
        scenario("kvd21", config("gw", "DATA"), ":", env=both, keep=True)
        steps.append("cp /out/kvd21/output.txt /out/kvd21/output2.txt")
        scenario("kvd21", config("gw", "DATA"), ctl(k1, "set?cell=1777001&band=n71"), env=both, keep=True)
        steps.append("cp /out/kvd21/output.txt /out/kvd21/output3.txt")
        scenario("kvd21", config("gw", "DATA"), ctl(k1, "set?restart=1"), env=both, keep=True)
        steps.append("cp /out/kvd21/output.txt /out/kvd21/output4.txt")
        # 3. The 5G radio goes away.
        scenario("kvd21", config("gw", "DATA"), ctl(k1, "set?drop=5g"), env=both, keep=True)
        steps.append("cp /out/kvd21/output.txt /out/kvd21/output5.txt")
        # data reply and status of that history
        steps.append("modemhealth data 0 > /out/kvd21/data.json; modemhealth status > /out/kvd21/status.json")
        # 4. A G4AR on 5G only, its API on "8080", the address with a port.
        scenario("g4ar", config("gw:%d" % g1, "DATA", "tmobile"), ctl(g1, "reset"))
        # 4b. Restarts (#39), on the G5AR's fake before its own check (which
        # resets the fake's request log). Off unless gw_restart=1.
        gwr = config("gw:%d" % f1, "DATA", "tmobile")
        pw = "echo label-password | modemhealth set-password >/dev/null; "
        on = "uci set modemhealth.main.gw_restart=1; uci commit modemhealth; "
        scenario("gw_restart_off", gwr, ctl(f1, "reset") + "; " + ctl(f1, "set?allow_reboot=1") + "; " + pw, command="modemhealth restart")
        steps.append("curl -s http://gw:%d/_control/log > /out/gw_restart_off/gw_log.json" % f1)
        scenario("gw_restart_ok", gwr, ctl(f1, "reset") + "; " + ctl(f1, "set?allow_reboot=1") + "; " + pw + on, command="modemhealth restart")
        steps.append("curl -s http://gw:%d/_control/log > /out/gw_restart_ok/gw_log.json" % f1)
        # A refused password: one login, then never again until it is changed.
        scenario("gw_restart_refused", gwr, ctl(f1, "reset") + "; " + ctl(f1, "set?allow_reboot=1")
                 + "; echo wrong | modemhealth set-password >/dev/null; " + on, command="modemhealth restart")
        steps.append("sleep 1; modemhealth restart > /out/gw_restart_refused/again.txt; "
                     "curl -s http://gw:%d/_control/log > /out/gw_restart_refused/gw_log.json; " % f1
                     + "sleep 1; echo label-password | modemhealth set-password >/dev/null; modemhealth restart > /out/gw_restart_refused/changed.txt")
        # Automatic restart of a gateway with no connection (gw_restart=1).
        scenario("gw_auto", gwr, ctl(f1, "reset") + "; " + ctl(f1, "set?allow_reboot=1") + "; " + pw + on
                 + "uci set modemhealth.main.restart_auto=1; uci set modemhealth.main.ping_host=nonexistent.invalid; uci commit modemhealth; "
                 "modemhealth check >/dev/null; echo \"$(( $(date +%s) - 660 )) 0\" > /var/run/modemhealth/auto")
        steps.append("curl -s http://gw:%d/_control/log > /out/gw_auto/gw_log.json" % f1)
        steps.append(ctl(f1, "reset"))
        # 5. A G5AR: 4G block null, no clock, two bands.
        scenario("g5ar", config("gw:%d" % f1, "DATA", "tmobile"), ctl(f1, "reset"))
        # 6. Values outside what 3GPP lets a device report.
        scenario("garbage_values", config("gw:%d" % g1, "DATA", "tmobile"), ctl(g1, "set?rsrp=-500&sinr=99&rsrq=-80&bars=9"))
        # 7. Failures.
        scenario("http_404", config("gw:%d" % g1, "DATA", "tmobile"), ctl(g1, "reset") + "; " + ctl(g1, "set?status=404"))
        scenario("not_json", config("gw:%d" % g1, "DATA", "tmobile"), ctl(g1, "reset") + "; " + ctl(g1, "set?garbage=1"))
        scenario("timeout", config("gw:%d" % g1, "DATA", "tmobile"), ctl(g1, "reset") + "; " + ctl(g1, "set?hang=1"))
        scenario("unreachable", config("gw:18799", "DATA", "tmobile"), ctl(g1, "reset"))
        # 8. Detect, with nothing answering like a gateway: not remembered.
        scenario("auto_nothing", config("gw", "DATA"), ":", env="MODEMHEALTH_GW_PORTS='18799 18798'")
        steps.append("ls /var/run/modemhealth/ > /out/auto_nothing/run_dir.txt")
        # 9. Test connection (with what is typed: the address).
        scenario("test", config("192.168.100.1", "DATA"), ctl(k1, "reset"),
                 command="MH_HOST=gw:%d modemhealth test" % k2)
        # 10. A SURFboard's address is never asked as a gateway.
        scenario("surfboard_addr", config("192.168.100.1", "DATA"), ctl(k1, "reset"), env=both)
        steps.append("curl -s http://gw:%d/_control/log > /out/surfboard_addr/gw_log.json" % k1)

        script = ["set -u", "cp -R /pkg/. /", "mkdir -p /www && cp -R /htdocs/. /www/", "chmod 755 /usr/bin/modemhealth",
                  "mkdir -p /var/run /var/state"] + steps
        subprocess.run(["docker", "run", "--rm", "--platform", "linux/amd64", "--add-host", "gw:host-gateway",
                        "-v", os.path.join(ROOT, "luci-app-modemhealth", "root") + ":/pkg:ro",
                        "-v", os.path.join(ROOT, "luci-app-modemhealth", "htdocs") + ":/htdocs:ro",
                        "-v", out + ":/out", IMAGE, "sh", "-c", "\n".join(script)], check=True, timeout=600)

        def o(name, f="output.txt"):
            p = os.path.join(out, name, f)
            return open(p).read() if os.path.exists(p) else ""

        # --- KVD21
        d = os.path.join(out, "kvd21", "data")
        rd = rows(d, "readings")
        ra = rows(d, "radios")
        ev = rows(d, "events")
        check(o("kvd21", "device").strip() == "tmobile" and o("kvd21", "gateway.port").strip() == str(k2),
              "detect: a gateway is found on the port it answers on (the second), and remembered")
        first = rd[0] if rd else {}
        check(first.get("result") == "ok" and first.get("model") == "KVD21" and first.get("firmware") == "1.00.18"
              and first.get("connectivity") == "registered" and first.get("network_access") == "home",
              "good check: model, firmware, registration and home network stored (%s)" % {k: first.get(k) for k in ("result", "reason", "model", "connectivity")})
        check(first.get("uptime_s", "").isdigit() and int(first["uptime_s"]) >= 30996 and first.get("modem_time", "").startswith("20"),
              "good check: the gateway's uptime and clock stored")
        r1 = [r for r in ra if r["ts"] == first.get("ts")]
        check([r["tech"] for r in r1] == ["lte", "nr"], "good check: one row per radio, 4G then 5G (%s)" % [r["tech"] for r in r1])
        lte = r1[0] if r1 else {}
        nr = r1[1] if len(r1) > 1 else {}
        check(lte.get("bands") == "b2" and lte.get("bars") == "3" and lte.get("rsrp_dbm") == "-100" and lte.get("rsrq_db") == "-10"
              and lte.get("rssi_dbm") == "-87" and lte.get("sinr_db") == "8" and lte.get("cell") == "310463-12",
              "good check: 4G band, bars, RSRP, RSRQ, RSSI, SINR and tower stored as reported (%s)" % lte)
        check(nr.get("bands") == "n41" and nr.get("rsrp_dbm") == "-98" and nr.get("cell") == "1588321-141", "good check: 5G stored as reported")
        check(o("kvd21", "output2.txt").startswith("ok:") and not [e for e in ev if int(e["first_seen_ts"]) <= int(rd[1]["ts"])] if len(rd) > 1 else False,
              "unchanged: no event when the towers and bands are the same")
        msgs = [e["message"] for e in ev]
        check("Tower change on 4G: 310463-12 to 1777001-12" in msgs and "Tower change on 5G: 1588321-141 to 1777001-141" in msgs,
              "tower change: an event for each radio, old and new tower (%s)" % msgs)
        check("Band change on 5G: n41 to n71" in msgs and "tower/band change" in o("kvd21", "output3.txt"), "band change: an event, and the check says so")
        check(len(rd) >= 4 and rd[3].get("reboot") == "1" and rd[3].get("boot_ts", "").isdigit() and "restarted" in o("kvd21", "output4.txt"),
              "restart: found from the gateway's uptime")
        check("5G radio no longer connected" in msgs and rows(d, "radios")[-1]["tech"] == "lte", "a radio that goes away: an event, and only the other one stored")
        info = dict(l.split("=", 1) for l in open(os.path.join(d, "modem.txt")).read().splitlines() if "=" in l)
        check(info.get("type") == "tmobile" and info.get("model") == "KVD21" and info.get("maker") == "Arcadyan", "modem.txt names the gateway")
        try:
            data = json.loads(o("kvd21", "data.json"))
            status = json.loads(o("kvd21", "status.json"))
        except ValueError as e:
            data, status = {}, {}
            check(False, "data and status are JSON: %s" % e)
        check(data.get("radios", "").startswith("ts,tech,bands,bars,rsrp_dbm") and data["radios"].count("\n") == len(ra) + 1,
              "data reply: the radios with their header")
        check(status.get("modem", {}).get("type") == "tmobile", "status names the device type")

        # --- G4AR, G5AR
        ra = rows(os.path.join(out, "g4ar", "data"), "radios")
        check(o("g4ar").startswith("ok:") and [r["tech"] for r in ra] == ["nr"] and ra[0]["sinr_db"] == "23",
              "5G only (G4AR): one radio, nothing invented for 4G")
        rd = rows(os.path.join(out, "g5ar", "data"), "readings")
        ra = rows(os.path.join(out, "g5ar", "data"), "radios")
        check(o("g5ar").startswith("ok:") and [r["tech"] for r in ra] == ["nr"] and ra[0]["bands"] == "n41 n25" and ra[0]["bars"] == "2",
              "G5AR: a null 4G block is no radio; both bands kept; bars 2.0 stored as 2")
        check(rd and rd[0]["uptime_s"] == "" and rd[0]["modem_time"] == "" and rd[0]["reboot"] == "0",
              "G5AR without a clock: uptime and clock left empty, never guessed")
        ra = rows(os.path.join(out, "garbage_values", "data"), "radios")
        check(ra and ra[0]["rsrp_dbm"] == "" and ra[0]["sinr_db"] == "" and ra[0]["rsrq_db"] == "" and ra[0]["bars"] == "" and ra[0]["rssi_dbm"] == "-83",
              "values outside the 3GPP reporting ranges are stored empty, not as signal (%s)" % (ra[0] if ra else None))

        # --- failures
        for name, reason in (("http_404", "http_404"), ("not_json", "not_a_supported_device"), ("timeout", "timeout"), ("unreachable", "unreachable")):
            rd = rows(os.path.join(out, name, "data"), "readings")
            check(len(rd) == 1 and rd[0]["result"] == "failed" and rd[0]["reason"] == reason and o(name, "exit").strip() == "1"
                  and not rows(os.path.join(out, name, "data"), "radios"),
                  "%s: stored as failed with reason %s, no radios (%s)" % (name, reason, rd[0] if rd else o(name)))
        check(o("auto_nothing", "run_dir.txt").find("device") < 0, "detect: nothing answering like a gateway is not remembered as anything")

        # --- restarts
        def j(name, f="output.txt"):
            try:
                return json.loads(o(name, f))
            except ValueError:
                return {}

        def gwlog(name):
            try:
                return [r["method"] + " " + r["path"] for r in json.loads(o(name, "gw_log.json"))]
            except ValueError:
                return []

        check(j("gw_restart_off") == {"ok": False, "device": "tmobile", "reason": "restart_not_enabled"}
              and not [p for p in gwlog("gw_restart_off") if p.startswith("POST")],
              "gateway restart: off unless gw_restart=1, and nothing is sent (%s)" % o("gw_restart_off"))
        check(j("gw_restart_ok").get("ok") is True and gwlog("gw_restart_ok")[-2:] == ["POST /TMI/v1/auth/login", "POST /TMI/v1/gateway/reset?set=reboot"],
              "gateway restart: one login, then the reboot with its token (%s)" % gwlog("gw_restart_ok"))
        f = os.path.join(out, "gw_restart_ok", "data", "restarts.csv")
        rs = list(csv.DictReader(open(f))) if os.path.exists(f) else []
        check(rs and rs[0]["result"] == "ok" and rs[0]["trigger"] == "manual", "gateway restart: recorded")
        check(j("gw_restart_refused").get("reason") == "login_refused" and j("gw_restart_refused", "again.txt").get("reason") == "restart_password_refused_before"
              and gwlog("gw_restart_refused").count("POST /TMI/v1/auth/login") == 1,
              "gateway restart, refused password: one login only; never tried again (%s)" % gwlog("gw_restart_refused"))
        check(j("gw_restart_refused", "changed.txt").get("ok") is True, "gateway restart: a changed password is tried again")
        f = os.path.join(out, "gw_auto", "data", "restarts.csv")
        rs = list(csv.DictReader(open(f))) if os.path.exists(f) else []
        check(rs and rs[0]["trigger"] == "down" and rs[0]["result"] == "ok" and "no answer from nonexistent.invalid" in rs[0]["detail"]
              and "POST /TMI/v1/gateway/reset?set=reboot" in gwlog("gw_auto"), "gateway: restarted automatically after no connection (%s)" % rs)
        for name in ("gw_restart_ok", "gw_restart_refused"):
            text = ""
            for dp, _, names in os.walk(os.path.join(out, name)):
                for n in names:
                    text += open(os.path.join(dp, n), errors="replace").read()
            check("label-password" not in text, "%s: the password appears in no stored file or output" % name)

        # --- Test connection
        try:
            t = json.loads(o("test"))
        except ValueError:
            t = {}
        check(t.get("ok") is True and t.get("type") == "tmobile" and t.get("model") == "KVD21" and len(t.get("radios", [])) == 2
              and t["radios"][1] == {"tech": "nr", "bands": "n41", "bars": 3, "rsrp": -98, "rsrq": -11, "sinr": 6},
              "test connection: names the gateway and its radios (%s)" % t)
        log = json.load(open(os.path.join(out, "surfboard_addr", "gw_log.json")))
        check(not log, "a SURFboard's address (192.168.100.1) is never asked for the gateway API")
        allpaths = []
        for m, (a, _b) in FAKES.items():
            try:
                import urllib.request
                allpaths += [r["method"] + " " + r["path"] for r in json.load(urllib.request.urlopen("http://127.0.0.1:%d/_control/log" % a))]
            except Exception:
                pass
        check(all(p == "GET /TMI/v1/gateway?get=all" for p in allpaths), "the backend asks the gateway for nothing but the open status read (%s)" % sorted(set(allpaths)))
    finally:
        for f in fakes:
            f.terminate()
        subprocess.run(["docker", "run", "--rm", "-v", out + ":/out", IMAGE, "sh", "-c", "rm -rf /out/*"], stdout=subprocess.DEVNULL)
        shutil.rmtree(out, ignore_errors=True)
    print("\nall checks passed" if not failures else "\n%d check(s) failed" % len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
