#!/usr/bin/env python3
"""A fake SURFboard S33/S34 for testing Modem Health's backend.

Serves HTTPS (self-signed, like the real modem) on --port and answers HNAP
requests the way the real modem does, from the captured replies in
tests/fixtures/s34/. Every request's HNAP_AUTH signature and the login
password proof are checked with the real algorithm, so a signing bug in the
backend fails the tests instead of passing quietly.

Control endpoints (plain GET on the same port) for tests:
    /_control/state             JSON counters (logins, bad signatures, ...)
    /_control/set?key=value     change behaviour, for example
                                password=...    the modem password
                                expire=1        forget all sessions now
                                session_limit=N sessions expire after N requests
                                last_ts=N       latest timestamp already accepted
    /_control/reset             counters back to zero, defaults restored

Usage: python3 tests/fake_modem.py --port 18443 --password 'secret'
"""

import argparse
import hashlib
import hmac
import http.server
import json
import os
import secrets
import ssl
import subprocess
import tempfile
import threading
import urllib.parse

NS = "http://purenetworks.com/HNAP1/"
FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "s34")


def sign(key, msg):
    return hmac.new(key.encode(), msg.encode(), hashlib.sha256).hexdigest().upper()


def load_actions(folder):
    """Map each HNAP action to its reply, from the captured page replies.

    The real modem wraps the replies in GetMultipleHNAPsResponse only when
    more than one action was asked for, so fixtures come in both shapes.
    """
    actions = {}
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(folder, name)) as f:
            data = json.load(f)
        data = data.get("GetMultipleHNAPsResponse", data)
        for key, value in data.items():
            if key.endswith("Response") and isinstance(value, dict):
                actions[key[: -len("Response")]] = value
    return actions


class Modem:
    def __init__(self, password, fixtures):
        self.lock = threading.Lock()
        self.actions = load_actions(fixtures)
        self.default_password = password
        self.reset()

    def reset(self):
        self.password = self.default_password
        self.pending = {}  # cookie -> (challenge, public key) between login steps
        self.sessions = {}  # cookie -> {"key": PrivateKey, "used": n}
        self.session_limit = 0
        self.last_ts = 0
        self.counts = {"requests": 0, "logins": 0, "login_failures": 0,
                       "bad_signatures": 0, "status_reads": 0, "logouts": 0,
                       "unauthorised": 0, "stale_timestamps": 0}

    def state(self):
        return dict(self.counts, sessions=len(self.sessions))


class Handler(http.server.BaseHTTPRequestHandler):
    modem = None  # set in main()
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("FAKE_MODEM_VERBOSE"):
            super().log_message(fmt, *args)

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def not_found(self):
        body = b"<title>404 Not Found</title><h1>404 Not Found</h1>"
        self.send_response(404)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ------------------------------------------------------------- control
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        m = self.modem
        with m.lock:
            if url.path == "/_control/state":
                return self.reply(200, m.state())
            if url.path == "/_control/reset":
                m.reset()
                return self.reply(200, m.state())
            if url.path == "/_control/set":
                for key, value in urllib.parse.parse_qsl(url.query, keep_blank_values=True):
                    if key == "password":
                        m.password = value
                    elif key == "expire":
                        m.sessions.clear()
                    elif key == "session_limit":
                        m.session_limit = int(value)
                    elif key == "last_ts":
                        m.last_ts = int(value)
                return self.reply(200, m.state())
        # The real modem sends every other page to the login page.
        self.send_response(302)
        self.send_header("Location", "http://%s/Login.html" % self.headers.get("Host", "192.168.100.1"))
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---------------------------------------------------------------- HNAP
    def cookies(self):
        out = {}
        for part in self.headers.get("Cookie", "").split(";"):
            if "=" in part:
                k, v = part.strip().split("=", 1)
                out[k] = v
        return out

    def do_POST(self):
        m = self.modem
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self.reply(400, {"error": "bad json"})
        soap_action = self.headers.get("SOAPAction", "")
        action = soap_action.strip('"').replace(NS, "")
        cookies = self.cookies()

        with m.lock:
            m.counts["requests"] += 1
            session = m.sessions.get(cookies.get("uid", ""))
            key = session["key"] if session and cookies.get("PrivateKey") == session["key"] else "withoutloginkey"
            # Login step 2: the modem's Login.js stores the new PrivateKey
            # before sending it, so it is signed with the key derived from
            # the password. A wrong password therefore shows up here.
            pending = m.pending.get(cookies.get("uid", "")) if action == "Login" else None
            if pending and body.get("Login", {}).get("Action") == "login":
                key = sign(pending[1] + m.password, pending[0])

            auth = self.headers.get("HNAP_AUTH", "")
            sig, _, ts = auth.partition(" ")
            # The real S34 answers 403 to a timestamp lower than one it has
            # already accepted; an equal one is fine.
            if ts.isdigit() and int(ts) < m.last_ts:
                m.counts["stale_timestamps"] += 1
                return self.reply(403, {})
            if ts.isdigit():
                m.last_ts = int(ts)
            if action != "Login" and cookies.get("uid") and not session and not pending:
                m.counts["unauthorised"] += 1
                return self.not_found()
            if pending and ts and sig != sign(key, ts + soap_action):
                m.pending.pop(cookies.get("uid", ""), None)
                m.counts["login_failures"] += 1
                return self.reply(200, {"LoginResponse": {"LoginResult": "FAILED"}})
            if not ts or sig != sign(key, ts + soap_action):
                m.counts["bad_signatures"] += 1
                return self.reply(200, {action + "Response": {action + "Result": "ERROR"}})

            if action == "Login":
                return self.login(m, body.get("Login", {}), cookies)
            if action == "Logout":
                if session:
                    m.sessions.pop(cookies.get("uid"), None)
                m.counts["logouts"] += 1
                return self.reply(200, {"LogoutResponse": {"LogoutResult": "OK"}})

            if not session or key == "withoutloginkey":
                # The real S34 answers an expired or unknown session with a
                # plain 404 page (seen after 15 minutes idle).
                m.counts["unauthorised"] += 1
                return self.not_found()
            session["used"] += 1
            if m.session_limit and session["used"] > m.session_limit:
                m.sessions.pop(cookies.get("uid"), None)
                m.counts["unauthorised"] += 1
                return self.not_found()

            if action == "GetMultipleHNAPs":
                asked = list(body.get("GetMultipleHNAPs", {}).keys())
                m.counts["status_reads"] += 1
                replies = {a + "Response": m.actions.get(a, {a + "Result": "ERROR"}) for a in asked}
                if len(asked) == 1:
                    return self.reply(200, replies)
                replies["GetMultipleHNAPsResult"] = "OK"
                return self.reply(200, {"GetMultipleHNAPsResponse": replies})
            return self.reply(200, {action + "Response": {action + "Result": "ERROR"}})

    def login(self, m, req, cookies):
        if req.get("Action") == "request":
            cookie = secrets.token_hex(8)
            challenge = secrets.token_hex(10).upper()
            public_key = secrets.token_hex(10).upper()
            m.pending[cookie] = (challenge, public_key)
            return self.reply(200, {"LoginResponse": {
                "Challenge": challenge, "Cookie": cookie, "PublicKey": public_key,
                "LoginResult": "OK"}})
        if req.get("Action") == "login":
            cookie = cookies.get("uid", "")
            pending = m.pending.pop(cookie, None)
            if pending:
                challenge, public_key = pending
                private_key = sign(public_key + m.password, challenge)
                if req.get("LoginPassword") == sign(private_key, challenge):
                    m.sessions[cookie] = {"key": private_key, "used": 0}
                    m.counts["logins"] += 1
                    return self.reply(200, {"LoginResponse": {"LoginResult": "OK"}})
            m.counts["login_failures"] += 1
            return self.reply(200, {"LoginResponse": {"LoginResult": "FAILED"}})
        return self.reply(200, {"LoginResponse": {"LoginResult": "FAILED"}})


def self_signed_cert(folder):
    cert, key = os.path.join(folder, "cert.pem"), os.path.join(folder, "key.pem")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
                    "-subj", "/CN=192.168.100.1", "-keyout", key, "-out", cert],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return cert, key


def main():
    ap = argparse.ArgumentParser(description="Fake SURFboard S33/S34 for tests")
    ap.add_argument("--port", type=int, default=18443)
    ap.add_argument("--bind", default="0.0.0.0")
    ap.add_argument("--password", default="password")
    ap.add_argument("--fixtures", default=FIXTURES)
    args = ap.parse_args()

    Handler.modem = Modem(args.password, args.fixtures)
    server = http.server.ThreadingHTTPServer((args.bind, args.port), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    with tempfile.TemporaryDirectory() as tmp:
        ctx.load_cert_chain(*self_signed_cert(tmp))
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    print("fake modem listening on %s:%d" % (args.bind, args.port), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
