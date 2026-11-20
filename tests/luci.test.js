/*
 * The web interface in a real LuCI, driven by a real browser.
 *
 * Starts OpenWrt 23.05 with LuCI in a container, installs the package's
 * files, a generated history (tests/gen.js, with markup in it) and the fake
 * modem, logs in as root and uses the Settings and Overview pages the way
 * their owner would. Screenshots are left in .test-out/luci/.
 *
 * Run: node tests/luci.test.js (what it needs: see tests/webrig.js).
 */
var fs = require('fs'), path = require('path');
var rig = require('./webrig.js');
var gen = rig.gen, ok = rig.ok, eq = rig.eq, sleep = rig.sleep, router = rig.router, modemControl = rig.modemControl;

var ROOT = rig.ROOT, MODEM_PORT = rig.MODEM_PORT, LUCI = rig.WEB, ROOT_PW = rig.ROOT_PW, PASSWORD = rig.PASSWORD;
var SHOTS = path.join(ROOT, '.test-out', 'luci');

async function main() {
	fs.mkdirSync(SHOTS, { recursive: true });
	var r = await rig.start();
	try {
		var page = r.page, problems = r.problems, replies = r.replies, made = r.made, now = r.now, out = r.out, i;

		/* ------------------------------------------------------------- log in */
		await page.goto(LUCI + '/cgi-bin/luci/admin/services/modemhealth/settings');
		await page.fill('input[name=luci_username]', 'root');
		await page.fill('input[name=luci_password]', ROOT_PW);
		await Promise.all([ page.waitForNavigation(), page.press('input[name=luci_password]', 'Enter') ]);
		r.watch();

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
		var summary = function() { return page.evaluate(rig.overviewSummary); };
		await openOverview();
		var s = await summary();
		await page.screenshot({ path: path.join(SHOTS, 'overview-24h.png'), fullPage: true });
		var inDay = function(ts) { return ts >= now - 86400; };
		var lines = function(kind) { return rig.lines(made, kind); };
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

		/* ------------------------------------------------------------- Report */
		await page.goto(LUCI + '/cgi-bin/luci/admin/services/modemhealth/report');
		await page.waitForSelector('#mh-report-frame');
		ok(/Add your name and account number in Settings/.test(await page.innerText('#view')), 'report: asks for the account details while they are missing');
		await openSettings();
		await tab('report');
		await page.fill(field('subscriber'), 'Zoë O\'Brien <b>');
		await page.fill(field('account'), '8155 60 012 3456789');
		await apply();
		eq(router('uci get modemhealth.main.subscriber; uci get modemhealth.main.account').trim().split('\n'), [ 'Zoë O\'Brien <b>', '8155 60 012 3456789' ],
			'settings: the report details are stored as typed');

		var SHOWN = /Cable line health report/;
		var RF = page.frameLocator('#mh-report-frame');
		var reportText = async function(re) {
			for (var k = 0; k < 300; k++) {
				var tx = await RF.locator('body').innerText().catch(function() { return ''; });
				if (SHOWN.test(tx) && (!re || re.test(tx)) && !(await page.locator('#mh-report-status .spinning').count())) return tx;
				await sleep(200);
			}
			throw new Error('the report did not show ' + re);
		};
		await page.goto(LUCI + '/cgi-bin/luci/admin/services/modemhealth/report');
		var rt = await reportText();
		await page.screenshot({ path: path.join(SHOTS, 'report.png'), fullPage: true });
		ok(!/Add your name and account number/.test(await page.innerText('#view')), 'report: no longer asks for the account details');
		ok(/The line had faults in this period\./.test(rt) && /1 outage with no internet connection/.test(rt) && /13 losses of downstream sync/.test(rt),
			'report: the findings of the last 7 days');
		ok(new RegExp('Checks made\\s+' + made.counts.readings + ' checks, one every 5 minutes').test(rt) && /could not read the modem\s+4 \(/.test(rt),
			'report: every stored check counted, the failed ones stated');
		ok(/Preliminary\./.test(rt), 'report: just under three days of history is called preliminary');
		ok(/Subscriber\s+Zoë O'Brien <b>/.test(rt) && /Account number\s+8155 60 012 3456789/.test(rt) && /00:00:5E:00:53:01/.test(rt) && rt.indexOf(gen.HOSTILE[2]) >= 0,
			'report: account details and the modem\'s identity, markup shown as text');
		var inFrame = function(fn, arg) { return page.frames().filter(function(f) { return f.parentFrame() === page.mainFrame(); })[0].evaluate(fn, arg); };
		eq(await inFrame(function() { return [ window.__xss == null, document.querySelectorAll('script, img, b, link').length, document.querySelectorAll('svg.mh-chart').length ]; }),
			[ true, 0, 4 ], 'report: no script, image or outside file in it; four charts');

		await page.fill('#mh-report-notes', 'First reported on 3 March, ticket 12345.');
		await page.press('#mh-report-notes', 'Tab');
		rt = await reportText(/Subscriber's statement/);
		ok(/First reported on 3 March, ticket 12345\./.test(rt), 'report: the subscriber\'s statement is printed in it');
		ok(/Every event, with its time/.test(rt), 'report: lists every event with its time');
		await page.uncheck('#mh-report-times');
		for (i = 0; i < 100 && /Every event, with its time/.test(await reportText()); i++) await sleep(200);
		ok(!/Every event, with its time/.test(await reportText()), 'report: that list can be left out');
		await page.check('#mh-report-times');
		await reportText(/Every event, with its time/);
		await page.selectOption('select[aria-label="Period"]', '1');
		rt = await reportText(/Checks made\s+28\d checks/);
		ok(/Checks made\s+28\d checks/.test(rt), 'report: the period can be changed (last 24 hours)');

		/* the file: the same document, and it stands alone */
		var srcdoc = await page.getAttribute('#mh-report-frame', 'srcdoc');
		var rdl = (await Promise.all([ page.waitForEvent('download'), page.click('button:has-text("Download report (HTML)")') ]))[0];
		var rfile = path.join(SHOTS, 'report.html');
		await rdl.saveAs(rfile);
		ok(/^cable-line-health-report-\d{4}-\d\d-\d\d\.html$/.test(rdl.suggestedFilename()) && fs.readFileSync(rfile, 'utf8') === srcdoc,
			'report file: the download is the document on the page, byte for byte (' + Math.round(srcdoc.length / 1024) + ' KB)');
		var offline = await r.browser.newContext({ offline: true, viewport: { width: 1000, height: 1200 } });
		var opage = await offline.newPage(), requests = [], oproblems = [];
		opage.on('request', function(q) { requests.push(q.url()); });
		opage.on('pageerror', function(e) { oproblems.push(e.message); });
		opage.on('console', function(m) { if (m.type() === 'error') oproblems.push(m.text()); });
		await opage.goto('file://' + rfile);
		var otext = await opage.innerText('body');
		eq([ requests.length, oproblems.length, otext === rt, await opage.locator('svg.mh-chart').count() ], [ 1, 0, true, 4 ],
			'report file: opens without the router or the internet, asks for nothing else, and reads the same as the page');
		var pdf = await opage.pdf({ path: path.join(SHOTS, 'report.pdf'), format: 'Letter', printBackground: true });
		var pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
		ok(pages >= 3 && pages <= 12, 'report file: prints to PDF (%d pages)'.replace('%d', pages));
		await offline.close();
		await inFrame(function() { window.print = function() { window.__printed = (window.__printed || 0) + 1; }; });
		await page.click('button:has-text("Print / save as PDF")');
		eq(await inFrame(function() { return window.__printed; }), 1, 'report: the print button prints the document, not the page around it');

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
		var lastCheck = function() { return (/Last check: [^.]*/.exec(document.querySelector('.mh-summary').textContent) || [ '' ])[0]; };
		var shown = await page.evaluate(lastCheck);
		await page.click('button:has-text("Check now")');
		/* The page redraws itself with the new reading; it does not reload. */
		await page.waitForFunction(function(old) {
			var m = /Last check: [^.]*/.exec((document.querySelector('.mh-summary') || {}).textContent || '');
			return m && m[0] !== old;
		}, shown, { timeout: 90000 });
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
		await r.stop();
	}
}

main().catch(rig.failed).then(function() { rig.finish(SHOTS); });
