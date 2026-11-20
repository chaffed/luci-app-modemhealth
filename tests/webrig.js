/*
 * What the browser tests share (tests/luci.test.js, tests/gl.test.js):
 * OpenWrt 23.05 with LuCI in a container, the package's files, a generated
 * history (tests/gen.js, with markup in it), the fake modem, and Chrome.
 *
 * Needs docker, python3, Google Chrome and playwright-core:
 *   npm install --no-save playwright-core
 * MH_CHROME=/path/to/chrome picks another Chromium-based browser;
 * MH_KEEP=1 leaves the container running (http://127.0.0.1:18480, root /
 * luci-test) to look at the pages by hand.
 */
var fs = require('fs'), path = require('path'), cp = require('child_process'), http = require('http');
var gen = require('./gen.js');

var ROOT = path.join(__dirname, '..');
var IMAGE = 'modemhealth-test-luci', NAME = 'modemhealth-test-luci';
var MODEM_PORT = 18443, WEB_PORT = 18480;

exports.ROOT = ROOT;
exports.MODEM_PORT = MODEM_PORT;
exports.WEB = 'http://127.0.0.1:' + WEB_PORT;
exports.ROOT_PW = 'luci-test';
/* Characters that break naive quoting in shell, JSON, UCI and HTML. */
exports.PASSWORD = 'Pa ss,w"o\'r$d\\`1<b>';
exports.gen = gen;

var playwright;
try { playwright = require(process.env.PLAYWRIGHT_CORE || 'playwright-core'); }
catch (e) {
	console.error('playwright-core is not installed. Run: npm install --no-save playwright-core');
	process.exit(2);
}

var fail = 0;
exports.ok = function(cond, name) { if (!cond) fail++; console.log((cond ? 'ok   ' : 'FAIL ') + name); return cond; };
exports.eq = function(got, want, name) {
	var g = JSON.stringify(got), w = JSON.stringify(want);
	return exports.ok(g === w, name + (g === w ? '' : ' (got ' + g + ', expected ' + w + ')'));
};
exports.sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

function docker(args, input) {
	return cp.execFileSync('docker', args, { input: input, encoding: 'utf8', stdio: [ 'pipe', 'pipe', 'pipe' ] });
}
/* Run a shell script on the test router. */
exports.router = function(script) { return docker([ 'exec', '-i', NAME, 'sh', '-s' ], script); };
exports.modemControl = function(what) {
	return JSON.parse(cp.execFileSync('curl', [ '-sk', 'https://127.0.0.1:' + MODEM_PORT + '/_control/' + what ], { encoding: 'utf8' }));
};
function get(url) {
	return new Promise(function(resolve, reject) {
		http.get(url, function(res) { res.resume(); resolve(res.statusCode); }).on('error', reject);
	});
}

/* start({ setup: [ extra shell lines ], days, gen: options for gen.make
 * (default: three days, with markup in them) }) -> {
 *   now, made (what gen.make returned), out (folder shared with the router as /out),
 *   browser, page, replies (promises of every reply from the router),
 *   problems (script errors, once watch() was called), watch(), stop()
 * } */
exports.start = async function(opts) {
	opts = opts || {};
	fs.mkdirSync(path.join(ROOT, '.test-out'), { recursive: true });
	var rig = { out: fs.mkdtempSync(path.join(ROOT, '.test-out', 'web-run-')), problems: [], replies: [] };
	rig.stop = async function() {
		if (rig.browser) await rig.browser.close();
		if (rig.modem) rig.modem.kill();
		/* What the router wrote to the shared folder is root's there (on
		 * Linux): let it remove that itself. */
		try { exports.router('rm -rf /out/* 2>/dev/null; true'); } catch (e) { /* not running */ }
		if (process.env.MH_KEEP) console.log('container left running: ' + exports.WEB + ' (LuCI: root / ' + exports.ROOT_PW + '); remove with: docker rm -f ' + NAME);
		else { try { docker([ 'rm', '-f', NAME ]); } catch (e) { /* gone */ } }
		try { fs.rmSync(rig.out, { recursive: true, force: true }); } catch (e) { console.log('left behind: ' + rig.out + ' (' + e.code + ')'); }
	};
	try {
		docker([ 'build', '-q', '--platform', 'linux/amd64', '-t', IMAGE, path.join(ROOT, 'tests', 'openwrt-luci') ]);
		rig.modem = cp.spawn('python3', [ path.join(ROOT, 'tests', 'fake_modem.py'), '--port', String(MODEM_PORT), '--password', exports.PASSWORD ], { stdio: 'ignore' });
		try { docker([ 'rm', '-f', NAME ]); } catch (e) { /* not running */ }
		docker([ 'run', '-d', '--platform', 'linux/amd64', '--name', NAME, '--hostname', 'OpenWrt', '-p', '127.0.0.1:' + WEB_PORT + ':80',
			'--add-host', 'modem:host-gateway', '-v', path.join(ROOT, 'luci-app-modemhealth') + ':/pkg:ro',
			'-v', path.join(ROOT, 'tests') + ':/tests:ro', '-v', rig.out + ':/out', IMAGE, '/sbin/init' ]);

		rig.now = Math.floor(Date.now() / 1000);
		rig.made = gen.make(rig.now, opts.days || 3, opts.gen || { hostile: true });
		gen.write(path.join(rig.out, 'seed'), rig.made);

		for (var i = 0; i < 100; i++) {
			try { if (await get(exports.WEB + '/cgi-bin/luci/')) break; } catch (e) { /* not up yet */ }
			await exports.sleep(300);
		}
		exports.router([
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
			/* What the ntp hotplug leaves once the clock is set: without it
			 * the scheduler waits until the machine has been up ten minutes. */
			'mkdir -p /var/state && touch /var/state/dnsmasqsec',
			'sh /etc/uci-defaults/80_modemhealth',
			'printf "%s\\n%s\\n" ' + exports.ROOT_PW + ' ' + exports.ROOT_PW + ' | passwd root >/dev/null 2>&1'
		].concat(opts.setup || []).join('\n'));
		exports.modemControl('reset');

		rig.browser = await playwright.chromium.launch(process.env.MH_CHROME ? { executablePath: process.env.MH_CHROME } : { channel: 'chrome' });
		var ctx = await rig.browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
		rig.page = await ctx.newPage();
		rig.page.on('response', function(res) {
			if (!/\/(cgi-bin|ubus)/.test(res.url())) return;
			/* A reply cut off by leaving the page may never finish: do not wait for it. */
			rig.replies.push(Promise.race([
				res.text().then(function(t) { return res.url() + '\n' + t; }, function() { return ''; }),
				exports.sleep(20000).then(function() { return ''; })
			]));
		});
		/* Script errors count from here on (LuCI's login page answers 403). */
		rig.watch = function() {
			rig.page.on('pageerror', function(e) { rig.problems.push('page error: ' + e.message); });
			rig.page.on('console', function(m) { if (m.type() === 'error') rig.problems.push('console: ' + m.text()); });
		};
		return rig;
	} catch (e) {
		await rig.stop();
		throw e;
	}
};

/* ISPy on the test router: its settings (the advertised speeds) and its
 * results file, which is the generated one (made.ispy) plus a test whose
 * server name and message hold markup. ispy(rig, false) takes ISPy away
 * again; ispy(rig, 'plain') leaves the markup out (for screenshots).
 * -> what a page should count for a period that holds every test:
 * { tests, failed, slow } (slow by ISPy's rule, from the file itself). */
exports.ispy = function(rig, on) {
	if (on === false)
		return exports.router('rm -rf /etc/ispy /etc/config/ispy');
	var sp = rig.made.ispy;
	var hostile = [ rig.now - 5400, 'cloudflare', gen.HOSTILE[0], 12.1, 0.5, '0.0', 30.2, 41.7, '951.20', '39.10', 1521920000, 'ok',
		'<script>window.__xss=5</script>', '953.00', '39.20', 0.31, 0.05, 41, 23, 2500, 'eth0' ].join(',');
	var text = sp.results + (on === 'plain' ? '' : hostile + '\n');
	fs.writeFileSync(path.join(rig.out, 'ispy-results.csv'), text);
	exports.router([ 'set -e', 'mkdir -p /etc/ispy', 'cp /out/ispy-results.csv /etc/ispy/results.csv', 'touch /etc/config/ispy',
		'uci set ispy.main=ispy', 'uci set ispy.main.plan_down=' + sp.plan_down, 'uci set ispy.main.plan_up=' + sp.plan_up, 'uci commit ispy' ].join('\n'));
	var rows = text.split('\n').slice(1).filter(Boolean).map(function(l) { return l.split(','); }).filter(function(f) { return f[11] !== 'skipped'; });
	return {
		tests: rows.length,
		failed: rows.filter(function(f) { return f[11] !== 'ok'; }).length,
		slow: rows.filter(function(f) { return f[11] === 'ok' && (Math.max(+f[8], +f[13]) < 0.8 * sp.plan_down || Math.max(+f[9], +f[14]) < 0.8 * sp.plan_up); }).length
	};
};

/* The Overview's speed tests, read from the page (or the panel's frame):
 * null when the page says nothing about speed. */
exports.speedSummary = function() {
	var box = document.getElementById('mh-speed');
	if (!box) return null;
	var svg = box.querySelector('svg.mh-chart'), titles = function(sel, re) {
		return Array.prototype.filter.call(svg.querySelectorAll(sel + ' title'), function(t) { return re.test(t.textContent); }).length;
	};
	var items = Array.prototype.map.call(box.querySelectorAll('li'), function(li) { return li.textContent; });
	var m = /^(\d+) speed tests by ISPy in this period, of which (\d+) did not complete\./.exec(items[0] || '') || [];
	var sl = /^Slow \(download or upload below 80% of the advertised speed\): (\d+) tests?, (\d+) of them within (\d+) minutes of a line problem the modem recorded\./.exec(items[1] || '') || [];
	var fine = /^Not slow: (\d+) tests?, (\d+) of them within \d+ minutes of a line problem\./.exec(items[2] || '') || [];
	return {
		text: box.innerText, items: items,
		/* minutes: the window, which is the time between two checks as set now */
		tests: +m[1], failed: +m[2], slow: +sl[1], slowInProblem: +sl[2], minutes: +sl[3], fine: +fine[1], fineInProblem: +fine[2],
		dots: svg.querySelectorAll('circle').length, lines: svg.querySelectorAll('path').length,
		failedMarks: titles('line', /speed test did not complete/), outageSpans: titles('rect', /^Outage/), eventMarks: titles('line', /SYNC|T3|T4|Modem restarted/),
		charts: document.querySelectorAll('svg.mh-chart').length,
		xss: [ window.__xss, box.querySelectorAll('img, script, b').length ]
	};
};

/* Every data line of the generated history of one kind (readings, ...). */
exports.lines = function(made, kind) {
	return Object.keys(made.files).filter(function(n) { return n.indexOf(kind + '/') === 0; })
		.map(function(n) { return made.files[n].split('\n').slice(1).filter(Boolean); })
		.reduce(function(a, b) { return a.concat(b); }, []);
};

/* What the Overview shows, read from the page (or the panel's frame). */
exports.overviewSummary = function() {
	var sec = function(title) {
		return Array.prototype.filter.call(document.querySelectorAll('h3'), function(h) { return h.textContent === title; })[0].parentNode;
	};
	var root = document.getElementById('view') || document.getElementById('mhgl-view');
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
		text: root.innerText,
		xss: [ window.__xss, root.querySelectorAll('img, script, b[onmouseover]').length ]
	};
};

exports.finish = function(shots) {
	console.log(fail ? '\n' + fail + ' check(s) failed' : '\nall checks passed');
	if (shots) console.log('screenshots: ' + shots);
	process.exit(fail ? 1 : 0);
};
exports.failed = function(e) { fail++; console.log('FAIL ' + (e && e.stack || e)); };
