/*
 * Modem Health in the GL.iNet admin panel, driven by a real browser.
 *
 * The panel itself is not ours to ship, so a stand-in page plays its part
 * (tests/gl/panel.html: loads the view file the way the panel does and
 * provides its $request), and tests/gl/rpc.lua runs the real Lua module
 * with the panel's own rules (argument check, ngx.pipe). Behind them
 * everything is real: the module, the backend, the stored history, the
 * fake modem. Screenshots are left in .test-out/gl/.
 *
 * Run: node tests/gl.test.js (what it needs: see tests/webrig.js).
 */
var fs = require('fs'), path = require('path');
var rig = require('./webrig.js');
var gen = rig.gen, ok = rig.ok, eq = rig.eq, sleep = rig.sleep, router = rig.router, modemControl = rig.modemControl;

var PASSWORD = rig.PASSWORD, MODEM_PORT = rig.MODEM_PORT;
var SHOTS = path.join(rig.ROOT, '.test-out', 'gl');

async function main() {
	fs.mkdirSync(SHOTS, { recursive: true });
	var r = await rig.start({ setup: [
		'cp /tests/gl/panel.html /www/gl-panel.html',
		'cp /tests/gl/rpc.lua /www/cgi-bin/gl-rpc && chmod 755 /www/cgi-bin/gl-rpc'
	] });
	try {
		var page = r.page, made = r.made, now = r.now, out = r.out;
		r.watch();

		/* ------------------------------------------------- what the panel reads */
		var menu = JSON.parse(router('cat /usr/share/oui/menu.d/modemhealth.json'));
		eq([ menu.view, menu.parent, menu.level ], [ 'modemhealth', 'applications', 2 ], 'menu: an entry under Applications');
		eq(router('for l in de en es it ja zh-cn zh-tw; do grep -c \'"menu_modemhealth": "Modem Health"\' /www/i18n/gl-sdk4-ui-modemhealth.$l.json; done').trim().split('\n').join(''),
			'1111111', 'menu: its label in each of the panel\'s languages');

		await page.goto(rig.WEB + '/gl-panel.html');
		await page.waitForSelector('iframe[title="Modem Health"]');
		eq(await page.textContent('#menu-label'), 'Modem Health', 'panel: the view file loads as a component and is named after its menu entry');
		var frame = function() { return page.frames().filter(function(f) { return f !== page.mainFrame(); })[0]; };
		var F = page.frameLocator('iframe[title="Modem Health"]');
		await F.locator('.mhgl-nav').waitFor();
		eq(await F.locator('.mhgl-nav button').allTextContents(), [ 'Overview', 'Settings' ], 'panel: Overview and Settings');

		/* ----------------------------------------------- no password saved yet */
		await F.locator('svg.mh-chart').first().waitFor({ timeout: 60000 });
		ok(/needs your modem's password/.test(await F.locator('#mhgl-view').innerText()), 'overview: asks for the modem password while none is saved');
		await F.locator('a:has-text("Open Settings")').click();
		await F.locator('#mhgl-f-host').waitFor();
		eq(await F.locator('.mhgl-nav button[aria-current=page]').textContent(), 'Settings', 'overview: its link to Settings works inside the frame');

		/* ----------------------------------------------------------- Settings */
		var val = function(k) { return F.locator('#mhgl-f-' + k).inputValue(); };
		eq([ await val('host'), await val('username'), await val('password'), await val('interval'), await val('history_days') ],
			[ '192.168.100.1', 'admin', '', '5', '90' ], 'settings: the stored settings and the defaults; the password field empty');
		var test = async function() {
			await F.locator('button:has-text("Test connection")').click();
			await frame().waitForFunction(function() {
				var e = document.getElementById('mhgl-test-result');
				return e && e.textContent && e.textContent !== 'Testing…';
			}, null, { timeout: 60000 });
			return F.locator('#mhgl-test-result').textContent();
		};
		await F.locator('#mhgl-f-host').fill('modem:' + MODEM_PORT);
		await F.locator('#mhgl-f-password').fill(PASSWORD);
		eq(await test(), 'Connected: S34, firmware AT01.01.010.042324_S3.04.735, 34 downstream and 5 upstream channels.',
			'test connection: success names the modem and its channels (a password full of quoting characters)');
		await F.locator('#mhgl-f-password').fill('not the password');
		eq(await test(), 'The modem refused the user name or password.', 'test connection: a wrong password is reported as refused');
		await F.locator('#mhgl-f-host').fill('modem:9');
		ok(/did not answer at this address/.test(await test()), 'test connection: nothing at the address is reported as not answering');
		eq(router('ls /etc/modemhealth/readings | wc -l; ls /var/run/modemhealth/ 2>/dev/null | grep -c -e session -e test-input; true').trim().split(/\s+/), [ '4', '0' ],
			'test connection: stores nothing, keeps no session and leaves no input file');
		await page.screenshot({ path: path.join(SHOTS, 'settings-test.png'), fullPage: true });

		var save = async function() {
			await F.locator('button:has-text("Save")').click();
			await frame().waitForFunction(function() {
				var e = document.querySelector('.mhgl-saved');
				return e && e.textContent && e.textContent !== 'Saving…';
			}, null, { timeout: 60000 });
			return F.locator('.mhgl-saved').textContent();
		};
		await F.locator('#mhgl-f-host').fill('not a host');
		eq(await save(), 'Please correct the highlighted setting.', 'save: an address with a space is refused in the form');
		eq(router('uci get modemhealth.main.host').trim(), '192.168.100.1', 'save: and nothing is stored');

		await F.locator('#mhgl-f-host').fill('modem:' + MODEM_PORT);
		await F.locator('#mhgl-f-password').fill(PASSWORD);
		await F.locator('#mhgl-f-interval').selectOption('10');
		ok(/^Saved, with the new password/.test(await save()), 'save: says the settings and the new password were saved');
		var cfg = router('uci get modemhealth.main.host; uci get modemhealth.main.interval; uci get modemhealth_auth.main.password; ls -l /etc/config/modemhealth_auth | cut -c1-10; uci show modemhealth | grep -ci password; true').split('\n');
		eq(cfg.slice(0, 5), [ 'modem:' + MODEM_PORT, '10', PASSWORD, '-rw-------', '0' ],
			'save: settings stored; password stored exactly, in the root-only file, not with the other settings');
		eq([ await val('password'), await F.locator('#mhgl-f-password').getAttribute('placeholder') ], [ '', '(saved)' ],
			'save: the password field is emptied and only says one is saved');
		await F.locator('.mhgl-nav button[data-page=settings]').click();
		await F.locator('#mhgl-f-host').waitFor();
		eq([ await val('host'), await val('interval'), await val('password') ], [ 'modem:' + MODEM_PORT, '10', '' ],
			'settings: opened again, the saved settings are shown and no password is sent back');
		eq(await test(), 'Connected: S34, firmware AT01.01.010.042324_S3.04.735, 34 downstream and 5 upstream channels.',
			'test connection: with the field empty, the saved password is used');

		/* health limits */
		var limit = function(k) { return F.locator('#mhgl-f-' + k); };
		await F.locator('summary:has-text("Signal levels")').click();
		eq([ await limit('us_power_4_good_max').inputValue(), await limit('us_power_4_good_max').getAttribute('placeholder') ], [ '', '48' ],
			'limits: empty fields showing the defaults');
		ok(/Source: CableLabs, DOCSIS 3\.0 Physical Layer Specification/.test(await F.locator('#mhgl-view').innerText()), 'limits: each default names its source');
		await limit('us_power_4_good_max').fill('60');
		eq(await save(), 'Please correct the highlighted setting.', 'limits: a good range beyond the acceptable range is refused');
		ok(/must lie within the acceptable range/.test(await F.locator('#mhgl-view').innerText()), 'limits: and the form says why');
		await limit('us_power_4_good_max').fill('51');
		ok(/^Saved\./.test(await save()), 'limits: a valid change is saved');
		eq(router('uci get modemhealth.limits.us_power_4_good_max; uci show modemhealth.limits | grep -c =; true').trim().split('\n'), [ '51', '2' ],
			'limits: only the changed bound is stored');
		await page.screenshot({ path: path.join(SHOTS, 'settings.png'), fullPage: true });

		/* ----------------------------------------------------------- Overview */
		var summary = function() { return frame().evaluate(rig.overviewSummary); };
		var openOverview = async function() {
			await F.locator('.mhgl-nav button[data-page=overview]').click();
			await F.locator('svg.mh-chart').first().waitFor({ timeout: 60000 });
		};
		await openOverview();
		var s = await summary();
		await sleep(300);
		await page.screenshot({ path: path.join(SHOTS, 'overview-24h.png'), fullPage: true });
		var dayReadings = rig.lines(made, 'readings').filter(function(l) { return +l.split(',')[0] >= now - 86400; });
		ok(Math.abs(s.counts[0] - dayReadings.length) <= 1 && s.counts[1] === 4,
			'overview: the last 24 hours hold %d checks, 4 failed (page: %s)'.replace('%d', dayReadings.length).replace('%s', s.counts.join(', ')));
		eq([ s.badges.length, s.badges[1] ], [ 2, 'Failing' ], 'overview: a verdict now and for the period; the period is failing');
		ok(/outage\(s\) with no internet/.test(s.text) && /loss\(es\) of downstream sync/.test(s.text), 'overview: the reasons are given in words');
		eq([ s.ds, s.us, s.charts ], [ 34, 5, 4 ], 'overview: 34 downstream and 5 upstream channels, four charts');
		ok(s.segments >= 3 && s.outageSpans === 1 && s.restartMarks === 1, 'charts: the line breaks at the outage and the failed check, the outage is shaded, the restart marked');
		ok(/limits you changed in Settings: Upstream power \(SC-QAM, 4 channels\)\./.test(s.notice), 'overview: says which limit was changed');
		ok(!/needs your modem's password/.test(s.text), 'overview: no longer asks for the password');
		ok(s.text.indexOf(gen.HOSTILE[0]) >= 0 && s.text.indexOf(gen.HOSTILE[1]) >= 0 && s.text.indexOf(gen.HOSTILE[2]) >= 0,
			'markup: a message, a level and a model name containing HTML are shown as text');
		eq([ s.xss[0] == null, s.xss[1] ], [ true, 0 ], 'markup: none of it became an element or ran');
		var sizes = await page.evaluate(function() {
			var f = document.querySelector('iframe'), d = f.contentDocument;
			return [ f.offsetHeight, d.getElementById('mhgl-app').offsetHeight, d.documentElement.scrollHeight ];
		});
		ok(sizes[0] > 2000 && sizes[0] >= sizes[1] && sizes[2] <= sizes[0] + 1, 'panel: the frame grows to fit the page, with no scroll bar of its own (' + sizes.join(', ') + ')');

		await F.locator('select.cbi-input-select').selectOption('7');
		await frame().waitForFunction(function() { return /Last 7 days/.test(document.querySelector('.mh-summary').textContent); }, null, { timeout: 60000 });
		var w = await summary();
		eq(w.counts, [ made.counts.readings, made.counts.failed ], 'overview, 7 days: every stored check, loaded in pieces');
		ok(w.segments >= 5 && w.dots >= 1, 'charts, 7 days: the two hours without checks are a gap, the lone check in it a dot');

		var dl = (await Promise.all([ page.waitForEvent('download'), F.locator('button:has-text("Channels")').click() ]))[0];
		var file = path.join(out, dl.suggestedFilename());
		await dl.saveAs(file);
		eq(fs.readFileSync(file, 'utf8').split('\r\n').filter(Boolean).length, 1 + (made.counts.readings - made.counts.failed) * 39,
			'csv: downloads from inside the frame, with every channel row of the period');

		/* Check now */
		var before = modemControl('state');
		var shown = (/Last check: [^.]*/.exec(w.text) || [ '' ])[0];
		await F.locator('button:has-text("Check now")').click();
		await frame().waitForFunction(function(old) {
			var m = /Last check: [^.]*/.exec((document.querySelector('.mh-summary') || {}).textContent || '');
			return m && m[0] !== old;
		}, shown, { timeout: 90000 });
		var last = router('modemhealth last').trim().split(','), after = modemControl('state');
		ok(last[1] === 'ok' && Math.abs(+last[0] - Date.now() / 1000) < 120, 'check now: a new good reading from the modem is stored and shown');
		eq([ after.status_reads - before.status_reads, after.bad_signatures, after.login_failures ], [ 1, 0, 1 ],
			'check now: one read of the modem; every request signed correctly; the only refused login was the wrong-password test');

		/* the panel's dark colours */
		await page.goto(rig.WEB + '/gl-panel.html?theme=dark');
		await F.locator('svg.mh-chart').first().waitFor({ timeout: 60000 });
		eq(await frame().evaluate(function() {
			return [ document.documentElement.getAttribute('data-theme'), getComputedStyle(document.documentElement).getPropertyValue('--background-card').trim() ];
		}), [ 'dark', '#1e1e2a' ], 'panel: its dark colours are taken over');
		await sleep(300);
		await page.screenshot({ path: path.join(SHOTS, 'overview-dark.png') });

		/* ----------------------------------------------------- the panel's rules */
		var calls = await page.evaluate(function() { return window.$requestLog.map(function(c) { return c.params[1] + '.' + c.params[2]; }); });
		ok(calls.length > 2 && calls.every(function(c) { return /^modemhealth\.(get_status|get_data|get_config|check|test|set_config|set_password)$/.test(c); }),
			'panel: only the module\'s own methods are called (' + calls.filter(function(c, i) { return calls.indexOf(c) === i; }).join(', ') + ')');
		var rpc = function(method, args) {
			return page.evaluate(function(a) { return window.$request('call', [ '', 'modemhealth', a[0], a[1] ]).then(function(x) { return x; }, function(e) { return { refused: e }; }); }, [ method, args ]);
		};
		var res = await rpc('get_data', { since: '1; reboot' });
		eq([ res.refused && res.refused.type ], [ 'invalidParams' ], 'panel: text where a number belongs is refused by the panel\'s own check');
		res = await rpc('set_config', { values: { host: '-o/tmp/x' } });
		eq([ res.refused && res.refused.type, res.refused && res.refused.field ], [ 'api', 'host' ], 'panel: a value the module refuses comes back naming the setting');
		res = await rpc('get_config', {});
		ok(res.config && res.config.host === 'modem:' + MODEM_PORT && JSON.stringify(res).indexOf('Pa ss') < 0, 'panel: get_config has the settings and not the password');

		/* ------------------------------------------------------------ secrecy */
		var seen = (await Promise.all(r.replies)).join('\n');
		ok(r.replies.length > 15 && seen.indexOf('Pa ss') < 0, 'secrecy: the modem password is in none of the %d replies the browser received'.replace('%d', r.replies.length));
		var spawned = router('cat /tmp/gl-rpc-spawn.log');
		ok(spawned.split('\n').length > 10 && spawned.indexOf('Pa ss') < 0 && /modemhealth test \/var\/run\/modemhealth\/test-input\./.test(spawned),
			'secrecy: nor on the command line of any of the %d commands the module ran'.replace('%d', spawned.split('\n').length - 1));
		ok(router('cat /etc/modemhealth/readings/* /etc/modemhealth/events/* /etc/modemhealth/modem.txt 2>/dev/null; logread 2>/dev/null; ls /var/run/modemhealth; true').indexOf('Pa ss') < 0,
			'secrecy: nor in the stored files or the system log');
		eq(r.problems, [], 'no script errors on any page');
	} finally {
		await r.stop();
	}
}

main().catch(rig.failed).then(function() { rig.finish(SHOTS); });
