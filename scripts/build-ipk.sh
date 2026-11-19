#!/bin/sh
# Build luci-app-modemhealth_<version>_all.ipk without the OpenWrt SDK.
# The package is architecture independent (shell + JavaScript), so this
# works on any Linux or macOS machine with tar and gzip.
#
# Usage: scripts/build-ipk.sh [output-dir]
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PKG=luci-app-modemhealth
SRC="$ROOT/$PKG"
VERSION=$(sed -n 's/^PKG_VERSION:=//p' "$SRC/Makefile")
RELEASE=$(sed -n 's/^PKG_RELEASE:=//p' "$SRC/Makefile")
OUT=${1:-"$ROOT/dist"}

export COPYFILE_DISABLE=1   # no macOS ._ files in the archives
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data/www" "$WORK/control" "$OUT"
OUT=$(cd "$OUT" && pwd)
IPK="$OUT/${PKG}_${VERSION}-r${RELEASE}_all.ipk"

cp -R "$SRC/root/." "$WORK/data/"
[ -d "$SRC/htdocs" ] && cp -R "$SRC/htdocs/." "$WORK/data/www/"
find "$WORK/data" -type f -exec chmod 644 {} +
find "$WORK/data" -type d -exec chmod 755 {} +
chmod 755 "$WORK/data/usr/bin/modemhealth"
# The config holds the modem password: root only.
chmod 600 "$WORK/data/etc/config/modemhealth"
rmdir "$WORK/data/www" 2>/dev/null || true

SIZE=$(du -sk "$WORK/data" | cut -f1)
cat > "$WORK/control/control" <<CTRL
Package: $PKG
Version: ${VERSION}-r${RELEASE}
Depends: libc, curl, jsonfilter, openssl-util
Source: https://github.com/chaffed/luci-app-modemhealth
SourceName: $PKG
License: MIT
Section: luci
Architecture: all
Installed-Size: $((SIZE * 1024))
Description: Modem Health - cable modem signal, errors and outages.
 Reads a cable modem's status (SURFboard S33/S34) on a schedule, keeps its
 signal levels, error counts, event log, reboots and outages as evidence,
 and builds a report for the ISP.
CTRL
echo "/etc/config/modemhealth" > "$WORK/control/conffiles"

cat > "$WORK/control/postinst" <<'POST'
#!/bin/sh
[ -n "$IPKG_INSTROOT" ] && exit 0
# The config holds the modem password: keep it root only, also on upgrade.
chmod 600 /etc/config/modemhealth 2>/dev/null
exit 0
POST
chmod 755 "$WORK/control/postinst"

# GNU tar and bsdtar spell "owned by root" differently.
if tar --version 2>/dev/null | grep -q GNU; then
	TAROPTS="--owner=0 --group=0 --numeric-owner --format=gnu"
else
	TAROPTS="--uid 0 --gid 0 --numeric-owner --format=gnutar"
fi

# shellcheck disable=SC2086
( cd "$WORK/data" && tar $TAROPTS -czf ../data.tar.gz . )
# shellcheck disable=SC2086
( cd "$WORK/control" && tar $TAROPTS -czf ../control.tar.gz . )
echo "2.0" > "$WORK/debian-binary"
# shellcheck disable=SC2086
( cd "$WORK" && tar $TAROPTS -cf - ./debian-binary ./data.tar.gz ./control.tar.gz | gzip -n > "$IPK" )

echo "$IPK"
