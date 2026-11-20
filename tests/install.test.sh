#!/bin/sh
# The package as people get it: the .ipk, installed with opkg on a clean
# OpenWrt 23.05 (a container), then upgraded to a newer release, removed and
# installed again. Settings, the modem password and the history must come
# through all of it. Needs Docker.
#
# Run: sh tests/install.test.sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/.test-out/install"   # inside the repo: Docker Desktop does not share the system temp folder
rm -rf "$OUT"
mkdir -p "$OUT"
VERSION=$(sed -n 's/^PKG_VERSION:=//p' "$ROOT/luci-app-modemhealth/Makefile")
RELEASE=$(sed -n 's/^PKG_RELEASE:=//p' "$ROOT/luci-app-modemhealth/Makefile")
sh "$ROOT/scripts/build-ipk.sh" "$OUT" >/dev/null
MODEMHEALTH_RELEASE=$((RELEASE + 1)) sh "$ROOT/scripts/build-ipk.sh" "$OUT" >/dev/null

docker run --rm --platform linux/amd64 -v "$OUT:/dist:ro" -e VERSION="$VERSION" -e RELEASE="$RELEASE" openwrt/rootfs:x86-64-23.05.6 sh -c '
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
check() { if eval "$1" >/dev/null 2>&1; then ok "$2"; else bad "$2"; fi; }
this=/dist/luci-app-modemhealth_${VERSION}-r${RELEASE}_all.ipk
newer=/dist/luci-app-modemhealth_${VERSION}-r$((RELEASE + 1))_all.ipk
mode() { ls -l "$1" | cut -c1-10; }
mkdir -p /var/lock /var/run
opkg update >/dev/null 2>&1 || { echo "FAIL opkg update (no network?)"; exit 1; }

# ------------------------------------------------------------ clean install
opkg install "$this" >/tmp/install.log 2>&1 || { cat /tmp/install.log; echo "FAIL the package does not install"; exit 1; }
check "opkg list-installed | grep -q \"^luci-app-modemhealth - ${VERSION}-r${RELEASE}\$\"" "clean install: ${VERSION}-r${RELEASE} installs with its dependencies"
check "[ \"\$(modemhealth status | jsonfilter -e @.version)\" = \"$VERSION\" ]" "clean install: the program says it is $VERSION"
check "[ \"\$(mode /etc/config/modemhealth)\$(mode /etc/config/modemhealth_auth)\" = -rw--------rw------- ]" "clean install: settings and password file are readable by root only"
check "[ -x /etc/init.d/modemhealth ] && ls /etc/rc.d/ | grep -q modemhealth" "clean install: the scheduler is set to start with the router"
check "[ ! -e /etc/uci-defaults/80_modemhealth ]" "clean install: the first-run script ran"
check "[ -s /usr/share/luci/menu.d/luci-app-modemhealth.json ] && [ -s /usr/share/rpcd/acl.d/luci-app-modemhealth.json ] && [ -x /usr/libexec/rpcd/luci.modemhealth ]" "clean install: LuCI menu entry, permissions and its router-side program are in place"
check "[ -s /www/views/gl-sdk4-ui-modemhealth.common.js ] && [ -s /usr/share/oui/menu.d/modemhealth.json ] && [ -s /usr/lib/oui-httpd/rpc/modemhealth ]" "clean install: the files for the GL.iNet admin panel are in place"
check "[ \"\$(modemhealth status | jsonfilter -e @.password_set)\" = false ]" "clean install: no modem password yet"
modemhealth check >/dev/null 2>&1
check "grep -q \",failed,no_password,\" /etc/modemhealth/readings/*.csv" "clean install: a check without a password is stored as failed, with that reason"

# what the owner then does
uci set modemhealth.main.interval=10
uci set modemhealth.main.subscriber="Alex Example"
uci set modemhealth.limits.t3_per_day_good_max=3
uci commit modemhealth
echo "s3cret pass" | modemhealth set-password >/dev/null
before=$(cat /etc/modemhealth/readings/*.csv | md5sum)
kept() {
	[ "$(uci -q get modemhealth.main.interval)" = 10 ] && [ "$(uci -q get modemhealth.main.subscriber)" = "Alex Example" ] &&
	[ "$(uci -q get modemhealth.limits.t3_per_day_good_max)" = 3 ] && [ "$(uci -q get modemhealth_auth.main.password)" = "s3cret pass" ] &&
	[ "$(cat /etc/modemhealth/readings/*.csv | md5sum)" = "$before" ] &&
	[ "$(mode /etc/config/modemhealth)$(mode /etc/config/modemhealth_auth)" = -rw--------rw------- ]
}

# ------------------------------------------------------------------ upgrade
opkg install "$newer" >/tmp/upgrade.log 2>&1 || cat /tmp/upgrade.log
check "opkg list-installed | grep -q \"^luci-app-modemhealth - ${VERSION}-r$((RELEASE + 1))\$\"" "upgrade: a newer release installs over it"
check kept "upgrade: settings, changed limit, password and history are kept, still readable by root only"
check "! ls /etc/config/ | grep -q -- -opkg" "upgrade: no stray copies of the settings files are left behind"
check "ls /etc/rc.d/ | grep -q modemhealth && [ ! -e /etc/uci-defaults/80_modemhealth ]" "upgrade: the scheduler is still set to start"

# ------------------------------------------------------ remove, install again
opkg remove luci-app-modemhealth >/tmp/remove.log 2>&1 || cat /tmp/remove.log
check "[ ! -e /usr/bin/modemhealth ] && [ ! -e /etc/init.d/modemhealth ] && [ ! -e /www/views/gl-sdk4-ui-modemhealth.common.js ] && ! ls /etc/rc.d/ | grep -q modemhealth" "remove: the program, the scheduler and the pages are gone"
check "[ -s /etc/config/modemhealth ] && [ -s /etc/config/modemhealth_auth ] && ls /etc/modemhealth/readings/*.csv" "remove: settings, password and history stay on the router"
opkg install "$this" >/tmp/again.log 2>&1 || cat /tmp/again.log
check kept "install again: picks up the kept settings, password and history"
check "! ls /etc/config/ | grep -q -- -opkg && [ \"\$(modemhealth status | jsonfilter -e @.password_set)\" = true ]" "install again: no stray copies; the saved password is in use"

[ "$fail" = 0 ] && echo && echo "all checks passed"
[ "$fail" = 0 ] || { echo; echo "$fail check(s) failed"; exit 1; }
'
