# Modem Health

**Modem Health** is a LuCI app for OpenWrt and GL.iNet routers that monitors
the health of your cable modem: downstream and upstream channel levels,
signal-to-noise and error counts, the modem's event log, reboots, and
outages. It keeps a history on the router, writes logs and a report to a USB
drive, and appears in both LuCI and the GL.iNet admin panel.

The report is meant as evidence for your ISP: it shows when the line, not
your equipment, was out of spec.

**Status:** early development. First supported modems: ARRIS/Vantiva
SURFboard (S33 first).

Companion to [ISPy](https://github.com/chaffed/luci-app-ispy): when ISPy is
installed, Modem Health lines up slow speed tests with signal problems.

## License

MIT
