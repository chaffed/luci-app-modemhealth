# OpenWrt 23.05 with the tools Modem Health's backend uses, for tests.
# Same release as GL.iNet firmware 4.x (GL-BE9300: OpenWrt 23.05).
FROM openwrt/rootfs:x86-64-23.05.6
RUN mkdir -p /var/lock /var/run && opkg update && opkg install curl openssl-util && rm -rf /tmp/opkg-lists
