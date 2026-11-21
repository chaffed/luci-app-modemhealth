#!/usr/bin/env python3
"""Save what a T-Mobile 5G Home Internet gateway reports, to add support for it.

Modem Health is adding support for T-Mobile's gateways (Arcadyan KVD21,
Sagemcom 5688W, TMO-G4AR/G4SE, TMO-G5AR/G5SE, Nokia 5G21), but nobody on
the project has one. If you do, run this on a computer connected to the
gateway (directly, or behind your own router):

    python3 tools/capture-tmobile.py              # about 5 minutes, no password
    python3 tools/capture-tmobile.py --login      # also the cell details (asks for
                                                  # the admin password on the label)

It writes tmobile-capture.zip. Look through it, then attach it to an issue
at https://github.com/chaffed/luci-app-modemhealth/issues.

What it does, and does not do:
- It only reads. The one thing it ever sends is the login, and only with
  --login: one attempt, and none after a refusal, so it can never lock the
  gateway's admin account. It never asks for anything that reboots or
  changes the gateway, and never for the SIM, the list of your devices or
  your Wi-Fi settings.
- It reads the status the gateway gives without a password every 30
  seconds, 10 times, to see how it changes and how fast it answers.
- Before saving, it replaces what identifies you or your home: the serial
  number, MAC addresses, IMEI/IMSI/ICCID/phone number, the gateway's GPS
  position, and the tower and cell IDs (which locate a home within a few
  blocks). The same original gets the same stand-in everywhere, so a tower
  change still shows as a change. Your password is never written anywhere.
  --raw saves the originals as well, for you only; never share that folder.
"""

import argparse
import getpass
import ipaddress
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import zipfile

TMI = "/TMI/v1/"
# Read without a login on every TMI model.
OPEN_READS = ["gateway?get=all", "gateway?get=signal"]
# Read with a login (--login). Nothing personal: not sim, clients or ap.
LOGIN_READS = ["network/telemetry?get=cell", "version"]
# The Nokia 5G21's pages that answer without a login.
NOKIA_PAGES = ["fastmile_radio_status_web_app.cgi", "dashboard_device_status_web_app.cgi",
               "dashboard_device_info_status_web_app.cgi"]
# Nothing outside this list is ever requested: the tool cannot call a
# reboot or a setting by mistake.
ALLOWED = set(TMI + p for p in OPEN_READS + LOGIN_READS) | {TMI + "auth/login"} | {"/" + p for p in NOKIA_PAGES}


# ------------------------------------------------------------------ redaction

# Keys (compared in lower case, without "_" and "-") whose values identify
# the subscriber, the device or the home's location.
KEY_KINDS = {
    "serial": "serial", "serialnumber": "serial", "sn": "serial",
    "macid": "mac", "mac": "mac", "macaddress": "mac", "bssid": "mac",
    "imei": "imei", "imsi": "imsi", "iccid": "iccid", "msisdn": "phone", "phonenumber": "phone",
    "latitude": "gps", "longitude": "gps", "lat": "gps", "lon": "gps", "lng": "gps",
    "enbid": "tower", "gnbid": "tower", "cid": "cell", "cellid": "cell", "ecgi": "cell",
    "pci": "pci", "tac": "tac", "xalucomtac": "tac", "earfcn": "earfcn", "nrarfcn": "earfcn",
    "hostname": "host", "name": "host", "ipaddress": "ip", "ipv4": "ip", "ipv6": "ip",
    "ssid": "ssid", "ssidname": "ssid", "wpakey": "secret", "password": "secret", "token": "secret",
}
# "name" is only a device name inside a list of clients/hosts; elsewhere
# (device.name = "5G Gateway") it is kept.
CLIENT_ONLY = {"name", "ipv4", "ipv6", "ipaddress", "hostname"}
MAC_RE = re.compile(r"(?<![0-9A-Fa-f:-])[0-9A-Fa-f]{2}([:-])[0-9A-Fa-f]{2}(?:\1[0-9A-Fa-f]{2}){4}(?![0-9A-Fa-f:-])")
IPV4_RE = re.compile(r"(?<![\w.-])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])")
DIGITS_RE = re.compile(r"(?<!\d)\d{14,20}(?!\d)")  # IMEI, IMSI, ICCID, phone numbers in free text


def norm(key):
    return re.sub(r"[_\-\s]", "", str(key)).lower()


class Redactor:
    """Replaces identifying values with stand-ins: the same original gets
    the same stand-in in every file, and numbers stay numbers."""

    def __init__(self):
        self.seen = {}      # (kind, original) -> stand-in
        self.counts = {}    # kind -> how many different values
        self.secrets = set()

    def standin(self, kind, value):
        k = (kind, json.dumps(value) if not isinstance(value, str) else value)
        if k in self.seen:
            return self.seen[k]
        n = self.counts.get(kind, 0) + 1
        self.counts[kind] = n
        if kind == "gps":
            s = 0.0
        elif kind == "mac":
            s = "00:00:5E:00:53:%02X" % (n % 256)
        elif kind == "ip":
            s = ["2001:db8::%x" % n] if isinstance(value, list) else "192.0.2.%d" % (n % 254 + 1)
            if isinstance(value, str) and ":" in value:
                s = "2001:db8::%x" % n
        elif isinstance(value, bool):
            s = value
        elif isinstance(value, (int, float)):
            s = {"tower": 1000000, "cell": 100, "pci": 500, "tac": 10000, "earfcn": 600000}.get(kind, 9000) + n
        else:
            s = "%s-%d" % (kind.upper(), n)
        self.seen[k] = s
        return s

    def walk(self, v, in_list=False):
        if isinstance(v, dict):
            out = {}
            for key, val in v.items():
                kind = KEY_KINDS.get(norm(key))
                if kind and norm(key) in CLIENT_ONLY and not in_list:
                    kind = None
                if kind and val not in (None, "", [], 0) and not isinstance(val, (dict,)):
                    if kind == "secret":
                        out[key] = "REMOVED"
                        if isinstance(val, str):
                            self.secrets.add(val)
                        self.counts["secret"] = self.counts.get("secret", 0) + 1
                    elif isinstance(val, list):
                        out[key] = [self.standin(kind, x) for x in val]
                    else:
                        out[key] = self.standin(kind, val)
                else:
                    out[key] = self.walk(val, in_list)
            return out
        if isinstance(v, list):
            return [self.walk(x, True) for x in v]
        if isinstance(v, str):
            return self.text(v)
        return v

    def text(self, s):
        """Free text (HTML, or values the key rules missed)."""
        for orig, _ in list(self.seen.items()):
            if isinstance(orig[1], str) and len(orig[1]) >= 4 and orig[1] in s:
                s = s.replace(orig[1], str(self.seen[orig]))
        s = MAC_RE.sub(lambda m: self.standin("mac", m.group(0).upper().replace("-", ":")), s)
        s = DIGITS_RE.sub(lambda m: self.standin("number", m.group(0)), s)

        def ip(m):
            try:
                a = ipaddress.ip_address(m.group(0))
            except ValueError:
                return m.group(0)
            return m.group(0) if (a.is_private or a.is_loopback or a.is_link_local) else self.standin("ip", m.group(0))
        return IPV4_RE.sub(ip, s)

    def summary(self):
        names = {"serial": "serial numbers", "mac": "MAC addresses", "imei": "IMEIs", "imsi": "IMSIs",
                 "iccid": "SIM numbers", "phone": "phone numbers", "gps": "GPS coordinates",
                 "tower": "tower IDs (eNB/gNB)", "cell": "cell IDs", "pci": "PCIs", "tac": "tracking area codes",
                 "earfcn": "channel numbers (EARFCN)", "host": "device names", "ip": "IP addresses",
                 "ssid": "Wi-Fi names", "secret": "passwords or tokens", "number": "long numbers in text"}
        return ["%d %s" % (n, names.get(k, k)) for k, n in sorted(self.counts.items())]


# ------------------------------------------------------------------ requests

class Gateway:
    def __init__(self, host, timeout):
        self.host = host
        self.timeout = timeout
        self.token = None
        self.requests = []   # what was asked, for the record (no bodies)

    def request(self, port, path, body=None):
        if path not in ALLOWED:
            raise RuntimeError("not allowed: %s" % path)   # a bug in this tool, never a request
        url = "http://%s:%d%s" % (self.host, port, path)
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
        req.add_header("Accept", "application/json")
        if data:
            req.add_header("Content-Type", "application/json")
        if self.token and path.startswith(TMI) and not path.endswith("auth/login"):
            req.add_header("Authorization", "Bearer " + self.token)
        t0 = time.time()
        rec = {"method": req.get_method(), "port": port, "path": path, "at": round(t0, 3)}
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                text = r.read().decode("utf-8", "replace")
                rec.update(status=r.status, server=r.headers.get("Server"), content_type=r.headers.get("Content-Type"))
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace")
            rec.update(status=e.code, server=e.headers.get("Server"), content_type=e.headers.get("Content-Type"))
        except Exception as e:   # unreachable, refused, timed out
            text = None
            rec.update(status=None, error=type(e).__name__ + ": " + str(getattr(e, "reason", e)))
        rec["ms"] = round((time.time() - t0) * 1000)
        self.requests.append(rec)
        return rec, text


def as_json(text):
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def find_api(gw, ports):
    """Which port the TMI API answers on, or the Nokia CGI pages."""
    for port in ports:
        rec, text = gw.request(port, TMI + "gateway?get=all")
        j = as_json(text)
        if rec.get("status") == 200 and isinstance(j, dict) and ("signal" in j or "device" in j):
            return "tmi", port
    for port in ports:
        rec, text = gw.request(port, "/" + NOKIA_PAGES[0])
        if rec.get("status") == 200 and as_json(text) is not None:
            return "nokia", port
    return None, None


def collect(gw, ports, samples, interval, password, say):
    files = {}
    kind, port = find_api(gw, ports)
    files["about.json"] = {"tool": "capture-tmobile.py 1", "host": gw.host, "api": kind, "port": port,
                           "ports_tried": ports, "captured": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    if not kind:
        say("Nothing answered like a T-Mobile gateway at %s (ports %s)." % (gw.host, ", ".join(map(str, ports))))
        return files
    say("Found the %s API on port %d." % ("TMI" if kind == "tmi" else "Nokia", port))
    if kind == "nokia":
        for p in NOKIA_PAGES:
            rec, text = gw.request(port, "/" + p)
            files["nokia/" + p.replace(".cgi", ".json")] = as_json(text) if as_json(text) is not None else text
        for i in range(1, samples):
            time.sleep(interval)
            rec, text = gw.request(port, "/" + NOKIA_PAGES[0])
            files["nokia/samples/radio-%02d.json" % (i + 1)] = as_json(text) if as_json(text) is not None else text
            say("  sample %d of %d" % (i + 1, samples))
        return files

    for p in OPEN_READS:
        rec, text = gw.request(port, TMI + p)
        files["tmi/" + p.replace("?get=", "-") + ".json"] = as_json(text) if as_json(text) is not None else text
    if password is not None:
        rec, text = gw.request(port, TMI + "auth/login", {"username": "admin", "password": password})
        token = (as_json(text) or {}).get("auth", {}).get("token") if isinstance(as_json(text), dict) else None
        files["tmi/login-result.json"] = {"status": rec.get("status"), "token_received": bool(token),
                                          "expiration": ((as_json(text) or {}).get("auth") or {}).get("expiration") if token else None,
                                          "reply_without_token": None if token else as_json(text)}
        if token:
            gw.token = token
            for p in LOGIN_READS:
                rec, text = gw.request(port, TMI + p)
                files["tmi/" + p.replace("network/telemetry?get=", "telemetry-") + ".json"] = as_json(text) if as_json(text) is not None else text
            say("Logged in; saved the cell details.")
        else:
            say("The gateway refused the login (HTTP %s). Not trying again, so the account cannot lock." % rec.get("status"))
    say("Reading the status %d times, %d s apart..." % (samples, interval))
    for i in range(samples):
        if i:
            time.sleep(interval)
        rec, text = gw.request(port, TMI + "gateway?get=all")
        files["tmi/samples/gateway-all-%02d.json" % (i + 1)] = {"request": rec, "reply": as_json(text) if as_json(text) is not None else text}
        say("  sample %d of %d: HTTP %s in %d ms" % (i + 1, samples, rec.get("status"), rec["ms"]))
    return files


# ------------------------------------------------------------------ output

README = """What this is
------------
Replies of a T-Mobile 5G gateway, saved by Modem Health's capture-tmobile.py
to add support for it. Captured: {captured}. API: {api}, port {port}.

Replaced before saving (each with a stand-in; the same original gets the
same stand-in everywhere): {removed}.

Please look through the files before sharing them. If you see anything that
identifies you or your home (a name, an address, a number from your account),
delete it, or tell us in the issue and don't attach the file.
"""


def write(out, files, redactor, raw_files=None):
    os.makedirs(out, exist_ok=True)
    clean = {name: redactor.walk(content) for name, content in files.items()}
    clean["requests.json"] = redactor.walk(files.get("_requests", []))
    clean.pop("_requests", None)
    text_of = {name: (json.dumps(c, indent=2, sort_keys=True) + "\n" if not isinstance(c, str) else c) for name, c in clean.items()}
    # A last pass over the finished text: no secret may survive anywhere.
    for name, t in text_of.items():
        for s in redactor.secrets:
            if s and s in t:
                text_of[name] = t = t.replace(s, "REMOVED")
    about = clean.get("about.json", {})
    text_of["README.txt"] = README.format(captured=about.get("captured"), api=about.get("api"), port=about.get("port"),
                                          removed=", ".join(redactor.summary()) or "nothing")
    for name, t in text_of.items():
        path = os.path.join(out, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(t)
    zpath = out.rstrip("/") + ".zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for name, t in sorted(text_of.items()):
            z.writestr(os.path.join(os.path.basename(out.rstrip("/")), name), t)
    if raw_files is not None:
        rawdir = out.rstrip("/") + "-raw"
        os.makedirs(rawdir, exist_ok=True)
        with open(os.path.join(rawdir, "everything.json"), "w") as f:
            json.dump(raw_files, f, indent=2, default=str)
    return zpath


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], epilog=__doc__.split("\n\n", 1)[1],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="192.168.12.1", help="the gateway's address (default 192.168.12.1)")
    ap.add_argument("--port", type=int, action="append", help="port to try (default: 8080, then 80)")
    ap.add_argument("--login", action="store_true", help="also log in once and save the cell details")
    ap.add_argument("--samples", type=int, default=10)
    ap.add_argument("--interval", type=float, default=30, help="seconds between samples (default 30)")
    ap.add_argument("--timeout", type=float, default=10)
    ap.add_argument("--out", default="tmobile-capture")
    ap.add_argument("--raw", action="store_true", help="also keep the originals (never share them)")
    args = ap.parse_args(argv)
    if args.samples < 1:
        ap.error("--samples must be at least 1")
    password = None
    if args.login:
        password = os.environ.get("TMOBILE_CAPTURE_PASSWORD") if os.environ.get("TMOBILE_CAPTURE_TEST") else None
        if password is None:
            password = getpass.getpass("Gateway admin password (on the label; not shown, not saved): ")
    gw = Gateway(args.host, args.timeout)
    files = collect(gw, args.port or [8080, 80], args.samples, args.interval, password, lambda s: print(s, flush=True))
    files["_requests"] = gw.requests
    r = Redactor()
    if password:
        r.secrets.add(password)
    zpath = write(args.out, files, r, files if args.raw else None)
    print("\nSaved %s/ and %s." % (args.out, zpath))
    print("Replaced: %s." % (", ".join(r.summary()) or "nothing"))
    print("Look through the files, then attach the zip to an issue at\nhttps://github.com/chaffed/luci-app-modemhealth/issues")
    return 0 if files.get("about.json", {}).get("api") else 1


if __name__ == "__main__":
    sys.exit(main())
