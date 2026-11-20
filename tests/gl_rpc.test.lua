--[[
    Checks Modem Health's module for the GL.iNet admin panel
    (luci-app-modemhealth/root/usr/lib/oui-httpd/rpc/modemhealth) with
    stand-ins for the panel's web server (ngx.pipe), for UCI and for the
    files it writes. Needs Lua 5.1 and lua-cjson.
    Run: lua tests/gl_rpc.test.lua [path/to/module]
--]]

local here = (arg and arg[0] or ""):match("^(.*)/[^/]*$") or "."
local module_path = arg and arg[1] or (here .. "/../luci-app-modemhealth/root/usr/lib/oui-httpd/rpc/modemhealth")

-- Quoting characters, as in the backend test.
local PASSWORD = "Pa ss,w\"o'r$d\\`1<b>"

-- ------------------------------------------------------------ stand-ins --

local spawned, spawn_opts = {}, {}
local outputs = {
    status = '{"enabled":true,"scheduler":true,"password_set":true,"interval":5,"last":"1,ok"}',
    data = '{"since":0,"until":9,"readings":"ts,result\\n1,ok\\n","channels":"","events":"","channelmap":""}',
    ["test-input"] = "/var/run/modemhealth/test-input.aBc123\n",
    test = '{"ok":true,"model":"S34","firmware":"fw","downstream":34,"upstream":5}',
}

-- Like the panel's own ngx.pipe (/usr/share/gl-ngx/oui-init.lua): spawn(args,
-- opts) and a process with stdout_read_all() and wait(), nothing else.
ngx = {
    pipe = {
        spawn = function(cmd, opts)
            spawned[#spawned + 1] = cmd
            spawn_opts[#spawn_opts + 1] = opts or {}
            local proc = {
                stdout_read_all = function() return outputs[cmd[2]] or "" end,
                wait = function() return outputs[cmd[2]] or "" end,
            }
            return setmetatable(proc, { __index = function(_, k)
                error("the panel's ngx.pipe has no method " .. tostring(k), 2)
            end })
        end,
    },
}

-- Files the module opens: what was written, by name.
local files = {}
local real_open = io.open
io.open = function(name, mode)
    if name:match("^/var/run/") or name:match("^/etc/config/") then
        local f = { name = name, mode = mode, text = "" }
        files[#files + 1] = f
        return {
            write = function(_, ...) f.text = f.text .. table.concat({ ... }) return true end,
            close = function() f.closed = true return true end,
        }
    end
    return real_open(name, mode)
end

local store, committed
local function reset_store()
    store = {
        modemhealth = {
            main = { [".type"] = "modemhealth", enabled = "1", interval = "5", host = "192.168.100.1",
                username = "admin", timeout = "15", data_dir = "/etc/modemhealth" },
            limits = { [".type"] = "limits", us_power_4_good_max = "49" },
        },
        modemhealth_auth = { main = { [".type"] = "auth", password = "the old one" } },
    }
    committed = {}
end

package.loaded.uci = {
    cursor = function()
        return {
            get = function(_, conf, sec, opt)
                local s = store[conf] and store[conf][sec]
                if not s then return nil end
                if opt == nil then return s[".type"] end
                return s[opt]
            end,
            set = function(_, conf, sec, a, b)
                store[conf] = store[conf] or {}
                if b == nil then
                    store[conf][sec] = store[conf][sec] or { [".type"] = a }
                else
                    store[conf][sec][a] = b
                end
                return true
            end,
            delete = function(_, conf, sec, opt) store[conf][sec][opt] = nil return true end,
            commit = function(_, conf) committed[#committed + 1] = conf return true end,
        }
    end,
}

reset_store()
local M = dofile(module_path)

-- ---------------------------------------------------------------- checks --

local fail = 0
local function ok(name, cond, detail)
    if not cond then fail = fail + 1 end
    print((cond and "ok   " or "FAIL ") .. name .. ((cond or detail == nil) and "" or (": " .. tostring(detail))))
end

local function last_cmd() return table.concat(spawned[#spawned] or {}, " ") end
local function all_args()
    local t = {}
    for _, c in ipairs(spawned) do t[#t + 1] = table.concat(c, " ") end
    return table.concat(t, "\n")
end

-- commands
local st = M.get_status()
ok("get_status decodes what modemhealth prints", st.password_set == true and st.interval == 5)
ok("get_status runs modemhealth status", last_cmd() == "/usr/bin/modemhealth status", last_cmd())

local d = M.get_data({ since = 1795000000, ["until"] = 1795086400 })
ok("get_data returns the stored text", d.readings == "ts,result\n1,ok\n")
ok("get_data passes whole numbers", last_cmd() == "/usr/bin/modemhealth data 1795000000 1795086400", last_cmd())
M.get_data({ since = 1795000000 })
ok("get_data without an end leaves it to the backend (now)", last_cmd() == "/usr/bin/modemhealth data 1795000000", last_cmd())
M.get_data({ since = -5, ["until"] = 99999999999 })
ok("get_data clamps out-of-range numbers", last_cmd() == "/usr/bin/modemhealth data 0 4294967295", last_cmd())
M.get_data({ since = "1; reboot", ["until"] = 2.7 })
ok("get_data ignores text where a number belongs", last_cmd() == "/usr/bin/modemhealth data 0 2", last_cmd())
M.get_data(nil)
ok("get_data works without arguments", last_cmd() == "/usr/bin/modemhealth data 0", last_cmd())
ok("commands are argument lists, never a shell line", type(spawned[#spawned]) == "table" and #spawned[#spawned] == 3)
ok("a time limit is passed the way the panel expects", spawn_opts[#spawn_opts].stdout_read_timeout == 60000, spawn_opts[#spawn_opts].stdout_read_timeout)

local c = M.check()
ok("check reads the modem, then returns the status", c.scheduler == true and spawned[#spawned - 1][2] == "check" and last_cmd() == "/usr/bin/modemhealth status")

outputs.status = "not json"
local bad = M.get_status()
ok("an unreadable answer becomes an error", bad.err_code == -1 and bad.err_msg ~= nil)
outputs.status = '{"password_set":true}'

-- the panel logs every call whose name has no "get", "load" or "check" in it
for _, name in ipairs({ "get_status", "get_data", "get_config", "check" }) do
    ok(name .. " is not written to the system log on every call",
        type(M[name]) == "function" and (name:find("get") or name:find("load") or name:find("check")) ~= nil)
end

-- settings: reading
local cfg = M.get_config()
ok("get_config returns the settings", cfg.config.interval == "5" and cfg.config.host == "192.168.100.1")
ok("get_config returns the changed limits", cfg.limits.us_power_4_good_max == "49")
ok("get_config leaves out options that are not settings", cfg.config.timeout == nil and cfg.config.data_dir == nil)
local leaked = false
for _, t in pairs(cfg) do
    if type(t) == "table" then
        for k, v in pairs(t) do
            if k == "password" or v == "the old one" then leaked = true end
        end
    end
end
ok("get_config never contains the password", not leaked and cfg.password == nil)

-- settings: writing
local function try(values)
    reset_store()
    return M.set_config({ values = values })
end

local r = try({ enabled = true, interval = 10, host = "modem.lan:8443", username = "admin", ping_host = "",
    history_days = "30", ds_power_good_min = -5.5, us_power_4_good_max = "", t3_per_day_acceptable_max = "10" })
local m, l = store.modemhealth.main, store.modemhealth.limits
ok("valid settings are saved", r.saved == true and #committed == 1 and committed[1] == "modemhealth", r.err_msg)
ok("true is stored as 1, numbers as text", m.enabled == "1" and m.interval == "10" and m.history_days == "30")
ok("an address with a port is accepted", m.host == "modem.lan:8443")
ok("empty optional settings are removed", m.ping_host == nil)
ok("limits go to their own section", l.ds_power_good_min == "-5.5" and l.t3_per_day_acceptable_max == "10" and m.ds_power_good_min == nil)
ok("an emptied limit is removed (the default applies again)", l.us_power_4_good_max == nil)
ok("settings not sent are left alone", m.timeout == "15" and m.data_dir == "/etc/modemhealth")
ok("the password file is not touched by set_config", store.modemhealth_auth.main.password == "the old one")

r = try({ isp_name = "Example Cable, Inc.", subscriber = "Zoë O'Brien", account = "8155 60 012 3456789",
    service_address = "100 Example Street, Apt #4, Springfield" })
m = store.modemhealth.main
ok("report details with commas, apostrophes and accents are kept",
    r.saved and m.subscriber == "Zoë O'Brien" and m.service_address == "100 Example Street, Apt #4, Springfield" and m.isp_name == "Example Cable, Inc.")
r = try({ account = "" })
ok("an emptied report detail is removed", r.saved and store.modemhealth.main.account == nil)

r = try({ interval = "  15  " })
ok("surrounding spaces are trimmed", r.saved and store.modemhealth.main.interval == "15")

reset_store()
store.modemhealth.limits = nil
r = M.set_config({ values = { ds_snr_good_min = "35" } })
ok("the limits section is made when missing", r.saved and store.modemhealth.limits[".type"] == "limits" and store.modemhealth.limits.ds_snr_good_min == "35")

local refused = {
    { "interval of 0", { interval = "0" }, "interval" },
    { "interval above an hour", { interval = "61" }, "interval" },
    { "interval not a number", { interval = "5m" }, "interval" },
    { "required setting left empty", { host = "" }, "host" },
    { "address that is an option", { host = "-o/tmp/x" }, "host" },
    { "address with a space", { host = "192.168.100.1 ; reboot" }, "host" },
    { "address with a path", { host = "192.168.100.1/x" }, "host" },
    { "user name with a line break", { username = "admin\nx" }, "username" },
    { "user name left empty", { username = "" }, "username" },
    { "ping host with a port", { ping_host = "[::1]:80" }, "ping_host" },
    { "history of 0 days", { history_days = "0" }, "history_days" },
    { "history above two years", { history_days = "731" }, "history_days" },
    { "limit that is not a number", { ds_power_good_min = "low" }, "ds_power_good_min" },
    { "limit with a command in it", { ds_power_good_min = "1;reboot" }, "ds_power_good_min" },
    { "limit that does not exist", { ds_power_best_min = "1" }, "ds_power_best_min" },
    { "report text over 120 bytes", { isp_name = string.rep("x", 121) }, "isp_name" },
    { "report text with a line break", { subscriber = "A\nB" }, "subscriber" },
    { "report text with a control character", { account = "12\0273" }, "account" },
    { "the password through set_config", { password = "x" }, "password" },
    { "where the history is kept", { data_dir = "/tmp/x" }, "data_dir" },
    { "a table where text belongs", { username = { "x" } }, "username" },
}
for _, t in ipairs(refused) do
    local res = try(t[2])
    ok("refused: " .. t[1], res.err_code == -1 and res.field == t[3] and #committed == 0, res.field or res.saved)
end

r = try({ interval = "10", host = "bad host" })
ok("nothing is stored when one value is refused", store.modemhealth.main.interval == "5" and #committed == 0)
ok("no settings sent: refused", try(nil).err_code == -1 and M.set_config({ values = "x" }).err_code == -1)

-- the password
reset_store()
store.modemhealth.main.password = "kept by 0.1.0-r1"
spawned, files = {}, {}
r = M.set_password({ password = PASSWORD })
ok("set_password stores the password exactly", r.ok == true and store.modemhealth_auth.main.password == PASSWORD)
ok("set_password writes it to the root-only file, which it makes root only first",
    committed[1] == "modemhealth_auth" and last_cmd() == "/bin/chmod 600 /etc/config/modemhealth_auth", last_cmd())
ok("set_password removes a password kept with the settings by older versions",
    store.modemhealth.main.password == nil and committed[2] == "modemhealth")
ok("set_password never puts the password on a command line or in a file of its own",
    not all_args():find("Pa ss", 1, true) and (files[1] == nil or files[1].text == ""))
for _, t in ipairs({ { "an empty password", "" }, { "a password with a line break", "a\nb" },
        { "a password over 128 bytes", string.rep("x", 129) }, { "a number", 5 } }) do
    reset_store()
    local res = M.set_password({ password = t[2] })
    ok("set_password refuses " .. t[1], res.err_code == -1 and store.modemhealth_auth.main.password == "the old one" and #committed == 0)
end

-- test connection
spawned, files = {}, {}
r = M.test({ host = "192.168.100.1", username = "admin", password = PASSWORD })
ok("test returns what the backend found", r.ok == true and r.model == "S34" and r.downstream == 34)
ok("test asks the backend for a file, then gives it that file's name",
    table.concat(spawned[1], " ") == "/usr/bin/modemhealth test-input"
    and table.concat(spawned[2], " ") == "/usr/bin/modemhealth test /var/run/modemhealth/test-input.aBc123", all_args())
ok("test writes address, user name and password into that file, one per line",
    #files == 1 and files[1].name == "/var/run/modemhealth/test-input.aBc123" and files[1].mode == "w"
    and files[1].text == "192.168.100.1\nadmin\n" .. PASSWORD .. "\n" and files[1].closed == true, files[1] and files[1].text)
ok("test never puts the password on a command line", not all_args():find("Pa ss", 1, true))

spawned, files = {}, {}
M.test({})
ok("test with nothing typed leaves all three lines empty (the saved settings are used)", files[1].text == "\n\n\n")

for _, t in ipairs({
    { "an address with a space", { host = "a b" }, "host" },
    { "a user name with a line break", { username = "a\nb" }, "username" },
    { "a password with a line break (it would become two lines)", { password = "a\nb" }, "password" },
    { "a table as password", { password = { "x" } }, "password" },
}) do
    spawned, files = {}, {}
    local res = M.test(t[2])
    ok("test refuses " .. t[1], res.ok == false and res.reason == "invalid_input" and res.field == t[3] and #spawned == 0 and #files == 0)
end

for _, path in ipairs({ "/etc/passwd\n", "/var/run/modemhealth/test-input.x/../../etc/passwd\n", "/var/run/modemhealth/other\n", "" }) do
    spawned, files = {}, {}
    outputs["test-input"] = path
    local res = M.test({ password = "x" })
    ok("test writes nowhere when the backend names " .. (path == "" and "no file" or path:gsub("\n", "")),
        res.ok == false and res.reason == "no_input_file" and #files == 0 and #spawned == 1)
end
outputs["test-input"] = "/var/run/modemhealth/test-input.aBc123\n"
outputs.test = '{"ok":false,"reason":"login_refused"}'
ok("test passes on why the modem refused", M.test({ password = "wrong" }).reason == "login_refused")
outputs.test = ""
r = M.test({ password = "x" })
ok("test without an answer says so", r.ok == false and r.reason == "no_answer")

-- every setting the LuCI page offers can be set from the panel
local luci = { "enabled", "interval", "host", "username", "ping_host", "history_days",
    "isp_name", "subscriber", "account", "service_address" }
local missing, n = {}, 0
for _, k in ipairs(luci) do if not M.FIELDS[k] then missing[#missing + 1] = k end end
for _ in pairs(M.FIELDS) do n = n + 1 end
ok("every LuCI setting is known, and nothing else (" .. #luci .. ")", #missing == 0 and n == #luci, table.concat(missing, ","))
n = 0
for _ in pairs(M.LIMITS) do n = n + 1 end
ok("17 limits with four bounds each", n == 68, n)

print(fail == 0 and "all passed" or (fail .. " FAILED"))
os.exit(fail == 0 and 0 or 1)
