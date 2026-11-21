/*
 * Restarts by Modem Health (#39) in a real LuCI and in the GL.iNet panel's
 * stand-in, driven by a real browser: the Restart button (it restarts the
 * fake modem, through rpcd and through the panel's Lua module), the state
 * of automatic restarts, a restart held back by a limit, and a history
 * with restarts Modem Health made (tests/gen.js: opts.restarts) on the
 * Overview and in the Report. Screenshots are left in .test-out/restart/.
 *
 * Run: node tests/restart_pages.test.js (what it needs: see tests/webrig.js).
 */
var fs = require('fs'), path = require('path');
var rig = require('./webrig.js');
var ok = rig.ok;
var SHOTS = path.join(rig.ROOT, '.test-out', 'restart');

async function main() {
	fs.mkdirSync(SHOTS, { recursive: true });
	var r = await rig.start({
		gen: { restarts: true },
		setup: [
			'uci set modemhealth.main.host=modem:' + rig.MODEM_PORT,
			'uci commit modemhealth',
			'cp /tests/gl/panel.html /www/gl-panel.html',
			'cp /tests/gl/rpc.lua /www/cgi-bin/gl-rpc && chmod 755 /www/cgi-bin/gl-rpc'
		]
	});
	try {
		rig.router('modemhealth set-password >/dev/null <<\'MHPW\'\n' + rig.PASSWORD + '\nMHPW\n');
		var page = r.page, T = r.made.times;
		await page.goto(rig.WEB + '/cgi-bin/luci/admin/services/modemhealth/overview');
		await page.fill('input[name=luci_username]', 'root');
		await page.fill('input[name=luci_password]', rig.ROOT_PW);
		await Promise.all([ page.waitForNavigation(), page.press('input[name=luci_password]', 'Enter') ]);
		r.watch();

		/* ------------------------------------------------- LuCI Overview */
		await page.waitForSelector('#mh-restart', { timeout: 60000 });
		var view = await page.innerText('#view');
		ok(/Automatic restarts: off\./.test(view) && /Last restart by Modem Health failed: .* \(unreachable\)/.test(view),
			'overview: automatic restarts are off, and the last attempt (it failed) is shown');
		ok(/Restarted by Modem Health\./.test(view) && /After a restart by Modem Health; not held against the line\./.test(view),
			'overview: the modem restart and the outage Modem Health caused are marked');
		ok(/Modem Health could not restart the modem \(unreachable\)/.test(view) && /Restart by Modem Health/.test(view),
			'overview: the failed attempt is listed, and the events have their own kind');
		await page.screenshot({ path: path.join(SHOTS, 'overview.png'), fullPage: true });

		await page.click('#mh-restart');
		await page.waitForSelector('.modal button.cbi-button-negative');
		ok(/few minutes/.test(await page.innerText('.modal')), 'button: asks first, and says the connection will be down');
		await page.screenshot({ path: path.join(SHOTS, 'confirm.png') });
		await page.click('.modal button:has-text("Cancel")');
		ok(rig.modemControl('state').reboots === 0, 'button: Cancel restarts nothing');
		await page.click('#mh-restart');
		await page.click('.modal button.cbi-button-negative');
		await page.waitForSelector('text=The modem is restarting', { timeout: 60000 });
		ok(rig.modemControl('state').reboots === 1, 'button: restarts the modem (through rpcd)');
		var last = rig.router('tail -n 1 /etc/modemhealth/restarts.csv');
		ok(/,manual,ok,asked for by hand,/.test(last), 'button: recorded as asked for by hand (' + last.trim() + ')');
		await page.waitForFunction(function() { return /Last restart by Modem Health: .* \(by hand\)/.test(document.body.innerText); }, null, { timeout: 30000 });
		ok(true, 'button: the Overview shows the new restart');

		/* Automatic restarts on, and one held back by the daily limit. */
		rig.router([ 'uci set modemhealth.main.restart_auto=1', 'uci commit modemhealth',
			'echo "$(date +%s),down,at most 3 a day,no connection for 12 minutes (no answer from 1.1.1.1)" > /var/run/modemhealth/restart_held' ].join('\n'));
		await page.reload();
		await page.waitForSelector('#mh-restart-held', { timeout: 60000 });
		view = await page.innerText('#view');
		ok(/Automatic restarts: on, after 10 minutes without a connection; at most 1 an hour and 3 a day\./.test(view),
			'overview: automatic restarts on, with their limits');
		ok(/would restart the modem \(no connection for 12 minutes \(no answer from 1\.1\.1\.1\)\), but automatic restarts are limited to at most 3 a day/.test(view)
			&& /the provider has to look at the line/.test(view), 'overview: a restart held back by a limit, and what that means');
		await page.screenshot({ path: path.join(SHOTS, 'held.png'), fullPage: false });

		/* --------------------------------------------------- LuCI Report */
		await page.goto(rig.WEB + '/cgi-bin/luci/admin/services/modemhealth/report');
		await page.waitForSelector('#mh-report-frame');
		var RF = page.frameLocator('#mh-report-frame'), rt = '';
		for (var i = 0; i < 120 && !/Restarts by Modem Health[\s\S]*How this was measured/.test(rt); i++) {
			rt = await RF.locator('body').innerText().catch(function() { return ''; });
			await rig.sleep(500);
		}
		ok(/Modem Health restarted the modem 2 times \(0 automatically, 2 by hand\); 1 more attempt could not be made\./.test(rt),
			'report: counts the restarts Modem Health made, by hand and automatically');
		ok(/Restarts by Modem Health/.test(rt) && /not restarted \(unreachable\)/.test(rt), 'report: lists them, the failed one too');
		await page.screenshot({ path: path.join(SHOTS, 'report.png'), fullPage: true });

		/* ------------------------------------------- the GL panel stand-in */
		await page.goto(rig.WEB + '/gl-panel.html');
		var F = page.frameLocator('iframe[title="Modem Health"]');
		await F.locator('#mh-restart').waitFor({ timeout: 60000 });
		await F.locator('#mh-restart').click();
		await F.locator('.modal button.cbi-button-negative, [role=dialog] button.cbi-button-negative').first().click();
		for (i = 0; i < 60 && rig.modemControl('state').reboots < 2; i++) await rig.sleep(500);
		ok(rig.modemControl('state').reboots === 2, 'panel: the same button restarts the modem (through the Lua module)');
		await page.screenshot({ path: path.join(SHOTS, 'panel.png'), fullPage: true });

		/* A gateway has no button (its restart is not offered yet). */
		rig.router('uci set modemhealth.main.modem_type=tmobile; uci commit modemhealth');
		await page.goto(rig.WEB + '/cgi-bin/luci/admin/services/modemhealth/overview');
		await page.waitForSelector('#mh-restart-state', { timeout: 60000 });
		ok(await page.locator('#mh-restart').count() === 0, 'gateway: no Restart button');

		ok(r.problems.length === 0, 'no script errors' + (r.problems.length ? ': ' + r.problems.join(' | ') : ''));
	} catch (e) {
		rig.failed(e);
	} finally {
		await r.stop();
	}
	rig.finish(SHOTS);
}

main();
