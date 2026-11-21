#!/usr/bin/env python3
"""tools/capture-tmobile.py against tests/fake_gateway.py, for every model
shape: it finds the API on either port, keeps the gateway safe (never
asks for anything that writes or anything personal, logs in at most once)
and leaves nothing identifying in what it saves.

Run: python3 tests/capture_tmobile.test.py
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TOOL = os.path.join(ROOT, "tools", "capture-tmobile.py")
OUT = os.path.join(ROOT, ".test-out", "capture-tmobile")
PASSWORD = 'lab "el" pass,1$'
FAIL = 0

sys.path.insert(0, os.path.join(ROOT, "tools"))
import importlib.util  # noqa: E402
spec = importlib.util.spec_from_file_location("capture_tmobile", TOOL)
cap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cap)


def ok(cond, name):
    global FAIL
    if not cond:
        FAIL += 1
    print(("ok   " if cond else "FAIL ") + name)
    return cond


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def identifiers(v, in_list=False, out=None):
    """Every value in a fixture that the tool must not let through."""
    out = set() if out is None else out
    if isinstance(v, dict):
        for k, x in v.items():
            kind = cap.KEY_KINDS.get(cap.norm(k))
            if kind and cap.norm(k) in cap.CLIENT_ONLY and not in_list:
                kind = None
            if kind and not isinstance(x, dict):
                for y in (x if isinstance(x, list) else [x]):
                    s = str(y)
                    # Short numbers (cid 12) also occur by chance; check the distinctive ones.
                    if len(s) >= 4 and not s.startswith(("192.168.", "fe80:")):
                        out.add(s)
            else:
                identifiers(x, in_list, out)
    elif isinstance(v, list):
        for x in v:
            identifiers(x, True, out)
    return out


class Fake:
    def __init__(self, model):
        self.ports = [free_port(), free_port()]
        args = [sys.executable, os.path.join(HERE, "fake_gateway.py"), "--model", model, "--password", PASSWORD]
        for p in self.ports:
            args += ["--port", str(p)]
        self.proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.proc.stdout.readline()

    def log(self):
        return json.load(urllib.request.urlopen("http://127.0.0.1:%d/_control/log" % self.ports[0]))

    def set(self, **kw):
        q = "&".join("%s=%s" % kv for kv in kw.items())
        urllib.request.urlopen("http://127.0.0.1:%d/_control/set?%s" % (self.ports[0], q)).read()

    def stop(self):
        self.proc.terminate()
        self.proc.wait()


def run(fake, out, *extra, password=None):
    env = dict(os.environ)
    if password is not None:
        env.update(TMOBILE_CAPTURE_TEST="1", TMOBILE_CAPTURE_PASSWORD=password)
    args = [sys.executable, TOOL, "--host", "127.0.0.1", "--port", str(fake.ports[0]), "--port", str(fake.ports[1]),
            "--samples", "3", "--interval", "0.2", "--timeout", "3", "--out", out] + list(extra)
    return subprocess.run(args, env=env, capture_output=True, text=True, timeout=120)


def saved_text(out):
    text = ""
    for dirpath, _, names in os.walk(out):
        for n in names:
            text += open(os.path.join(dirpath, n)).read()
    with zipfile.ZipFile(out + ".zip") as z:
        for n in z.namelist():
            text += z.read(n).decode()
    return text


def safe_requests(log, name, max_logins):
    paths = [r["path"] for r in log]
    ok(not any(p.startswith(f) for p in paths for f in ("/TMI/v1/gateway/reset", "/TMI/v1/auth/admin", "/TMI/v1/network/configuration", "/reboot", "/service_function")),
       name + ": never asks for anything that reboots or changes the gateway")
    ok(not any(("get=sim" in p or "get=clients" in p or "get=ap" in p or p.endswith("telemetry?get=all")) for p in paths),
       name + ": never asks for the SIM, the device list or the Wi-Fi settings")
    posts = [r["path"] for r in log if r["method"] == "POST"]
    ok(all(p == "/TMI/v1/auth/login" for p in posts) and len(posts) <= max_logins,
       name + ": the only thing it sends is the login, at most %d time(s) (sent %d)" % (max_logins, len(posts)))


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT)
    for model, fixture, api in (("kvd21", "kvd21.json", "tmi"), ("g4ar", "g4ar-n41.json", "tmi"),
                                ("g5ar", "g5ar.json", "tmi"), ("nokia", "nokia-5g21.json", "nokia")):
        data = json.load(open(os.path.join(HERE, "fixtures", "tmobile", fixture)))
        secret_values = identifiers(data)
        fake = Fake(model)
        try:
            out = os.path.join(OUT, model)
            r = run(fake, out, "--login", password=PASSWORD)
            ok(r.returncode == 0, "%s: the capture runs (exit %d)%s" % (model, r.returncode, "" if r.returncode == 0 else ": " + r.stdout[-400:] + r.stderr[-400:]))
            about = json.load(open(os.path.join(out, "about.json")))
            want_port = fake.ports[0] if data.get("port") == 8080 else fake.ports[1]
            ok(about["api"] == api and about["port"] == want_port, "%s: finds the %s API on the port it answers on" % (model, api))
            text = saved_text(out)
            leaked = sorted(s for s in secret_values if s in text)
            ok(not leaked, "%s: nothing identifying is saved (%d values checked)%s" % (model, len(secret_values), ": " + ", ".join(leaked) if leaked else ""))
            ok(PASSWORD not in text and json.dumps(PASSWORD)[1:-1] not in text, "%s: the password is not saved" % model)
            ok(os.path.exists(out + ".zip") and "README.txt" in "".join(zipfile.ZipFile(out + ".zip").namelist()),
               "%s: writes a zip with a README" % model)
            if api == "tmi":
                samples = [n for n in os.listdir(os.path.join(out, "tmi", "samples"))]
                ok(len(samples) == 3, "%s: saves every sample (%d)" % (model, len(samples)))
                g = json.load(open(os.path.join(out, "tmi", "gateway-all.json")))
                radio = (g["signal"].get("5g") or g["signal"].get("4g"))
                ok(isinstance(radio.get("rsrp"), int) and isinstance(radio.get("gNBID", radio.get("eNBID")), int),
                   "%s: signal values and stand-in tower IDs keep their types" % model)
                s1 = json.load(open(os.path.join(out, "tmi", "samples", "gateway-all-01.json")))["reply"]
                tech = "5g" if g["signal"].get("5g") else "4g"
                ok(s1["signal"][tech].get("gNBID", s1["signal"][tech].get("eNBID")) == radio.get("gNBID", radio.get("eNBID")),
                   "%s: the same tower gets the same stand-in in every file" % model)
                if "cell" in data:
                    cell = json.load(open(os.path.join(out, "tmi", "telemetry-cell.json")))
                    ok(cell["cell"]["gps"]["latitude"] == 0.0, "%s: logged in, saves the cell details with the GPS position removed" % model)
            safe_requests(fake.log(), model, 1)
        finally:
            fake.stop()

    # A refused login: one attempt, then reads only.
    fake = Fake("kvd21")
    try:
        r = run(fake, os.path.join(OUT, "refused"), "--login", password="wrong one")
        log = fake.log()
        ok(r.returncode == 0 and "refused the login" in r.stdout, "refused login: says so and carries on with the reads")
        ok(sum(1 for x in log if x["method"] == "POST") == 1, "refused login: tries once only, so the account cannot lock")
        ok(not any("telemetry" in x["path"] for x in log), "refused login: asks for nothing that needs a login")
        safe_requests(log, "refused login", 1)
    finally:
        fake.stop()

    # Without --login: no login at all.
    fake = Fake("g4ar")
    try:
        r = run(fake, os.path.join(OUT, "nologin"))
        log = fake.log()
        ok(r.returncode == 0 and not any(x["method"] == "POST" for x in log), "without --login: sends nothing at all")
    finally:
        fake.stop()

    # Nothing there.
    p = free_port()
    r = subprocess.run([sys.executable, TOOL, "--host", "127.0.0.1", "--port", str(p), "--samples", "1", "--timeout", "2",
                        "--out", os.path.join(OUT, "nothing")], capture_output=True, text=True, timeout=60)
    ok(r.returncode == 1 and "Nothing answered" in r.stdout, "nothing at the address: says so and exits with 1")

    # The tool cannot be made to request a path outside its list.
    try:
        cap.Gateway("127.0.0.1", 1).request(80, "/TMI/v1/gateway/reset?set=reboot")
        ok(False, "a reboot path is refused before any request is made")
    except RuntimeError:
        ok(True, "a reboot path is refused before any request is made")

    shutil.rmtree(OUT, ignore_errors=True)
    print("\nall checks passed" if not FAIL else "\n%d check(s) failed" % FAIL)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
