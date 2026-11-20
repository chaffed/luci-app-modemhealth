-- Modem Health for the GL.iNet admin panel (luci-app-modemhealth).
-- set_config, set_password and test check every value themselves
-- (/usr/lib/oui-httpd/rpc/modemhealth). The panel's default check only
-- allows letters, digits and " .-_:#/", which would refuse an ordinary
-- modem password. The other methods only take numbers and keep the default
-- check.
-- SPDX-License-Identifier: MIT
return { set_config = true, set_password = true, test = true }
