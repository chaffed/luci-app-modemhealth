#!/usr/bin/env python3
"""A stand-in for a T-Mobile 5G Home Internet gateway, for the tests.

It answers the way public gateway clients document (see
tests/fixtures/tmobile/*.json and #28): the TMI REST API at /TMI/v1/ for
the Arcadyan, Sagemcom and Sercomm models, or the Nokia 5G21's CGI pages.
Nobody on the project has a gateway yet, so this is built from those
clients' code, not from a capture; replace the fixtures with redacted real
captures when people send them.

    python3 tests/fake_gateway.py --model kvd21 --port 18081 [--port 18082]
        [--password PW] [--log FILE]

Rules it enforces, so the tests notice a client that breaks them:
- anything that writes (a reboot, Wi-Fi or admin changes) answers 500 with
  "FORBIDDEN"; the request log shows it;
- network/telemetry needs a Bearer token from POST auth/login;
- a wrong password answers 401; after 3 in a row it locks (as gateways do)
  and refuses even the right one;
- /TMI/ answers only on the model's own port (80 or 8080 on real ones;
  the first --port here stands for 8080, the second for 80).

/_control/log returns every request (method, path; never the password),
/_control/set?key=value changes the reply (see Gateway.state),
/_control/reset puts everything back.
"""

import argparse
import copy
import json
import os
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures", "tmobile")
MODELS = {"kvd21": "kvd21.json", "g4ar": "g4ar-n41.json", "g5ar": "g5ar.json", "nokia": "nokia-5g21.json"}

# Paths that change something on a real gateway. Never to be called.
FORBIDDEN = ("/TMI/v1/gateway/reset", "/TMI/v1/auth/admin/reset", "/TMI/v1/network/configuration",
             "/reboot_web_app.cgi", "/service_function_app.cgi")
# Readable only with a login, and personal: a client must not ask for them.
PERSONAL = ("get=sim", "get=clients", "get=ap", "get=all")


class Gateway:
    def __init__(self, model, password):
        self.model = model
        self.password = password
        self.lock = threading.Lock()
        self.log = []
        self.reset()

    def reset(self):
        with self.lock:
            self.fixture = json.load(open(os.path.join(FIXTURES, MODELS[self.model])))
            self.tokens = {}
            self.failed_logins = 0
            self.started = time.time()
            # Scenario switches, changed with /_control/set:
            #   status=<code>  answer every TMI read with this HTTP code
            #   hang=1         accept the connection and never answer
            #   garbage=1      answer reads with text that is not JSON
            #   radio=<4g|5g>&rsrp=<n>&sinr=<n>...  change a radio's values
            #   drop=<4g|5g>   leave that radio's block out
            #   nullify=<4g|5g> send that block as null
            #   restart=1      uptime starts again from 0
            #   cell=<n>       new tower id for the radios
            #   band=<b>       new band for the radios
            self.state = {}
            self.log.clear()

    def record(self, method, path):
        with self.lock:
            self.log.append({"t": round(time.time(), 3), "method": method, "path": path})

    def gateway_all(self):
        g = copy.deepcopy(self.fixture["gateway_all"])
        st = self.state
        sig = g.get("signal", {})
        for tech in ("4g", "5g"):
            r = sig.get(tech)
            if not isinstance(r, dict):
                continue
            if st.get("radio") in (None, tech):
                for k in ("rsrp", "rsrq", "rssi", "sinr", "bars"):
                    if k in st:
                        r[k] = float(st[k]) if k == "bars" else int(st[k])
            if "cell" in st:
                r["gNBID" if tech == "5g" else "eNBID"] = int(st["cell"])
            if "band" in st:
                r["bands"] = [st["band"] if tech == "5g" or not st["band"].startswith("n") else "b2"]
        if st.get("drop") in ("4g", "5g"):
            sig.pop(st["drop"], None)
        if st.get("nullify") in ("4g", "5g"):
            sig[st["nullify"]] = None
        if "time" in g:
            base = 0 if st.get("restart") else g["time"].get("upTime", 0)
            g["time"]["upTime"] = int(base + time.time() - self.started)
            g["time"]["localTime"] = int(time.time())
        return g


def handler_for(gw, tmi_port):
    class Handler(BaseHTTPRequestHandler):
        server_version = "lighttpd/1.4.59"
        sys_version = ""

        def log_message(self, *a):
            pass

        def send(self, code, body, ctype="application/json"):
            data = body if isinstance(body, bytes) else (json.dumps(body) if not isinstance(body, str) else body).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def control(self, url):
            q = {k: v[-1] for k, v in parse_qs(url.query).items()}
            if url.path == "/_control/log":
                return self.send(200, gw.log)
            if url.path == "/_control/reset":
                gw.reset()
                return self.send(200, {"ok": True})
            if url.path == "/_control/set":
                with gw.lock:
                    if q.get("restart"):
                        gw.started = time.time()
                    gw.state.update(q)
                return self.send(200, {"ok": True, "state": gw.state})
            return self.send(404, {"error": "no such control"})

        def is_tmi_port(self):
            return self.server.server_address[1] == tmi_port

        def authorized(self):
            h = self.headers.get("Authorization", "")
            exp = gw.tokens.get(h[7:]) if h.startswith("Bearer ") else None
            return exp is not None and exp > time.time()

        def do_GET(self):
            url = urlsplit(self.path)
            if url.path.startswith("/_control/"):
                return self.control(url)
            gw.record("GET", self.path)
            if any(url.path.startswith(f) for f in FORBIDDEN):
                return self.send(500, {"error": "FORBIDDEN: this would change the gateway"})
            if gw.model == "nokia":
                return self.nokia(url)
            if not url.path.startswith("/TMI/") or not self.is_tmi_port():
                return self.send(404, "<html><body>404 Not Found</body></html>", "text/html")
            st = gw.state
            if st.get("hang"):
                time.sleep(3600)
            if "status" in st:
                return self.send(int(st["status"]), {"result": {"statusCode": int(st["status"])}})
            if st.get("garbage"):
                return self.send(200, "<html>Service Unavailable</html>", "text/html")
            path, query = url.path.rstrip("/"), url.query
            if path == "/TMI/v1/gateway":
                if query == "get=all":
                    return self.send(200, gw.gateway_all())
                if query == "get=signal":
                    return self.send(200, {"signal": gw.gateway_all().get("signal")})
                return self.send(400, {"result": {"statusCode": 400, "message": "No query specified"}})
            if path == "/TMI/v1/version":
                if not self.authorized():
                    return self.unauthorized()
                return self.send(200, gw.fixture.get("version", {"version": 1}))
            if path == "/TMI/v1/network/telemetry":
                if not self.authorized():
                    return self.unauthorized()
                key = query.replace("get=", "")
                if key == "cell" and "cell" in gw.fixture:
                    return self.send(200, gw.fixture["cell"])
                if key in ("sim", "clients", "all") and key in gw.fixture:
                    return self.send(200, gw.fixture[key])
                return self.send(404, {"result": {"statusCode": 404}})
            return self.send(404, {"result": {"statusCode": 404, "message": "Not Found"}})

        def unauthorized(self):
            return self.send(401, {"result": {"statusCode": 401, "error": "AuthorizationError",
                                               "message": "Not Authorized, Access token is missing or invalid"}})

        def nokia(self, url):
            pages = {"/fastmile_radio_status_web_app.cgi": "radio_status",
                     "/dashboard_device_info_status_web_app.cgi": "device_info",
                     "/dashboard_device_status_web_app.cgi": "device_status"}
            if url.path in pages and self.is_tmi_port():
                return self.send(200, gw.fixture[pages[url.path]])
            return self.send(404, "<html><body>404</body></html>", "text/html")

        def do_POST(self):
            url = urlsplit(self.path)
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n else b""
            gw.record("POST", self.path)
            if any(url.path.startswith(f) for f in FORBIDDEN):
                return self.send(500, {"error": "FORBIDDEN: this would change the gateway"})
            if url.path.rstrip("/") == "/TMI/v1/auth/login" and self.is_tmi_port():
                try:
                    creds = json.loads(body or b"{}")
                except ValueError:
                    creds = {}
                with gw.lock:
                    if gw.failed_logins >= 3:
                        return self.send(200, {"result": {"statusCode": 429, "message": "Too many attempts. Try again later."}})
                    if creds.get("username") != "admin" or creds.get("password") != gw.password:
                        gw.failed_logins += 1
                        return self.unauthorized()
                    gw.failed_logins = 0
                    token = secrets.token_hex(16)
                    gw.tokens[token] = time.time() + 900
                return self.send(200, {"auth": {"expiration": int(time.time() + 900), "refreshCountLeft": 4,
                                                "refreshCountMax": 4, "token": token}})
            return self.send(404, {"result": {"statusCode": 404}})

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--model", choices=sorted(MODELS), default="kvd21")
    ap.add_argument("--port", type=int, action="append", required=True,
                    help="first: stands for 8080, second (optional): stands for 80")
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--password", default="label-password")
    args = ap.parse_args()
    gw = Gateway(args.model, args.password)
    # Which of our ports plays the model's own API port.
    real = gw.fixture.get("port", 80)
    tmi_port = args.port[0] if real == 8080 or len(args.port) == 1 else args.port[1]
    servers = [ThreadingHTTPServer((args.bind, p), handler_for(gw, tmi_port)) for p in args.port]
    for s in servers[1:]:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print("fake %s gateway on %s (TMI on %d)" % (args.model, ", ".join(str(p) for p in args.port), tmi_port), flush=True)
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
