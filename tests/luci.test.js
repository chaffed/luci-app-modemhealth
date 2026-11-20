/*
 * The web interface in a real LuCI, driven by a real browser.
 *
 * Starts OpenWrt 23.05 with LuCI in a container, installs the package's
 * files, a generated history (tests/gen.js, with markup in it) and the fake
 * modem, logs in as root and uses the Settings and Overview pages the way
 * their owner would. Screenshots are left in .test-out/luci/.
 *
 * Needs docker, python3, Google Chrome and playwright-core:
 *   npm install --no-save playwright-core
 *   node tests/luci.test.js
 * MH_CHROME=/path/to/chrome picks another Chromium-based browser;
 * MH_KEEP=1 leaves the container running (http://127.0.0.1:18480, root /
 * luci-test) to look at the pages by hand.
 */
var fs = require('fs'), path = require('path'), cp = require('child_process'), http = require('http');
var gen = require('./gen.js');

var ROOT = path.join(__dirname, '..');
var IMAGE = 'modemhealth-test-luci', NAME = 'modemhealth-test-luci';
var MODEM_PORT = 18443, LUCI_PORT = 18480, LUCI = 'http://127.0.0.1:' + LUCI_PORT;
var ROOT_PW = 'luci-test';
/* Characters that break naive quoting in shell, JSON, UCI and HTML. */
var PASSWORD = 'Pa ss,w"o\'r$d\\`1<b>';
var SHOTS = path.join(ROOT, '.test-out', 'luci');

var playwright;
try { playwright = require(process.env.PLAYWRIGHT_CORE || 'playwright-core'); }
catch (e) {
	console.error('playwright-core is not installed. Run: npm install --no-save playwright-core');
	process.exit(2);
}

var fail = 0;
function ok(cond, name) { if (!cond) fail++; console.log((cond ? 'ok   ' : 'FAIL ') + name); return cond; }
function eq(got, want, name) {
	var g = JSON.stringify(got), w = JSON.stringify(want);
	return ok(g === w, name + (g === w ? '' : ' (got ' + g + ', expected ' + w + ')'));
}
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
function docker(args, input) {
	return cp.execFileSync('docker', args, { input: input, encoding: 'utf8', stdio: [ 'pipe', 'pipe', 'pipe' ] });
}
function router(script) { return docker([ 'exec', '-i', NAME, 'sh', '-s' ], script); }
function get(url) {
	return new Promise(function(resolve, reject) {
		http.get(url, function(res) { res.resume(); resolve(res.statusCode); }).on('error', reject);
	});
}
function modemControl(what) {
	return JSON.parse(cp.execFileSync('curl', [ '-sk', 'https://127.0.0.1:' + MODEM_PORT + '/_control/' + what ], { encoding: 'utf8' }));
}

async function main() {
	fs.mkdirSync(SHOTS, { recursive: true });
	var out = fs.mkdtempSync(path.join(ROOT, '.test-out', 'luci-run-'));
	var modem, browser;
	try {
		docker([ 'build', '-q', '--platform', 'linux/amd64', '-t', IMAGE, path.join(ROOT, 'tests', 'openwrt-luci') ]);
		modem = cp.spawn('python3', [ path.join(ROOT, 'tests', 'fake_modem.py'), '--port', String(MODEM_PORT), '--password', PASSWORD ], { stdio: 'ignore' });
		try { docker([ 'rm', '-f', NAME ]); } catch (e) { /* not running */ }
		docker([ 'run', '-d', '--platform', 'linux/amd64', '--name', NAME, '-p', '127.0.0.1:' + LUCI_PORT + ':80',
			'--add-host', 'modem:host-gateway', '-v', path.join(ROOT, 'luci-app-modemhealth') + ':/pkg:ro', '-v', out + ':/out', IMAGE, '/sbin/init' ]);

		var now = Math.floor(Date.now() / 1000);
		var made = gen.make(now, 3, { hostile: true });
		gen.write(path.join(out, 'seed'), made);

		for (var i = 0; i < 100; i++) {
			try { if (await get(LUCI + '/cgi-bin/luci/')) break; } catch (e) { /* not up yet */ }
			await sleep(300);
		}
		router([
			'set -e',
			'cp -R /pkg/root/. /',
			'cp -R /pkg/htdocs/. /www/',
			'chmod 755 /usr/bin/modemhealth /usr/libexec/rpcd/luci.modemhealth /etc/init.d/modemhealth',
			'chmod 600 /etc/config/modemhealth /etc/config/modemhealth_auth',
			'uci set modemhealth.main.enabled=0',
			'uci set modemhealth.main.ping_host=modem',
			'uci set modemhealth.main.timeout=5',
			'uci commit modemhealth',
			'mkdir -p /etc/modemhealth && cp -R /out/seed/. /etc/modemhealth/',
			'sh /etc/uci-defaults/80_modemhealth',
			'printf "%s\\n%s\\n" ' + ROOT_PW + ' ' + ROOT_PW + ' | passwd root >/dev/null 2>&1'
		].join('\n'));
		modemControl('reset');

		browser = await playwright.chromium.launch(process.env.MH_CHROME ? { executablePath: process.env.MH_CHROME } : { channel: 'chrome' });
		var ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
		var page = await ctx.newPage();
		var problems = [], replies = [];
		page.on('response', function(res) {
			if (!/\/(cgi-bin|ubus)/.test(res.url())) return;
			replies.push(res.text().then(function(t) { return res.url() + '\n' + t; }, function() { return ''; }));
		});

		/* ------------------------------------------------------------- log in */
		await page.goto(LUCI + '/cgi-bin/luci/admin/services/modemhealth/settings');
		await page.fill('input[name=luci_username]', 'root');
		await page.fill('input[name=luci_password]', ROOT_PW);
		await Promise.all([ page.waitForNavigation(), page.press('input[name=luci_password]', 'Enter') ]);
		/* From here on (the login page itself answers 403). */
		page.on('pageerror', function(e) { problems.push('page error: ' + e.message); });
		page.on('console', function(m) { if (m.type() === 'error') problems.push('console: ' + m.text()); });

		var field = function(name, section) { return '[id="widget.cbid.modemhealth.' + (section || 'main') + '.' + name + '"]'; };
		var openSettings = async function() {
			await page.goto(LUCI + '/cgi-bin/luci/admin/services/modemhealth/settings');
			await page.waitForSelector(field('host'));
		};
		var tab = function(name) { return page.click('ul.cbi-tabmenu li[data-tab="' + name + '"] a'); };
		var test = async function() {
			await page.click('button:has-text("Test connection")');
			await page.waitForFunction(function() {
				var e = document.getElementById('mh-test-result');
				return e && e.textContent && e.textContent !== 'Testing…';
			}, null, { timeout: 60000 });
			return page.textContent('#mh-test-result');
		};
		var apply = async function() {
			await page.click('.cbi-page-actions .cbi-button-apply');
			await page.waitForFunction(function() { return document.body.classList.contains('modal-overlay-active'); }, null, { timeout: 15000 }).catch(function() {});
			await page.waitForFunction(function() { return !document.body.classList.contains('modal-overlay-active'); }, null, { timeout: 60000 });
			await sleep(500);
		};

		/* ----------------------------------------------------------- Settings */
		await page.waitForSelector(field('host'));
		ok(await page.title() !== '' && await page.isVisible('text=Modem Health – Settings'), 'settings: the page opens under Services after logging in');
		eq(await page.inputValue(field('_password')), '', 'settings: the password field starts empty');
		ok(/password you use for the modem/.test(await page.innerText('#view')), 'settings: says no password is saved yet');
		await page.screenshot({ path: path.join(SHOTS, 'settings.png'), fullPage: true });

		await page.fill(field('host'), 'modem:' + MODEM_PORT);
		await page.fill(field('_password'), PASSWORD);
		eq(await test(), 'Connected: S34, firmware AT01.01.010.042324_S3.04.735, 34 downstream and 5 upstream channels.',
			'test connection: success names the modem and its channels');
		await page.fill(field('_password'), 'not the password');
		eq(await test(), 'The modem refused the user name or password.', 'test connection: a wrong password is reported as refused');
		await page.fill(field('host'), 'modem:9');
		ok(/did not answer at this address/.test(await test()), 'test connection: nothing at the address is reported as not answering');
		await page.fill(field('host'), '192.0.2.1');
		/* Most networks swallow packets to 192.0.2.1 (a time-out); some refuse them at once. */
		ok(/Nothing answered at this address in time|did not answer at this address/.test(await test()), 'test connection: an address nothing lives at is reported as not answering');
		await page.screenshot({ path: path.join(SHOTS, 'settings-test.png'), fullPage: true });
		eq(router('ls /etc/modemhealth/readings | wc -l; ls /var/run/modemhealth/session 2>&1 | grep -c "No such"').trim().split(/\s+/), [ '4', '1' ],
			'test connection: stores nothing and keeps no session');

		await page.fill(field('host'), 'modem:' + MODEM_PORT);
		await page.fill(field('_password'), PASSWORD);
		await apply();
		var cfg = router('uci get modemhealth.main.host; uci get modemhealth_auth.main.password; ls -l /etc/config/modemhealth_auth | cut -c1-10; uci show modemhealth | grep -ci password; true').split('\n');
		eq(cfg.slice(0, 4), [ 'modem:' + MODEM_PORT, PASSWORD, '-rw-------', '0' ],
			'save & apply: address saved; password saved exactly, in the root-only file, not with the other settings');

		await openSettings();
		eq([ await page.inputValue(field('_password')), await page.getAttribute(field('_password'), 'placeholder') ], [ '', '(saved)' ],
			'settings: a saved password is never sent back, the field only says one is saved');
		eq(await test(), 'Connected: S34, firmware AT01.01.010.042324_S3.04.735, 34 downstream and 5 upstream channels.',
			'test connection: with the field empty, the saved password is used');

		/* ----------------------------------------------------------- Overview */
		var openOverview = async function() {
			await page.goto(LUCI + '/cgi-bin/luci/admin/services/modemhealth/overview');
			await page.waitForSelector('svg.mh-chart', { timeout: 60000 });
		};
		var summary = function() {
			return page.evaluate(function() {
				var sec = function(title) {
					return Array.prototype.filter.call(document.querySelectorAll('#view h3'), function(h) { return h.textContent === title; })[0].parentNode;
				};
				var charts = document.querySelectorAll('svg.mh-chart'), power = charts[0];
				return {
					badges: Array.prototype.map.call(document.querySelectorAll('.mh-summary .mh-badge'), function(b) { return b.textContent; }),
					counts: (/(\d+) checks, (\d+) failed/.exec(document.querySelector('.mh-summary').textContent) || []).slice(1).map(Number),
					ds: sec('Downstream channels').querySelectorAll('tr.tr:not(.table-titles)').length,
					us: sec('Upstream channels').querySelectorAll('tr.tr:not(.table-titles)').length,
					marked: document.querySelectorAll('td.mh-cell-marginal, td.mh-cell-bad').length,
					outages: sec('Outages').querySelectorAll('li').length,
					restarts: sec('Restarts and re-registrations').textContent,
					charts: charts.length,
					segments: (power.querySelector('path').getAttribute('d').match(/M/g) || []).length,
					dots: power.querySelectorAll('circle').length,
					outageSpans: Array.prototype.filter.call(power.querySelectorAll('rect title'), function(t) { return /^Outage/.test(t.textContent); }).length,
					restartMarks: Array.prototype.filter.call(power.querySelectorAll('line title'), function(t) { return t.textContent === 'Modem restarted'; }).length,
					notice: (document.querySelector('.alert-message.notice') || {}).textContent || '',
					text: document.getElementById('view').innerText,
					xss: [ window.__xss, document.querySelectorAll('#view img, #view script, #view b[onmouseover]').length ]
				};
			});
		};
		await openOverview();
		var s = await summary();
		await page.screenshot({ path: path.join(SHOTS, 'overview-24h.png'), fullPage: true });
		var inDay = function(ts) { return ts >= now - 86400; };
		var lines = function(kind) {
			return Object.keys(made.files).filter(function(n) { return n.indexOf(kind + '/') === 0; })
				.map(function(n) { return made.files[n].split('\n').slice(1).filter(Boolean); })
				.reduce(function(a, b) { return a.concat(b); }, []);
		};
		var dayReadings = lines('readings').filter(function(l) { return inDay(+l.split(',')[0]); });
		ok(Math.abs(s.counts[0] - dayReadings.length) <= 1 && s.counts[1] === 4,
			'overview: the last 24 hours hold %d checks, 4 failed (page: %s)'.replace('%d', dayReadings.length).replace('%s', s.counts.join(', ')));
		eq([ s.badges.length, s.badges[1] ], [ 2, 'Failing' ], 'overview: a verdict now and for the period; the period is failing');
		ok(/Healthy|Degraded|Failing/.test(s.badges[0]), 'overview: the latest check has a verdict (' + s.badges[0] + ')');
		ok(/outage\(s\) with no internet/.test(s.text) && /loss\(es\) of downstream sync/.test(s.text), 'overview: the reasons are given in words');
		eq([ s.ds, s.us ], [ 34, 5 ], 'overview: 34 downstream and 5 upstream channels in the tables');
		ok(s.marked > 0, 'overview: values outside the good range are marked (' + s.marked + ' cells)');
		eq(s.outages, 1, 'overview: the three failed checks and the next without internet are one outage');
		ok(/Modem restarted at/.test(s.restarts) && /Re-registered/.test(s.restarts), 'overview: the restart and the re-registrations are listed');
		eq(s.charts, 4, 'overview: four charts');
		ok(s.segments >= 3 && s.outageSpans === 1 && s.restartMarks === 1,
			'charts: the line breaks at the outage and the failed check (%d pieces), the outage is shaded, the restart marked'.replace('%d', s.segments));
		eq(s.notice, '', 'overview: no note about changed limits while none are changed');
		ok(s.text.indexOf(gen.HOSTILE[0]) >= 0 && s.text.indexOf(gen.HOSTILE[1]) >= 0 && s.text.indexOf(gen.HOSTILE[2]) >= 0,
			'markup: a message, a level and a model name containing HTML are shown as text');
		eq([ s.xss[0] == null, s.xss[1] ], [ true, 0 ], 'markup: none of it became an element or ran');
		ok(/What do these mean\?/.test(s.text), 'overview: the explanations are there');

		/* seven days: everything that is stored, the router-off gap included */
		await page.selectOption('select.cbi-input-select', '7');
		await page.waitForFunction(function() { return /Last 7 days/.test(document.querySelector('.mh-summary').textContent); }, null, { timeout: 60000 });
		await sleep(300);
		var w = await summary();
		await page.screenshot({ path: path.join(SHOTS, 'overview-7d.png'), fullPage: true });
		eq(w.counts, [ made.counts.readings, made.counts.failed ], 'overview, 7 days: every stored check, loaded in pieces');
		ok(w.segments >= 5 && w.dots >= 1, 'charts, 7 days: the two hours without checks are a gap, the lone check in it a dot (%d pieces, %d dots)'.replace('%d', w.segments).replace('%d', w.dots));

		/* CSV export */
		var csv = {};
		for (var k of [ [ 'Checks', 'readings' ], [ 'Channels', 'channels' ], [ 'Events', 'events' ] ]) {
			var dl = (await Promise.all([ page.waitForEvent('download'), page.click('button:has-text("' + k[0] + '")') ]))[0];
			var file = path.join(out, dl.suggestedFilename());
			await dl.saveAs(file);
			csv[k[1]] = { name: dl.suggestedFilename(), rows: fs.readFileSync(file, 'utf8').split('\r\n').filter(Boolean) };
		}
		ok(/^modemhealth-readings-\d{4}-\d\d-\d\d-\d\d-\d\d\.csv$/.test(csv.readings.name), 'csv: file named for what it holds and when (' + csv.readings.name + ')');
		eq([ csv.readings.rows.length, csv.channels.rows.length, csv.events.rows.length ],
			[ 1 + made.counts.readings, 1 + (made.counts.readings - made.counts.failed) * 39, 1 + made.counts.events ],
			'csv: every check, channel row and event of the period');
		ok(/^time,ts,dir,ch,channel_id,modulation,freq_hz/.test(csv.channels.rows[0]) && /,ds,\d+,\d+,256QAM,\d+,/.test(csv.channels.rows[1]),
			'csv: channel rows carry the line-up');
		ok(csv.events.rows.some(function(r) { return r.indexOf(gen.HOSTILE[0]) >= 0; }), 'csv: text is exported as stored');

		/* ------------------------------------------------------ health limits */
		await openSettings();
		var good = field('us_power_4_good_max', 'limits'), acc = field('us_power_4_acceptable_max', 'limits');
		eq([ await page.inputValue(good), await page.getAttribute(good, 'placeholder'), await page.getAttribute(acc, 'placeholder') ], [ '', '48', '51' ],
			'limits: empty fields showing the defaults');
		ok(/Source: CableLabs, DOCSIS 3\.0 Physical Layer Specification/.test(await page.innerText('#view')), 'limits: each default names its source');
		await page.fill(good, '60');
		await page.press(good, 'Tab');
		ok(await page.$eval(good, function(e) { return e.classList.contains('cbi-input-invalid'); }), 'limits: a good range beyond the acceptable range is refused');
		await page.fill(acc, '65');
		await page.press(acc, 'Tab');
		await sleep(200);
		ok(!(await page.$eval(good, function(e) { return e.classList.contains('cbi-input-invalid'); })), 'limits: widening the acceptable range clears the complaint');
		await page.fill(acc, '');
		await page.fill(good, '51');
		await page.press(good, 'Tab');
		await page.screenshot({ path: path.join(SHOTS, 'settings-limits.png'), fullPage: true });
		await apply();
		eq(router('uci get modemhealth.limits.us_power_4_good_max; uci -q get modemhealth.limits.us_power_4_acceptable_max; true').trim(), '51', 'limits: only the changed bound is stored');
		await openOverview();
		s = await summary();
		ok(/limits you changed in Settings: Upstream power \(SC-QAM, 4 channels\)\./.test(s.notice), 'limits: the overview says which limit was changed');
		await page.screenshot({ path: path.join(SHOTS, 'overview-limits.png') });

		/* ---------------------------------------------------------- Check now */
		var before = modemControl('state');
		await Promise.all([ page.waitForNavigation({ timeout: 90000 }), page.click('button:has-text("Check now")') ]);
		await page.waitForSelector('svg.mh-chart', { timeout: 60000 });
		var last = router('modemhealth last').trim().split(','), after = modemControl('state');
		ok(last[1] === 'ok' && Math.abs(+last[0] - Date.now() / 1000) < 120 && last[3] === 'S34', 'check now: a new good reading from the modem is stored');
		eq([ after.status_reads - before.status_reads, after.bad_signatures, after.login_failures ], [ 1, 0, 1 ],
			'check now: one read of the modem; every request signed correctly; the only refused login was the wrong-password test');
		eq(router('wc -l < /etc/modemhealth/events.seen; { gzip -dc /etc/modemhealth/events/*.gz; cat /etc/modemhealth/events/*.csv; } | grep -vc first_seen_ts').trim().split(/\s+/).map(Number),
			[ 87, made.counts.events ], 'check now: the modem\'s log entries already stored are not stored again');
		s = await summary();
		ok(s.text.indexOf('<script>') < 0 && /S34 · DOCSIS 3\.1/.test(s.text), 'check now: the page shows the modem as just read');
		/* The check gzipped the days before today. */
		ok(+router('ls /etc/modemhealth/readings/*.gz | wc -l') >= 2, 'check now: earlier days are now gzipped');
		await page.selectOption('select.cbi-input-select', '7');
		await page.waitForFunction(function() { return /Last 7 days/.test(document.querySelector('.mh-summary').textContent); }, null, { timeout: 60000 });
		eq((await summary()).counts, [ made.counts.readings + 1, made.counts.failed ], 'overview, 7 days: gzipped days are read like plain ones');

		/* ------------------------------------- schedule on, limit back to default */
		await openSettings();
		await page.fill(good, '');
		await tab('schedule');
		await page.check('.cbi-value[data-name="enabled"] input[type=checkbox]');
		await apply();
		eq(router('uci get modemhealth.main.enabled; uci -q get modemhealth.limits.us_power_4_good_max; true').trim(), '1', 'save & apply: schedule on, the emptied limit removed');
		var st = {};
		for (i = 0; i < 40 && !(st.scheduler && st.next_check); i++) {
			await sleep(2000);
			st = JSON.parse(router('modemhealth status'));
		}
		ok(st.scheduler && st.next_check > Date.now() / 1000 - 5, 'save & apply: the scheduler picks the change up and plans the next check (after %d s)'.replace('%d', i * 2));
		await openOverview();
		s = await summary();
		ok(/Next check at \d\d:\d\d\./.test(s.text) && s.notice === '', 'overview: shows when the next check is due; the note about changed limits is gone');

		/* ------------------------------------------------------------ secrecy */
		var seen = (await Promise.all(replies)).join('\n');
		ok(replies.length > 20 && seen.indexOf('Pa ss') < 0,
			'secrecy: the modem password is in none of the %d replies the browser received'.replace('%d', replies.length));
		ok(router('cat /etc/modemhealth/readings/* /etc/modemhealth/events/* /etc/modemhealth/modem.txt; logread 2>/dev/null; true').indexOf('Pa ss') < 0,
			'secrecy: nor in the stored files or the system log');
		eq(problems, [], 'no script errors on any page');
	} finally {
		if (browser) await browser.close();
		if (modem) modem.kill();
		if (process.env.MH_KEEP) console.log('container left running: ' + LUCI + '/cgi-bin/luci (root / ' + ROOT_PW + '); remove with: docker rm -f ' + NAME);
		else { try { docker([ 'rm', '-f', NAME ]); } catch (e) { /* gone */ } }
		fs.rmSync(out, { recursive: true, force: true });
	}
}

main().catch(function(e) { fail++; console.log('FAIL ' + (e.stack || e)); }).then(function() {
	console.log(fail ? '\n' + fail + ' check(s) failed' : '\nall checks passed');
	console.log('screenshots: ' + SHOTS);
	process.exit(fail ? 1 : 0);
});
