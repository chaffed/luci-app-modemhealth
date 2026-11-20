# Modem Health - cable modem health monitoring for LuCI
# Drop this directory into an OpenWrt/LuCI feed (feeds/luci/applications/)
# or build a standalone .ipk with scripts/build-ipk.sh.
#
# SPDX-License-Identifier: MIT

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-modemhealth
PKG_VERSION:=0.1.0
PKG_RELEASE:=4
PKG_LICENSE:=MIT

LUCI_TITLE:=Modem Health - cable modem signal, errors and outages
LUCI_DESCRIPTION:=Reads a cable modem's status (SURFboard S33/S34) on a \
	schedule, keeps its signal levels, error counts, event log, reboots and \
	outages as evidence, and builds a report for the ISP.
LUCI_DEPENDS:=+luci-base +curl +jsonfilter +openssl-util
LUCI_PKGARCH:=all

define Package/luci-app-modemhealth/conffiles
/etc/config/modemhealth
/etc/config/modemhealth_auth
endef

include ../../luci.mk

# call BuildPackage - OpenWrt buildroot signature
