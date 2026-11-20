#!/usr/bin/env python3
"""tools/capture.py: what identifies a subscriber is replaced before anything
is saved, and only that.

Three ways: the replacing itself on text made for it; the tool run against
the fake modem holding the S34 replies with identifiers put back in; and the
tool run against a modem with another kind of login, which shows its status
pages to anyone.

Run: python3 tests/capture.test.py
"""

import http.server
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOL = os.path.join(ROOT, "tools", "capture.py")
PORT, OPEN_PORT = 18447, 18448
PASSWORD = "Pa ss,w\"o'r$d"
# Made up, but shaped like the real thing (the fixtures hold documentation values).
MAC, CMTS, SERIAL, PUBLIC_IP = "F8:79:0A:12:34:56", "00:01:5C:AB:CD:EF", "4C2B8N123456789", "73.12.34.56"

spec = importlib.util.spec_from_file_location("capture", TOOL)
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)

failed = 0


def check(cond, what):
    global failed
    print(("ok   " if cond else "FAIL ") + what)
    if not cond:
        failed += 1


def wait_for(port):
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            return
        except OSError:
            time.sleep(0.1)


def run_tool(args, out):
    env = dict(os.environ, MODEM_PASSWORD=PASSWORD)
    return subprocess.run([sys.executable, TOOL, "--out", out] + args, env=env, capture_output=True, text=True, timeout=120)


def folder_text(folder):
    return "".join(open(os.path.join(folder, n), errors="replace").read() for n in sorted(os.listdir(folder)))


def main():
    # ------------------------------------------------------------ replacing
    r = capture.Redactor()
    page = "\n".join([
        '{"StatusSoftwareMac": "%s", "StatusSoftwareSerialNum": "%s"}' % (MAC, SERIAL),
        "<tr><td>Serial Number</td><td> ABC1234567 </td></tr>",
        "CM-MAC=%s;CMTS-MAC=%s;CM-QOS=1.1;CM-VER=3.1;" % (MAC.lower(), CMTS),
        "HFC MAC f8-79-0a-12-34-56, also f8790a123456 and F879.0A12.3456",
        "WebGUI login from %s; again from %s; then 98.76.54.32; inside the provider 100.64.1.2" % (PUBLIC_IP, PUBLIC_IP),
        "modem 192.168.100.1 router 192.168.8.1 lan 10.0.0.5 self 127.0.0.1 mask 255.255.255.0 group 239.255.255.250",
        "IPv6 2601:646:8f00:1234:fa79:aff:fe12:3456 link fe80::fa79:aff:fe12:3456 loop ::1",
        "serial again: %s." % SERIAL,
    ])
    r.learn(page)
    got = r.apply(page).split("\n")
    check(got[0] == '{"StatusSoftwareMac": "00:00:5E:00:53:01", "StatusSoftwareSerialNum": "000000000000000"}',
          "replacing: the modem's MAC address and serial number (%s)" % got[0])
    check(got[1] == "<tr><td>Serial Number</td><td> 0000000000 </td></tr>", "replacing: a serial number in a table of a status page")
    check(got[2] == "CM-MAC=00:00:5E:00:53:01;CMTS-MAC=00:00:5E:00:53:02;CM-QOS=1.1;CM-VER=3.1;",
          "replacing: the same address gets the same value however it is written; another address another value")
    check(got[3] == "HFC MAC 00:00:5E:00:53:01, also 00005E005301 and 0000.5E00.5301", "replacing: with dashes, without separators and in fours")
    check(got[4] == "WebGUI login from 203.0.113.1; again from 203.0.113.1; then 203.0.113.2; inside the provider 203.0.113.3",
          "replacing: public IP addresses, each with its own value, and one from the provider's own network")
    check(got[5] == page.split("\n")[5], "replacing: addresses that say nothing about the subscriber are kept (the modem's own, home networks, masks)")
    check(got[6] == "IPv6 2001:db8::1 link 2001:db8::2 loop ::1", "replacing: IPv6 addresses, the link-local one too (it holds the MAC address); not the loopback")
    check(got[7] == "serial again: 000000000000000.", "replacing: the serial number wherever else it appears")
    check(r.summary() == "2 MAC addresses, 2 serial numbers, 5 public IP addresses", "replacing: says what it replaced (%s)" % r.summary())

    keep = "\n".join([
        "firmware AT01.01.010.042324_S3.04.735 and D30CM-OSPREY-2.4.0.1-GA-02-NOSH, jQuery v1.12.4, OID 1.3.6.1.4.1.4115",
        "11/19/2026 12:06:13 uptime 0 day(s) 01h:46m:05s time 14:13:54",
        "1^Locked^256QAM^20^501000000^ 0.8^40.9^11^0^|+|2^Locked^256QAM^13^459000000^ 1.2^40.4^12^0^",
        "a::before{content:''} .c:hover a:b ?x=1:2:3 var a={b:1,c:2,d:3,e:4,f:5,aa:6,bb:7,cc:8};",
        "Honoring MDD; IP provisioning mode = IPv6; config d11_m_s34_speed2000.cm",
        "version 300.400.500.600 and 1.2.3",
    ])
    r2 = capture.Redactor()
    r2.learn(keep)
    check(r2.apply(keep) == keep and r2.summary() == "0 MAC addresses, 0 serial numbers, 0 public IP addresses",
          "replacing: firmware versions, times, channel rows, script and the configuration file name are left alone")
    again = capture.Redactor()
    check(again.apply(r.apply(page)) == r.apply(page), "replacing: documentation values are not replaced again")

    work = tempfile.mkdtemp(prefix="capture-")
    modem = web = None
    try:
        # ------------------------------------------- an S34, with identifiers
        fixtures = os.path.join(work, "fixtures")
        os.makedirs(fixtures)
        src = os.path.join(ROOT, "tests", "fixtures", "s34")
        for name in os.listdir(src):
            if name.endswith(".json"):
                text = open(os.path.join(src, name)).read()
                text = text.replace("00:00:5E:00:53:01", MAC).replace("00:00:5E:00:53:02", CMTS).replace("000000000000000", SERIAL).replace("203.0.113.7", PUBLIC_IP)
                open(os.path.join(fixtures, name), "w").write(text)
        original = folder_text(fixtures)
        check(MAC in original and CMTS in original and SERIAL in original, "S34: the fake modem's replies now hold a MAC address, the provider's and a serial number")
        modem = subprocess.Popen([sys.executable, os.path.join(ROOT, "tests", "fake_modem.py"), "--port", str(PORT), "--password", PASSWORD, "--fixtures", fixtures],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait_for(PORT)
        out = os.path.join(work, "modem-capture")
        res = run_tool(["--host", "127.0.0.1:%d" % PORT], out)
        saved = sorted(os.listdir(out)) if os.path.isdir(out) else []
        check(res.returncode == 0 and saved == ["hnap-Cmaddress.json", "hnap-Cmconnectionstatus.json", "hnap-Cmeventlog.json", "hnap-Cmswinfo.json"],
              "S34: logs in and saves the reply of each status page (%s)" % (saved or res.stderr.strip()[-200:]))
        text = folder_text(out)
        check(not any(x.lower() in text.lower() for x in (MAC, CMTS, SERIAL, PUBLIC_IP, MAC.replace(":", ""))),
              "S34: neither MAC address, nor the serial number, nor the public IP address is in what was saved")
        sw = json.load(open(os.path.join(out, "hnap-Cmswinfo.json")))["GetCustomerStatusSoftwareResponse"]
        check(sw["StatusSoftwareMac"] == "00:00:5E:00:53:01" and sw["StatusSoftwareSerialNum"] == "0" * len(SERIAL) and sw["StatusSoftwareModelName"] == "S34"
              and sw["StatusSoftwareSfVer"] == "AT01.01.010.042324_S3.04.735", "S34: replaced with documentation values; model and firmware untouched")
        down = json.load(open(os.path.join(out, "hnap-Cmconnectionstatus.json")))["GetMultipleHNAPsResponse"]["GetCustomerStatusDownstreamChannelInfoResponse"]["CustomerConnDownstreamChannel"]
        fixture_down = json.load(open(os.path.join(src, "cmconnectionstatus.json")))["GetMultipleHNAPsResponse"]["GetCustomerStatusDownstreamChannelInfoResponse"]["CustomerConnDownstreamChannel"]
        check(down == fixture_down, "S34: the channel table is saved exactly as the modem sent it")
        log = json.load(open(os.path.join(out, "hnap-Cmeventlog.json")))["GetCustomerStatusLogResponse"]["CustomerStatusLogList"]
        check("CM-MAC=00:00:5E:00:53:01;CMTS-MAC=00:00:5E:00:53:02" in log and log.count("}-{") > 50, "S34: the event log keeps its entries, with both MAC addresses replaced")
        z = zipfile.ZipFile(out + ".zip")
        check(sorted(z.namelist()) == saved and all(z.read(n).decode() == open(os.path.join(out, n)).read() for n in saved),
              "S34: a zip of the same files is written, to attach to an issue")
        check("Replaced with documentation values: 2 MAC addresses, 1 serial number" in res.stdout and "look through the files" in res.stdout,
              "S34: says what was replaced and asks to look through the files")
        check(PASSWORD not in text and PASSWORD not in res.stdout + res.stderr and "Pa ss" not in text, "S34: the modem password is in none of the files and not in the output")

        raw_out = os.path.join(work, "capture-raw")
        res = run_tool(["--host", "127.0.0.1:%d" % PORT, "--raw"], raw_out)
        raw = folder_text(raw_out)
        check(res.returncode == 0 and MAC in raw and SERIAL in raw and "do not share" in res.stdout and not os.path.exists(raw_out + ".zip"),
              "--raw: saves what the modem sent, says not to share it, and makes no zip to attach")
        res = subprocess.run([sys.executable, TOOL, "--host", "127.0.0.1:%d" % PORT, "--out", os.path.join(work, "wrong")],
                             env=dict(os.environ, MODEM_PASSWORD="wrong"), capture_output=True, text=True, timeout=60)
        check(res.returncode != 0 and "Login failed" in res.stderr and not os.path.exists(os.path.join(work, "wrong")),
              "S34: a wrong password is reported, and nothing is saved")

        # --------------------------------- a modem with another kind of login
        class Open(http.server.BaseHTTPRequestHandler):
            pages = {
                "/cmswinfo.html": "<table><tr><td>Hardware Version</td><td>6</td></tr><tr><td>Serial Number</td><td>%s</td></tr>"
                                  "<tr><td>HFC MAC Address</td><td>%s</td></tr><tr><td>Software Version</td><td>AB01.02.053.05_051921_193.0A.NSH</td></tr></table>" % (SERIAL, MAC.lower()),
                "/cmeventlog.html": "<td>Mon Nov 16 08:13:22 2026</td><td>SYNC Timing Synchronization failure;CM-MAC=%s;CMTS-MAC=%s;CM-QOS=1.1;CM-VER=3.1;</td>" % (MAC.lower(), CMTS.lower()),
            }

            def do_GET(self):
                body = self.pages.get(self.path, "").encode()
                self.send_response(200 if body else 404)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *a):
                pass

        web = http.server.ThreadingHTTPServer(("127.0.0.1", OPEN_PORT), Open)
        threading.Thread(target=web.serve_forever, daemon=True).start()
        out2 = os.path.join(work, "other")
        res = run_tool(["--host", "127.0.0.1:%d" % OPEN_PORT], out2)
        saved = sorted(os.listdir(out2)) if os.path.isdir(out2) else []
        text = folder_text(out2) if saved else ""
        check(res.returncode == 0 and saved == ["open-cmeventlog.html", "open-cmswinfo.html"] and "does not use the SURFboard S33/S34 login" in res.stdout,
              "another modem: says it has another login, and saves the pages it shows without one (%s)" % (saved or (res.stdout + res.stderr).strip()[-300:]))
        check(MAC.lower() not in text.lower() and CMTS.lower() not in text.lower() and SERIAL not in text and "<td>Serial Number</td><td>000000000000000</td>" in text
              and "AB01.02.053.05_051921_193.0A.NSH" in text and "Mon Nov 16 08:13:22 2026" in text,
              "another modem: its pages are saved without the serial number and MAC addresses; firmware and times untouched")
        res = run_tool(["--host", "127.0.0.1:9"], os.path.join(work, "nothing"))
        check(res.returncode != 0 and "Nothing could be read from 127.0.0.1:9" in res.stderr and not os.path.exists(os.path.join(work, "nothing")),
              "no modem at the address: says so, saves nothing")
    finally:
        if modem:
            modem.kill()
        if web:
            web.shutdown()
        shutil.rmtree(work, ignore_errors=True)

    print("\n%d check(s) failed" % failed if failed else "\nall checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
