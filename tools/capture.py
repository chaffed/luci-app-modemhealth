#!/usr/bin/env python3
"""Log in to a SURFboard S33/S34 (HNAP, HMAC-SHA256) and save its raw status data.

Prototype for Modem Health. Run it on a computer behind the router the modem
feeds:

    python3 tools/capture.py                 # prompts for the modem password
    python3 tools/capture.py --user admin --host 192.168.100.1 --out capture-raw

It logs in the way the modem's own web page does, opens the status pages to
learn which HNAP requests they make, makes those requests, and writes every
reply to the output folder. The password is read with a hidden prompt and is
never written anywhere.

The files contain the modem's serial number and MAC addresses, so the default
output folder (capture-raw/) is git-ignored. Do not commit it as-is.
"""

import argparse
import getpass
import hashlib
import hmac
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request

NS = "http://purenetworks.com/HNAP1/"
STATUS_PAGES = ["Cmconnectionstatus.html", "Cmswinfo.html", "Cmeventlog.html", "Cmaddress.html"]


def hmac_hex(key, msg):
    return hmac.new(key.encode(), msg.encode(), hashlib.sha256).hexdigest().upper()


class Modem:
    def __init__(self, host, timeout=15):
        self.base = "https://%s" % host
        self.ctx = ssl.create_default_context()
        self.ctx.check_hostname = False
        self.ctx.verify_mode = ssl.CERT_NONE  # the modem's certificate is self-signed
        self.timeout = timeout
        self.private_key = None
        self.uid = None

    def _cookie(self):
        parts = []
        if self.uid:
            parts.append("uid=%s" % self.uid)
        if self.private_key:
            parts.append("PrivateKey=%s" % self.private_key)
        return "; ".join(parts)

    def hnap(self, action, payload):
        soap_action = '"%s%s"' % (NS, action)
        now = str(int(time.time() * 1000) % 2000000000000)
        key = self.private_key or "withoutloginkey"
        headers = {
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
            "SOAPAction": soap_action,
            "HNAP_AUTH": "%s %s" % (hmac_hex(key, now + soap_action), now),
            "Referer": self.base + "/Login.html",
        }
        if self._cookie():
            headers["Cookie"] = self._cookie()
        body = json.dumps({action: payload}).encode()
        req = urllib.request.Request(self.base + "/HNAP1/", data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, context=self.ctx, timeout=self.timeout) as r:
            raw = r.read().decode("utf-8", "replace")
        try:
            return json.loads(raw), raw
        except ValueError:
            return None, raw

    def get(self, path):
        headers = {"Referer": self.base + "/Login.html"}
        if self._cookie():
            headers["Cookie"] = self._cookie()
        req = urllib.request.Request(self.base + "/" + path.lstrip("./"), headers=headers)
        try:
            with urllib.request.urlopen(req, context=self.ctx, timeout=self.timeout) as r:
                return r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, ""

    def login(self, user, password):
        req = {"Action": "request", "Username": user, "LoginPassword": "",
               "Captcha": "", "PrivateLogin": "LoginPassword"}
        step1, raw1 = self.hnap("Login", req)
        r1 = (step1 or {}).get("LoginResponse", {})
        if not r1.get("Challenge"):
            raise SystemExit("Login step 1 gave no challenge. Reply: %s" % raw1[:300])
        self.uid = r1.get("Cookie")
        self.private_key = hmac_hex(r1["PublicKey"] + password, r1["Challenge"])
        req.update(Action="login", LoginPassword=hmac_hex(self.private_key, r1["Challenge"]))
        step2, raw2 = self.hnap("Login", req)
        result = (step2 or {}).get("LoginResponse", {}).get("LoginResult")
        return result, raw2


def save(out, name, text):
    path = os.path.join(out, name)
    with open(path, "w") as f:
        f.write(text)
    print("  saved %s (%d bytes)" % (path, len(text)))


def actions_in(text):
    found = re.findall(r'GetMultipleHNAPs/(\w+)', text)
    found += re.findall(r'["\'](GetCustomerStatus\w+|GetArris\w+)["\']', text)
    seen, out = set(), []
    for a in found:
        if a not in seen and not a.endswith("Response") and not a.endswith("Result"):
            seen.add(a)
            out.append(a)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--host", default="192.168.100.1")
    ap.add_argument("--user", default="admin")
    ap.add_argument("--out", default="capture-raw")
    args = ap.parse_args()

    password = os.environ.get("MODEM_PASSWORD") or getpass.getpass("Modem password for %s: " % args.user)
    os.makedirs(args.out, exist_ok=True)
    m = Modem(args.host)

    print("Logging in to %s as %s ..." % (args.host, args.user))
    result, raw = m.login(args.user, password)
    print("  LoginResult: %s" % result)
    if result not in ("OK", "OK_CHANGED"):
        save(args.out, "login-failed.json", raw)
        raise SystemExit("Login failed (%s). Check the user name and password." % result)

    groups = {}
    for page in STATUS_PAGES:
        status, html = m.get(page)
        print("Page %s: HTTP %s, %d bytes" % (page, status, len(html)))
        if not html:
            continue
        save(args.out, page, html)
        text = html
        for src in re.findall(r'src="(\./js/[^"?]+\.js)', html):
            if src.split("/")[-1] in ("jquery.js", "jquery.selectbox.js", "jquery.qrcode.min.js", "main.js", "initialJS.js"):
                continue
            s, js = m.get(src)
            if js:
                save(args.out, "page-" + src.split("/")[-1], js)
                text += js
        acts = actions_in(text)
        print("  requests on this page: %s" % (", ".join(acts) or "none found"))
        if acts:
            groups[page] = acts

    for page, acts in groups.items():
        data, raw = m.hnap("GetMultipleHNAPs", {a: "" for a in acts})
        name = "hnap-" + page.replace(".html", "") + ".json"
        save(args.out, name, json.dumps(data, indent=2) if data is not None else raw)

    try:
        _, raw = m.hnap("Logout", {"Action": "logout", "Captcha": ""})
        print("Logout reply: %s" % raw[:120])
    except Exception as e:  # logging out is a courtesy; the session expires by itself
        print("Logout skipped: %s" % e)

    print("Done. Files are in %s/" % args.out)


if __name__ == "__main__":
    try:
        main()
    except urllib.error.URLError as e:
        sys.exit("Could not reach the modem: %s" % e)
