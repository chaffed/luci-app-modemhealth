#!/usr/bin/env python3
"""Save what a cable modem's status pages say, for adding support for a model.

Modem Health reads SURFboard S33 and S34 modems. To add another model, its
replies are needed. Run this on a computer behind the router the modem feeds:

    python3 tools/capture.py                 # prompts for the modem password
    python3 tools/capture.py --host 192.168.100.1 --user admin --out modem-capture

On an S33/S34 (and other models with the same login) it logs in the way the
modem's own web page does, opens the status pages to learn which requests
they make, makes those requests and saves every reply. On a modem with
another kind of login it saves the pages the modem shows without one. The
password is read with a hidden prompt and is never written anywhere.

What identifies you or your line is replaced before anything is saved: MAC
addresses, the serial number, and public IP addresses, each with a reserved
documentation value (the same value for the same original everywhere, so
the files still make sense). Look through the files before sharing them all
the same. --raw saves everything as the modem sent it; never share that.
"""

import argparse
import getpass
import hashlib
import hmac
import ipaddress
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
import zipfile

NS = "http://purenetworks.com/HNAP1/"
STATUS_PAGES = ["Cmconnectionstatus.html", "Cmswinfo.html", "Cmeventlog.html", "Cmaddress.html"]
# Status pages of SURFboard models that show them without a login.
OPEN_PAGES = ["", "cmconnectionstatus.html", "cmswinfo.html", "cmeventlog.html", "cmaddress.html",
              "indexData.htm", "cmSignalData.htm", "cmLogsData.htm", "cmHelpData.htm", "cmAddressData.htm"]


# ------------------------------------------------------------------ redaction

MAC_RE = re.compile(r"(?<![0-9A-Fa-f:.-])[0-9A-Fa-f]{2}(?:([:-])[0-9A-Fa-f]{2})(?:\1[0-9A-Fa-f]{2}){4}(?![0-9A-Fa-f:-])")
# Four numbers with dots that are not part of something longer: not
# "1.3.6.1.4.1" (an OID), not "OSPREY-2.4.0.1-GA" (a firmware version).
IPV4_RE = re.compile(r"(?<![\w.-])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])(?!-?[A-Za-z])")
IPV6_RE = re.compile(r"(?<![0-9A-Za-z:.])[0-9A-Fa-f:]{3,39}(?![0-9A-Za-z:])")
SERIAL_JSON_RE = re.compile(r'"[^"]*[Ss]erial[^"]*"\s*:\s*"([^"]+)"')
SERIAL_HTML_RE = re.compile(r"[Ss]erial\s*(?:[Nn]umber|[Nn]o\.?)[^<]{0,20}</t[dh]>\s*<t[dh][^>]*>\s*([^<\s][^<]*?)\s*</t[dh]>")


class Redactor:
    """Replaces what identifies a subscriber with reserved documentation
    values: MAC addresses with 00:00:5E:00:53:NN (RFC 7042), public IPv4
    addresses with 203.0.113.N (RFC 5737), IPv6 addresses with
    2001:db8::N (RFC 3849) and the serial number with zeros. The same
    original gets the same replacement in every file."""

    def __init__(self):
        self.macs, self.ipv4, self.ipv6, self.serials = {}, {}, {}, {}

    def _mac(self, m):
        key = re.sub(r"[^0-9a-f]", "", m.group(0).lower())
        if key.startswith("00005e0053"):
            return m.group(0)  # already a documentation value
        if key not in self.macs:
            self.macs[key] = "00:00:5E:00:53:%02X" % ((len(self.macs) + 1) % 256)
        return self.macs[key]

    def _ipv4(self, m):
        try:
            ip = ipaddress.IPv4Address(m.group(0))
        except ValueError:
            return m.group(0)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified or ip.is_reserved:
            return m.group(0)  # says nothing about who you are (192.168.100.1 is every modem's)
        # Everything else goes, also an address the provider uses only
        # inside its own network (100.64.0.0/10): it is still yours there.
        if m.group(0) not in self.ipv4:
            self.ipv4[m.group(0)] = "203.0.113.%d" % ((len(self.ipv4) + 1) % 256)
        return self.ipv4[m.group(0)]

    def _ipv6(self, m):
        text = m.group(0)
        if text.count(":") < 2:
            return text
        try:
            ip = ipaddress.IPv6Address(text)
        except ValueError:
            return text  # a time of day, a MAC address, a piece of script
        if ip.is_loopback or ip.is_unspecified or ip.is_multicast or ip in ipaddress.IPv6Network("2001:db8::/32"):
            return text
        key = ip.compressed
        if key not in self.ipv6:
            self.ipv6[key] = "2001:db8::%x" % (len(self.ipv6) + 1)
        return self.ipv6[key]

    def learn(self, text):
        """Note the serial numbers a file names, to remove them from every file."""
        for rx in (SERIAL_JSON_RE, SERIAL_HTML_RE):
            for value in rx.findall(text):
                value = value.strip()
                if len(value) >= 6 and value.strip("0"):
                    self.serials[value] = "0" * len(value)

    def apply(self, text):
        for serial, zeros in self.serials.items():
            text = text.replace(serial, zeros)
        text = MAC_RE.sub(self._mac, text)
        # A MAC address written elsewhere without separators, or in fours.
        for key, new in list(self.macs.items()):
            bare = new.replace(":", "")
            for form in (key, key.upper()):
                text = text.replace(form, bare)
                text = text.replace(".".join((form[0:4], form[4:8], form[8:12])), ".".join((bare[0:4], bare[4:8], bare[8:12])))
        text = IPV4_RE.sub(self._ipv4, text)
        return IPV6_RE.sub(self._ipv6, text)

    def summary(self):
        def n(count, what):
            return "%d %s%s" % (count, what, "" if count == 1 else "es" if what.endswith("s") else "s")
        return ", ".join([n(len(self.macs), "MAC address"), n(len(self.serials), "serial number"),
                          n(len(self.ipv4) + len(self.ipv6), "public IP address")])


def hmac_hex(key, msg):
    return hmac.new(key.encode(), msg.encode(), hashlib.sha256).hexdigest().upper()


class NotThisLogin(Exception):
    """The modem does not take the S33/S34 login."""


# What an S33/S34 is asked when its status pages cannot be read to find out.
KNOWN_ACTIONS = {
    "Cmconnectionstatus": ["GetCustomerStatusStartupSequence", "GetCustomerStatusConnectionInfo",
                           "GetCustomerStatusDownstreamChannelInfo", "GetCustomerStatusUpstreamChannelInfo"],
    "Cmswinfo": ["GetCustomerStatusSoftware"],
    "Cmeventlog": ["GetCustomerStatusLog"],
    "Cmaddress": ["GetCustomerStatusCmaddress"],
}


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
        except (urllib.error.URLError, OSError):
            return 0, ""  # sent somewhere that does not answer (a login page over plain http)

    def login(self, user, password):
        req = {"Action": "request", "Username": user, "LoginPassword": "",
               "Captcha": "", "PrivateLogin": "LoginPassword"}
        try:
            step1, raw1 = self.hnap("Login", req)
        except urllib.error.HTTPError as e:
            raise NotThisLogin("it answered the login request with HTTP %s" % e.code)
        except (urllib.error.URLError, OSError) as e:
            raise NotThisLogin("nothing took the login request: %s" % getattr(e, "reason", e))
        r1 = (step1 or {}).get("LoginResponse", {}) if isinstance(step1, dict) else {}
        if not r1.get("Challenge"):
            raise NotThisLogin("it gave no challenge to the login request")
        self.uid = r1.get("Cookie")
        self.private_key = hmac_hex(r1["PublicKey"] + password, r1["Challenge"])
        req.update(Action="login", LoginPassword=hmac_hex(self.private_key, r1["Challenge"]))
        step2, raw2 = self.hnap("Login", req)
        result = (step2 or {}).get("LoginResponse", {}).get("LoginResult")
        return result, raw2


def write_files(out, files, raw):
    """Write what was collected (name -> text). Unless raw, it is redacted
    first, and a zip of it is written too, to attach to an issue."""
    os.makedirs(out, exist_ok=True)
    red = Redactor()
    archive = out.rstrip("/\\") + ".zip"
    if not raw:
        for text in files.values():
            red.learn(text)
        files = {name: red.apply(text) for name, text in files.items()}
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
            for name, text in files.items():
                z.writestr(name, text)
    for name, text in files.items():
        with open(os.path.join(out, name), "w") as f:
            f.write(text)
        print("  saved %s (%d bytes)" % (os.path.join(out, name), len(text)))
    return red, archive


def open_pages(host, timeout=15):
    """What the modem shows without a login (name -> text), over https or http."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    found = {}
    for page in OPEN_PAGES:
        for scheme in ("https", "http"):
            try:
                with urllib.request.urlopen("%s://%s/%s" % (scheme, host, page), context=ctx, timeout=timeout) as r:
                    text = r.read().decode("utf-8", "replace")
            except (urllib.error.URLError, OSError, ValueError):
                continue
            if text.strip():
                found["open-" + (page or "index.html")] = text
                print("Page /%s: %d bytes without a login (%s)" % (page, len(text), scheme))
                break
    return found


def actions_in(text):
    found = re.findall(r'GetMultipleHNAPs/(\w+)', text)
    found += re.findall(r'["\'](GetCustomerStatus\w+|GetArris\w+)["\']', text)
    seen, out = set(), []
    for a in found:
        if a not in seen and not a.endswith("Response") and not a.endswith("Result"):
            seen.add(a)
            out.append(a)
    return out


def collect(m, user, password):
    """Log in and read the status pages. -> (files, None), or (files, why)
    when this modem does not take the S33/S34 login."""
    files = {}
    print("Logging in to %s as %s ..." % (m.base, user))
    try:
        result, raw = m.login(user, password)
    except NotThisLogin as e:
        return files, str(e)
    print("  LoginResult: %s" % result)
    if result not in ("OK", "OK_CHANGED"):
        raise SystemExit("Login failed (%s). Check the user name and password." % result)

    groups = {}
    for page in STATUS_PAGES:
        status, html = m.get(page)
        print("Page %s: HTTP %s, %d bytes" % (page, status, len(html)))
        if not html:
            continue
        files[page] = html
        text = html
        for src in re.findall(r'src="(\./js/[^"?]+\.js)', html):
            if src.split("/")[-1] in ("jquery.js", "jquery.selectbox.js", "jquery.qrcode.min.js", "main.js", "initialJS.js"):
                continue
            s, js = m.get(src)
            if js:
                files["page-" + src.split("/")[-1]] = js
                text += js
        acts = actions_in(text)
        print("  requests on this page: %s" % (", ".join(acts) or "none found"))
        if acts:
            groups[page] = acts

    if not groups:
        print("No status page could be read; asking for what an S33/S34 answers.")
        groups = {page + ".html": acts for page, acts in KNOWN_ACTIONS.items()}
    for page, acts in groups.items():
        data, raw = m.hnap("GetMultipleHNAPs", {a: "" for a in acts})
        files["hnap-" + page.replace(".html", "") + ".json"] = json.dumps(data, indent=2) if data is not None else raw

    try:
        _, raw = m.hnap("Logout", {"Action": "logout", "Captcha": ""})
        print("Logout reply: %s" % raw[:120])
    except Exception as e:  # logging out is a courtesy; the session expires by itself
        print("Logout skipped: %s" % e)
    return files, None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--host", default="192.168.100.1", help="the modem's address (default: 192.168.100.1)")
    ap.add_argument("--user", default="admin", help="the modem's user name (default: admin)")
    ap.add_argument("--out", default=None, help="folder to save to (default: modem-capture, or capture-raw with --raw)")
    ap.add_argument("--raw", action="store_true",
                    help="save everything as the modem sent it, MAC addresses, serial number and your public IP included; never share the result")
    args = ap.parse_args()
    out = args.out or ("capture-raw" if args.raw else "modem-capture")

    password = os.environ.get("MODEM_PASSWORD") or getpass.getpass("Modem password for %s (not saved; just Enter if the modem has none): " % args.user)
    files, why = collect(Modem(args.host), args.user, password)
    if why:
        print("This modem does not use the SURFboard S33/S34 login (%s)." % why.rstrip("."))
        print("Saving what it shows without a login instead ...")
        files.update(open_pages(args.host))
    if not files:
        raise SystemExit("Nothing could be read from %s. Is that the modem's address?" % args.host)

    red, archive = write_files(out, files, args.raw)
    if args.raw:
        print("Done. %d files in %s/, exactly as the modem sent them: do not share them." % (len(files), out))
    else:
        print("Done. %d files in %s/ and in %s." % (len(files), out, archive))
        print("Replaced with documentation values: %s." % red.summary())
        print("Please look through the files before you share them; channel frequencies and the")
        print("provider's configuration file name are left in, because support for a model needs them.")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.URLError as e:
        sys.exit("Could not reach the modem: %s" % e)
