/*
 * A T-Mobile 5G gateway's pages, in a real LuCI and in the GL.iNet panel's
 * stand-in, driven by a real browser: the Overview and the Report of a
 * generated gateway history (tests/gen.js: makeGateway, with markup in a
 * band and the model name). The history is synthetic (#28): nobody on the
 * project has a gateway. Screenshots are left in .test-out/gateway/.
 *
 * Run: node tests/gateway_pages.test.js (what it needs: see tests/webrig.js).
 */
var fs = require('fs'), path = require('path');
var rig = require('./webrig.js');
var ok = rig.ok, router = rig.router;
var SHOTS = path.join(rig.ROOT, '.test-out', 'gateway');

async function main() {
	fs.mkdirSync(SHOTS, { recursive: true });
	var r = await rig.start({
		make: function(now) { return rig.gen.makeGateway(now, 3, { hostile: true }); },
		setup: [
			'uci set modemhealth.main.modem_type=tmobile',
			'uci set modemhealth.main.host=192.168.12.1',
			'uci commit modemhealth',
			'cp /tests/gl/panel.html /www/gl-panel.html',
			'cp /tests/gl/rpc.lua /www/cgi-bin/gl-rpc && chmod 755 /www/cgi-bin/gl-rpc'
		]
	});
	try {
		var page = r.page;
		await page.goto(rig.WEB + '/cgi-bin/luci/admin/services/modemhealth/overview');
		await page.fill('input[name=luci_username]', 'root');
		await page.fill('input[name=luci_password]', rig.ROOT_PW);
		await Promise.all([ page.waitForNavigation(), page.press('input[name=luci_password]', 'Enter') ]);
		r.watch();

		/* ------------------------------------------------------ LuCI Overview */
		await page.waitForSelector('#mh-radios table', { timeout: 60000 });
		var view = await page.innerText('#view');
		var rows = await page.locator('#mh-radios tr').allInnerTexts();
		ok(rows.length === 3 && /^4G \(LTE\)\s+b66/.test(rows[1]) && /^5G \(NR\)/.test(rows[2]), 'overview: a row for the 4G and the 5G radio, with their band');
		ok(/Gateway\s+TMO-G4AR|T-Mobile 5G gateway/.test(view) && !/Downstream channels|Upstream channels/.test(view), 'overview: names the gateway; no cable channel tables');
		ok(!/needs your modem's password/.test(view), 'overview: a gateway needs no password, so none is asked for');
		ok(/Signal power \(RSRP, dBm\)/.test(view) && /Signal to noise \(SINR, dB\)/.test(view) && await page.locator('svg.mh-chart').count() >= 3,
			'overview: RSRP, SINR and RSRQ charts');
		ok(/neither 3GPP nor T-Mobile publishes grades/.test(view), 'overview: says where the grades come from');
		ok(/Tower change on 5G: 1407755-101 to 1407801-102/.test(view) && /Gateway events/.test(view), 'overview: tower changes in the gateway\'s events');
		ok(/Radios/.test(await page.locator('button:has-text("Radios")').innerText()), 'overview: the radios download as CSV');
		await page.screenshot({ path: path.join(SHOTS, 'overview.png'), fullPage: true });

		/* --------------------------------------------------------- LuCI Report */
		await page.goto(rig.WEB + '/cgi-bin/luci/admin/services/modemhealth/report');
		await page.waitForSelector('#mh-report-frame');
		var RF = page.frameLocator('#mh-report-frame'), rt = '';
		for (var i = 0; i < 120 && !/5G home internet line health report[\s\S]*How this was measured/.test(rt); i++) {
			rt = await RF.locator('body').innerText().catch(function() { return ''; });
			await rig.sleep(500);
		}
		ok(/5G home internet line health report/.test(rt) && /measured at the customer's 5G gateway/.test(rt), 'report: a 5G gateway report');
		ok(/tower changes/.test(rt) && /Teltonika/.test(rt) && !/CableLabs/.test(rt), 'report: tower changes, and Teltonika cited, not DOCSIS');
		await page.screenshot({ path: path.join(SHOTS, 'report.png'), fullPage: true });

		/* ---------------------------------------------- the GL panel stand-in */
		await page.goto(rig.WEB + '/gl-panel.html');
		var F = page.frameLocator('iframe[title="Modem Health"]');
		await F.locator('#mh-radios table').waitFor({ timeout: 60000 });
		var gv = await F.locator('body').innerText();
		ok(/5G \(NR\)/.test(gv) && /Signal power \(RSRP, dBm\)/.test(gv) && !/needs your modem's password/.test(gv),
			'panel: the same Overview, with the radios and their charts, and no password asked for');
		await page.screenshot({ path: path.join(SHOTS, 'panel.png'), fullPage: true });

		ok(await page.evaluate(function() { return window.__xss === undefined; }) &&
			await F.locator('body').evaluate(function() { return window.__xss === undefined; }), 'markup in a band or the model never runs');
		ok(r.problems.length === 0, 'no script errors' + (r.problems.length ? ': ' + r.problems.join(' | ') : ''));
	} catch (e) {
		rig.failed(e);
	} finally {
		await r.stop();
	}
	rig.finish(SHOTS);
}

main();
