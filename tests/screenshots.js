/*
 * The pictures of the Overview in the README (docs/overview.png and
 * docs/overview-charts.png), taken in a real LuCI from a generated history
 * (tests/gen.js): a made-up line with faults on a router that also runs
 * ISPy, read from the fake modem. Nothing in them is anybody's real modem,
 * address or account. The report's pictures come from tests/sample-report.js.
 *
 *   node tests/screenshots.js [OUTDIR]     (default: docs; needs what tests/webrig.js needs)
 */
var fs = require('fs'), path = require('path');
var rig = require('./webrig.js');
var out = path.resolve(process.argv[2] || path.join(rig.ROOT, 'docs'));

async function main() {
	var r = await rig.start({ days: 8, gen: {} });
	try {
		var page = r.page;
		rig.ispy(r, 'plain');
		fs.writeFileSync(path.join(r.out, 'pw'), rig.PASSWORD + '\n');
		rig.router([
			'set -e',
			'uci set modemhealth.main.host=modem:' + rig.MODEM_PORT,
			'uci set modemhealth.main.enabled=1',
			'uci commit modemhealth',
			'modemhealth set-password < /out/pw >/dev/null',
			'uci set modemhealth.main.isp_name="Example Cable"',
			'uci set modemhealth.main.subscriber="Alex Example"',
			'uci commit modemhealth',
			'/etc/init.d/modemhealth enable',
			'/etc/init.d/modemhealth restart'
		].join('\n'));
		/* The scheduler makes a first check of the (fake) modem at once. */
		for (var i = 0; i < 60; i++) {
			var st = JSON.parse(rig.router('modemhealth status'));
			if (st.scheduler && st.next_check && /,ok,/.test(st.last)) break;
			await rig.sleep(2000);
		}

		await page.setViewportSize({ width: 1160, height: 900 });
		await page.goto(rig.WEB + '/cgi-bin/luci/admin/services/modemhealth/overview');
		await page.fill('input[name=luci_username]', 'root');
		await page.fill('input[name=luci_password]', rig.ROOT_PW);
		await Promise.all([ page.waitForNavigation(), page.press('input[name=luci_password]', 'Enter') ]);
		await page.waitForSelector('svg.mh-chart', { timeout: 60000 });
		await page.selectOption('select.cbi-input-select', '7');
		await page.waitForFunction(function() { return /Last 7 days/.test(document.querySelector('.mh-summary').textContent); }, null, { timeout: 60000 });
		await rig.sleep(500);

		var top = function(title) {
			return page.evaluate(function(t) {
				var h = Array.prototype.filter.call(document.querySelectorAll('h3'), function(x) { return x.textContent === t; })[0];
				return h.parentNode.getBoundingClientRect().top + window.scrollY;
			}, title);
		};
		var a = await top('Downstream channels'), b = await top('Downstream power'), c = await top('Modem events');
		/* The top of the page: now, the period, the modem, outages, and the
		 * first rows of the channel table. */
		await page.screenshot({ path: path.join(out, 'overview.png'), fullPage: true, clip: { x: 0, y: 0, width: 1160, height: a + 330 } });
		/* The charts, the speed tests among them. */
		await page.screenshot({ path: path.join(out, 'overview-charts.png'), fullPage: true, clip: { x: 0, y: b - 8, width: 1160, height: c - b } });
		console.log('saved overview.png and overview-charts.png in ' + out);
	} finally {
		await r.stop();
	}
}

main().catch(function(e) { console.error(e); process.exitCode = 1; });
