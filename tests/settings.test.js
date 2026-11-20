/*
 * Every setting is offered in LuCI's Settings page, in the GL.iNet panel's
 * Settings form and accepted by the panel's Lua module, and none of them
 * hands out the modem password. Read from the sources, so a setting added
 * in one place and forgotten in another fails here.
 * Run: node tests/settings.test.js
 */
var fs = require('fs'), path = require('path');
var PKG = path.join(__dirname, '..', 'luci-app-modemhealth');
var RES = path.join(PKG, 'htdocs/luci-static/resources');
var read = function(p) { return fs.readFileSync(path.join(PKG, p), 'utf8'); };

var fail = 0;
function ok(cond, name) { if (!cond) fail++; console.log((cond ? 'ok   ' : 'FAIL ') + name); }
function eq(got, want, name) {
	var g = JSON.stringify(got), w = JSON.stringify(want);
	ok(g === w, name + (g === w ? '' : ' (got ' + g + ', expected ' + w + ')'));
}
function all(re, text) { var out = [], m; while ((m = re.exec(text))) out.push(m[1]); return out; }
function sorted(a) { return a.slice().sort(); }

var health = new Function('baseclass', fs.readFileSync(path.join(RES, 'modemhealth/health.js'), 'utf8'))({ extend: function(o) { return o; } });
var luci = read('htdocs/luci-static/resources/view/modemhealth/settings.js');
var gl = read('htdocs/luci-static/resources/modemhealth/gl.js');
var lua = read('root/usr/lib/oui-httpd/rpc/modemhealth');
var config = read('root/etc/config/modemhealth');

/* LuCI: s.taboption('tab', form.X, 'name', ...); names starting with "_"
 * are not stored (the password field, the test button and its result). */
var luciAll = all(/taboption\('\w+', form\.\w+, '(\w+)'/g, luci);
var luciOptions = luciAll.filter(function(n) { return n.charAt(0) !== '_'; });
/* The panel's form: { key: 'name', type: ... } in sections(). */
var glAll = all(/\{ key: '(\w+)', type: '/g, gl);
var glOptions = glAll.filter(function(n) { return n !== 'password'; });
/* The module: the keys of FIELDS. */
var fieldsBlock = /local FIELDS = \{\n([\s\S]*?)\n\}/.exec(lua)[1];
var luaFields = all(/^    (\w+) = \{/gm, fieldsBlock);

ok(luciOptions.length >= 6, 'LuCI offers %d settings: %s'.replace('%d', luciOptions.length).replace('%s', luciOptions.join(', ')));
eq(sorted(glOptions), sorted(luciOptions), 'the panel\'s form offers the same settings as LuCI\'s');
eq(sorted(luaFields), sorted(luciOptions), 'the panel\'s module accepts the same settings, and no others');
var defaults = all(/^\toption (\w+) /gm, config);
ok(luciOptions.every(function(n) { return defaults.indexOf(n) >= 0; }), 'each has a default in /etc/config/modemhealth');
var glDefaults = all(/(\w+): '/g, /var DEFAULTS = \{([^}]*)\}/.exec(gl)[1]);
eq(sorted(glDefaults), sorted(luciOptions), 'the panel\'s form knows the default of each');
luciOptions.forEach(function(n) {
	var inConfig = new RegExp("option " + n + " '([^']*)'").exec(config)[1];
	var inGl = new RegExp(n + ": '([^']*)'").exec(/var DEFAULTS = \{([^}]*)\}/.exec(gl)[1])[1];
	eq(inGl, inConfig, 'default of ' + n + ' is the same in the panel as in the package');
});

/* The password: a field in both forms, never a stored setting. */
ok(luciAll.indexOf('_password') >= 0 && glAll.indexOf('password') >= 0, 'both forms have a password field');
ok(luciAll.indexOf('_test') >= 0 && /call\('test', \{ host: /.test(gl), 'both forms have Test connection');
ok(luaFields.indexOf('password') < 0 && !/option password/.test(config), 'the password is not among the settings the forms load');
ok(/cfgvalue = function\(\) \{ return ''; \}/.test(luci) && !/password[^\n]*\.value = (?!'')/.test(gl), 'neither form fills the password field in');
var acl = JSON.parse(read('root/usr/share/rpcd/acl.d/luci-app-modemhealth.json'))['luci-app-modemhealth'];
eq([ acl.read.uci, acl.write.uci ], [ [ 'modemhealth' ], [ 'modemhealth' ] ], 'LuCI may read and write the settings file only, not the password file');

/* Health limits: built from health.js in both forms, listed in the module. */
var keys = health.limitList().map(function(it) { return it.key; });
var luaKeys = all(/"(\w+)"/g, /local LIMIT_KEYS = \{([\s\S]*?)\}/.exec(lua)[1]);
eq(sorted(luaKeys), sorted(keys), 'the module knows the same %d health limits as health.js'.replace('%d', keys.length));
var luaBounds = all(/"(\w+)"/g, /local BOUNDS = \{([^}]*)\}/.exec(lua)[1]);
var options = [];
health.limitList().forEach(function(it) { health.limitFields(it.key, it.limit).forEach(function(f) { options.push(f.option); }); });
ok(options.every(function(o) {
	return luaKeys.some(function(k) { return luaBounds.some(function(b) { return o === k + '_' + b; }); });
}), 'every bound a form can set (%d) is one the module accepts'.replace('%d', options.length));
ok(/H\.limitList\(\)/.test(luci) && /H\.limitFields\(/.test(luci), 'LuCI\'s form builds its limit fields from health.js');
ok(/H\.limitList\(\)/.test(gl) && /H\.limitFields\(/.test(gl), 'the panel\'s form builds its limit fields from health.js');
ok(/config limits 'limits'/.test(config), 'the limits section exists in the package\'s settings');

/* The views only use what the panel's stand-ins provide. */
var overview = read('htdocs/luci-static/resources/view/modemhealth/overview.js');
var common = fs.readFileSync(path.join(RES, 'modemhealth/common.js'), 'utf8');
var requires = all(/^'require ([\w.]+)/gm, overview + '\n' + common).filter(function(n, i, a) { return a.indexOf(n) === i; });
var builtin = all(/(\w+):/g, /var BUILTIN = \{([\s\S]*?)\};/.exec(gl)[1]).concat([ 'rpc', 'ui', 'uci', 'dom' ]);
ok(requires.every(function(n) { return /^modemhealth\./.test(n) || builtin.indexOf(n) >= 0; }),
	'the Overview needs only modules the panel has a stand-in for (%s)'.replace('%s', requires.join(', ')));
var used = all(/\bui\.(\w+)\(/g, overview).concat(all(/\buci\.(\w+)\(/g, overview)).concat(all(/\bL\.(\w+)\(/g, overview + common));
used = used.filter(function(n, i, a) { return a.indexOf(n) === i; });
ok(used.every(function(n) { return new RegExp('\\b' + n + ': function').test(gl); }),
	'every ui, uci and L function the Overview calls has one (%s)'.replace('%s', used.join(', ')));
var methods = all(/method: '(\w+)'/g, common), renamed = { status: 'get_status', data: 'get_data' };
ok(methods.every(function(m) { return new RegExp('^M\\.' + (renamed[m] || m) + ' = function', 'm').test(lua); }),
	'every call the pages make exists in the module (%s)'.replace('%s', methods.join(', ')));
var rpcd = read('root/usr/libexec/rpcd/luci.modemhealth');
ok(methods.every(function(m) { return new RegExp('^\\t\\t\\t' + m + '\\)', 'm').test(rpcd); }), 'and in the rpcd plugin');

console.log(fail ? '\n' + fail + ' check(s) failed' : '\nall checks passed');
process.exit(fail ? 1 : 0);
