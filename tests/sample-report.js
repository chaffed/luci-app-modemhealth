/*
 * Builds the sample report in docs/ (sample-report.pdf) from a
 * generated two-week history of a line with faults, on a router that also
 * runs ISPy: the report exactly as the Report page makes it, printed by
 * Chrome. Also the two pictures of it the README shows (report.png: its
 * first page; report-speed.png: the speed tests against the line).
 *
 *   npm install --no-save playwright-core
 *   node tests/sample-report.js [OUTDIR]     (default: docs)
 */
/* One time zone wherever this runs (the generator's evening is the US west
 * coast's), so that the sample only changes when the report does. */
process.env.TZ = 'America/Los_Angeles';
var fs = require('fs'), path = require('path');
var gen = require('./gen.js');
var ROOT = path.join(__dirname, '..');
var RES = path.join(ROOT, 'luci-app-modemhealth/htdocs/luci-static/resources');
var out = path.resolve(process.argv[2] || path.join(ROOT, 'docs'));
var VERSION = /^PKG_VERSION:=(\S+)/m.exec(fs.readFileSync(path.join(ROOT, 'luci-app-modemhealth/Makefile'), 'utf8'))[1];

String.prototype.format = function() {
	var a = arguments, i = 0;
	return this.replace(/%(0?)(\d*)(?:\.(\d+))?([sdf%])/g, function(m, z, w, p, c) {
		if (c === '%') return '%';
		var v = a[i++];
		if (c === 'd') v = Math.floor(+v || 0).toFixed(0); else if (c === 'f') v = (+v).toFixed(p ? +p : 6); else v = String(v);
		if (w) while (v.length < +w) v = (z ? '0' : ' ') + v;
		return v;
	});
};
global._ = function(s) { return s; };

var baseclass = { extend: function(o) { return o; } };
var read = function(f) { return fs.readFileSync(path.join(RES, f), 'utf8'); };
var health = new Function('baseclass', read('modemhealth/health.js'))(baseclass);

/* A fixed moment, so the sample only changes when the report does. */
var NOW = Math.floor(new Date(2026, 10, 19, 18, 0, 0).getTime() / 1000);
var made = gen.make(NOW, 14, {});
var all = {};
[ [ 'readings', gen.READINGS ], [ 'channels', gen.CHANNELS ], [ 'events', gen.EVENTS ] ].forEach(function(k) {
	all[k[0]] = k[1] + '\n' + Object.keys(made.files).filter(function(n) { return n.indexOf(k[0] + '/') === 0; }).sort()
		.map(function(n) { return made.files[n].split('\n').slice(1).filter(Boolean).join('\n'); }).filter(Boolean).join('\n') + '\n';
});
var rpc = { declare: function() { return function(since, until) {
	var cut = function(t) {
		var l = t.split('\n').filter(Boolean);
		return [ l[0] ].concat(l.slice(1).filter(function(r) { var ts = +r.split(',')[0]; return ts >= since && ts <= until; })).join('\n') + '\n';
	};
	/* ISPy's speed tests of the same days, as the backend passes them on. */
	var tests = made.ispy.results.split('\n').slice(1).filter(Boolean).map(function(l) { return l.split(','); })
		.filter(function(f) { return f[11] !== 'skipped'; }).map(function(f) { return [ f[0], f[11], f[8], f[9], f[13], f[14] ].join(','); });
	return Promise.resolve({ readings: cut(all.readings), channels: cut(all.channels), events: cut(all.events), channelmap: made.files['channelmap.csv'],
		speed: { plan_down: String(made.ispy.plan_down), plan_up: String(made.ispy.plan_up), tests: cut('ts,status,down_mbps,up_mbps,wan_down_mbps,wan_up_mbps\n' + tests.join('\n') + '\n') } });
}; } };
var mh = new Function('baseclass', 'rpc', 'health', read('modemhealth/common.js'))(baseclass, rpc, health);
var rb = new Function('baseclass', 'mh', read('modemhealth/report.js'))(baseclass, mh);

mh.loadDigest(NOW - 14 * 86400, NOW, 5).then(async function(G) {
	var html = rb.build(G, {
		modem: { model: 'S34', firmware: 'AT01.01.010.042324_S3.04.735', mac: '00:00:5E:00:53:01', docsis: 'DOCSIS 3.1' },
		sub: { isp: 'Example Cable', subscriber: 'Alex Example', account: '0000 00 000 0000000', address: '100 Example Street, Springfield' },
		notes: 'The connection has dropped several times a day since early November. I reported it by phone on 12 November (ticket 000000) and was told the line tested fine.\n\nThis is a sample report made from generated data.',
		interval: 5, ping_host: '1.1.1.1', generated: NOW, version: VERSION
	}).page();
	fs.mkdirSync(out, { recursive: true });
	var playwright = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
	var browser = await playwright.chromium.launch(process.env.MH_CHROME ? { executablePath: process.env.MH_CHROME } : { channel: 'chrome' });
	var page = await (await browser.newContext({ viewport: { width: 1000, height: 1200 } })).newPage();
	await page.setContent(html);
	await page.pdf({ path: path.join(out, 'sample-report.pdf'), format: 'Letter', printBackground: true });
	await page.screenshot({ path: path.join(out, 'report.png'), clip: { x: 0, y: 0, width: 1000, height: 1160 } });
	var speed = await page.locator('h2', { hasText: 'Speed tests and line problems' }).boundingBox();
	var slow = await page.locator('h3', { hasText: 'The slow tests' }).boundingBox();
	await page.screenshot({ path: path.join(out, 'report-speed.png'), fullPage: true, clip: { x: 0, y: speed.y - 12, width: 1000, height: slow.y - speed.y } });
	/* MH_EXTRA=1 also leaves the HTML and a picture of all of it, to look at. */
	if (process.env.MH_EXTRA) {
		await page.screenshot({ path: path.join(out, 'report-full.png'), fullPage: true });
		fs.writeFileSync(path.join(out, 'sample-report.html'), html);
	}
	await browser.close();
	console.log('%d KB of HTML -> %s', Math.round(html.length / 1024), path.join(out, 'sample-report.pdf'));
}).catch(function(e) { console.error(e); process.exit(1); });
