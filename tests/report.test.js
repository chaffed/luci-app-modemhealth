/*
 * The report for the ISP (modemhealth/report.js), built from generated
 * histories (tests/gen.js, which is built around the real S34 capture) and
 * checked statement by statement. Also: a period reduced piece by piece
 * (loadDigest) judges exactly like the same period loaded whole.
 * Run: node tests/report.test.js
 */
var fs = require('fs'), path = require('path');
var gen = require('./gen.js');
var ROOT = path.join(__dirname, '..');
var PKG = path.join(ROOT, 'luci-app-modemhealth');
var RES = path.join(PKG, 'htdocs/luci-static/resources');

/* LuCI's String.prototype.format and _() stand-ins (as in ui.test.js). */
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

var fail = 0;
function ok(cond, name) { if (!cond) fail++; console.log((cond ? 'ok   ' : 'FAIL ') + name); return cond; }
function eq(got, want, name) {
	var g = JSON.stringify(got), w = JSON.stringify(want);
	return ok(g === w, name + (g === w ? '' : ' (got ' + g + ', expected ' + w + ')'));
}

var baseclass = { extend: function(o) { return o; } };
var read = function(f) { return fs.readFileSync(path.join(RES, f), 'utf8'); };
var health = new Function('baseclass', read('modemhealth/health.js'))(baseclass);

/* A router that has one generated history: data(since, until) answers
 * like the backend. */
function router(made) {
	var text = function(kind, header) {
		return header + '\n' + Object.keys(made.files).filter(function(n) { return n.indexOf(kind + '/') === 0; }).sort()
			.map(function(n) { return made.files[n].split('\n').slice(1).filter(Boolean).join('\n'); }).filter(Boolean).join('\n') + '\n';
	};
	var all = { readings: text('readings', gen.READINGS), channels: text('channels', gen.CHANNELS), events: text('events', gen.EVENTS) };
	var calls = 0;
	var rpc = { declare: function(o) { return function(since, until) {
		if (o.method !== 'data') return Promise.resolve({});
		calls++;
		var cut = function(t) {
			var l = t.split('\n').filter(Boolean);
			return [ l[0] ].concat(l.slice(1).filter(function(r) { var ts = +r.split(',')[0]; return ts >= since && ts <= until; })).join('\n') + '\n';
		};
		return Promise.resolve({ readings: cut(all.readings), channels: cut(all.channels), events: cut(all.events), channelmap: made.files['channelmap.csv'] });
	}; } };
	var mh = new Function('baseclass', 'rpc', 'health', read('modemhealth/common.js'))(baseclass, rpc, health);
	var rb = new Function('baseclass', 'mh', read('modemhealth/report.js'))(baseclass, mh);
	return { mh: mh, rb: rb, all: all, calls: function() { return calls; } };
}

var NOW = Math.floor(Date.now() / 1000);
/* What a reader sees: tags removed, entities decoded. */
var text = function(html) {
	return html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
		.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
};
var MODEM = { model: 'S34', firmware: 'AT01.01.010.042324_S3.04.735', mac: '00:00:5E:00:53:01', docsis: 'DOCSIS 3.1' };

async function main() {
	/* ---------------------------------------------- a line with faults */
	var made = gen.make(NOW, 5, { hostile: true });
	/* A failed check whose reason holds markup. */
	var f0 = Object.keys(made.files).filter(function(k) { return /readings/.test(k) && /,failed,timeout,/.test(made.files[k]); })[0];
	made.files[f0] = made.files[f0].replace(',failed,timeout,', ',failed,<i>timeout</i>,');
	var r = router(made), mh = r.mh, rb = r.rb;
	var since = NOW - 7 * 86400, progress = [];
	var G = await mh.loadDigest(since, NOW, 5, null, function(done, of) { progress.push(done + '/' + of); });
	ok(r.calls() === 9 && progress[progress.length - 1] === '9/9', 'digest: seven days asked for in 9 pieces, with progress reported (' + progress.join(' ') + ')');
	eq([ G.readings.length, G.readings.filter(function(x) { return x.result !== 'ok'; }).length ], [ made.counts.readings, made.counts.failed ], 'digest: every check, failed ones included');

	var D = mh.analyse(await mh.load(since, NOW, 5), 5);
	eq(G.readings.map(function(x) { return x.verdict.level; }).join(''), D.readings.map(function(x) { return x.verdict.level; }).join(''),
		'digest: every check judged exactly as when the period is loaded whole');
	eq([ G.period.level, G.period.counts.failing, G.period.counts.degraded, G.outages.length, G.reboots.length, G.reregistrations.length ],
		[ D.period.level, D.period.counts.failing, D.period.counts.degraded, D.outages.length, D.reboots.length, D.reregistrations.length ],
		'digest: the same verdict, outages, restarts and re-registrations for the period');
	ok(G.readings.every(function(x) { return !x.verdict.channels; }) && Object.keys(G.channels).length === 39, 'digest: channel rows are let go; 39 channels keep a tally');
	var c20 = G.channels['ds,20'], rows20 = D.channels.filter(function(c) { return c.dir === 'ds' && c.channel_id === '20'; });
	eq([ c20.n, c20.powerMin, c20.powerMax, c20.unc ], [ rows20.length, Math.min.apply(null, rows20.map(function(c) { return +c.power_dbmv; })),
		Math.max.apply(null, rows20.map(function(c) { return +c.power_dbmv; })), rows20.reduce(function(s, c) { return s + (+c.uncorrectable || 0); }, 0) ],
		'digest: a channel\'s tally matches its rows (checks, lowest and highest power, uncorrectable)');

	var hostileNote = 'First reported 3 March <script>window.__xss=9</script> & again "later"';
	var opts = { modem: Object.assign({}, MODEM, { model: gen.HOSTILE[2] }), sub: { isp: 'Example <b>Cable</b>', subscriber: 'Zoë O\'Brien', account: '8155 60 012 3456789', address: '100 Example St, Apt #4' },
		notes: hostileNote, interval: 5, ping_host: '1.1.1.1', generated: NOW, version: '0.1.0' };
	var rep = rb.build(G, opts), body = rep.body, t = text(body), page = rep.page();
	eq([ rep.level, rep.headline, rep.preliminary ], [ 'failing', 'The line had faults in this period.', false ], 'faults: the report says the line had faults, and is not preliminary');
	var has = function(re, name) { return ok(re.test(t), name); };
	has(/1 outage with no internet connection, 1[45] min in total at the least\./, 'faults: the outage, with the shortest time the checks prove');
	has(/13 losses of downstream sync \(2\.[0-9] a day on average\) in the modem's own log\./, 'faults: 13 losses of sync, with the rate a day');
	has(/1 T4 time-out \(0\.2 a day on average\)/, 'faults: the T4 time-out');
	has(/1 T3 time-out /, 'faults: the T3 time-out');
	has(/register with the ISP's network again 2 times without being restarted/, 'faults: two re-registrations');
	has(/The modem restarted 1 time\./, 'faults: the restart');
	var judged = made.counts.readings - made.counts.failed;
	has(new RegExp(D.period.counts.failing + ' of the ' + judged + ' checks that read the modem \\([0-9.]+%\\) found at least one value out of spec'), 'faults: how many checks were out of spec, of those that read the modem');
	has(/4 checks could not read the modem and are counted as unknown, not as a fault of the line\./, 'faults: failed checks are stated and not held against the line');
	has(/uncorrectable codewords .* These are reported, not judged/, 'faults: uncorrectable codewords reported, not judged');
	has(/Checks made 14\d\d checks, one every 5 minutes/, 'line: the number of checks and their interval');
	has(/Checks that could not read the modem 4 \(.*unreachable: 3\)/, 'line: failed checks with their reasons');
	has(/Modem MAC address 00:00:5E:00:53:01/, 'line: the modem\'s MAC address');
	has(/Subscriber Zoë O'Brien Account number 8155 60 012 3456789 Service address 100 Example St, Apt #4/, 'line: the account details from Settings');
	has(/Times in this report UTC[+−]\d\d:\d\d/, 'line: the time zone of the times');

	/* the day-by-day table adds up */
	var dayRows = /<h3>Day by day<\/h3><table[^>]*>([\s\S]*?)<\/table>/.exec(body)[1].split('<tr').slice(2)
		.map(function(x) { return x.split('<td>').slice(1).map(function(c) { return c.replace(/<[^>]+>/g, '').replace('–', '0').replace(/,/g, ''); }); });
	var totalRow = dayRows.pop(), col = function(i) { return dayRows.reduce(function(s, x) { return s + (+x[i]); }, 0); };
	eq([ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 ].map(col), totalRow.slice(1).map(Number), 'day by day: each column adds up to its total');
	eq(totalRow.slice(1, 12).map(Number), [ made.counts.readings, 4, D.period.counts.failing, D.period.counts.degraded, 1, 13, 1, 1, 3, 2, 1 ],
		'day by day: totals are the period\'s checks, failed checks, verdicts, outage, events, re-registrations and restart');
	var times = /Every event, with its time<\/h3>([\s\S]*?)<h[23]>/.exec(body)[1];
	var listed = function(name) { var re = new RegExp(name + ' \\((\\d+)\\): ([0-9:, ]+)', 'g'), m, c = 0, tt = 0; while ((m = re.exec(times))) { c += +m[1]; tt += m[2].split(',').length; } return [ c, tt ]; };
	eq([ listed('Loss of downstream sync'), listed('T4 time-out'), listed('Re-registration'), listed('Modem restart'), listed('Outage found') ],
		[ [ 13, 13 ], [ 1, 1 ], [ 2, 2 ], [ 1, 1 ], [ 1, 1 ] ], 'events: every loss of sync, time-out, re-registration, restart and outage is listed with its time');
	ok(/<td>&lt;i&gt;timeout&lt;\/i&gt;<\/td>/.test(body) && (body.match(/<td>unreachable<\/td>/g) || []).length === 3, 'events: each failed check is listed with its time and reason');
	ok(rb.build(G, Object.assign({}, opts, { times: false })).body.indexOf('Every event, with its time') < 0, 'events: the list of times can be left out');

	/* signal */
	has(/Upstream power \(SC-QAM, 4 channels\) [0-9.]+ 5[12](\.\d)? 38 to 48 dBmV 23 to 51 dBmV out of spec/, 'signal: upstream power, highest seen above the limit for four channels: out of spec');
	has(/Downstream SNR \(SC-QAM, 256-QAM\) 2\d(\.\d)? 4\d(\.\d)? 33 or more dB 30 or more dB out of spec/, 'signal: the SNR dip shows as the lowest value seen');
	has(/Downstream MER \(OFDM\) 4[34](\.\d)? 4\d(\.\d)? 41 or more dB 34 or more dB good/, 'signal: a value that stayed good is called good');
	has(/Upstream [1-4] SC-QAM [0-9.]+ 14\d\d \d+ \(\d+(\.\d)?%\)/, 'signal: the worst channels, with how many checks were out of spec');
	eq((body.match(/<svg /g) || []).length, 4, 'signal: four charts');
	has(/Each point stands for \d+ min: the worst value of that stretch\./, 'signal: a long period is drawn in stretches, and says so');
	ok((body.match(/<path /g) || []).every(function() { return true; }) && body.length < 400000, 'signal: charts stay small (%d KB for the whole report)'.replace('%d', Math.round(page.length / 1024)));

	/* how it was measured */
	has(/Downstream power \(SC-QAM\) -7 to 7 dBmV -15 to 15 dBmV \[1\] \[2\] \[3\]/, 'limits: each limit with its ranges and numbered sources');
	has(/CableLabs, DOCSIS 3\.0 Physical Layer Specification.* – https:\/\//, 'limits: the sources are listed with their addresses');
	has(/Readings with a value out of spec none up to 5 percent of checks/, 'limits: shares are stated in percent, and "up to 0" as "none"');
	eq([ mh.fmtDuration(86399), mh.fmtDuration(3599), mh.fmtDuration(14 * 86400 - 600) ], [ '1 d 0 h', '1 h 0 min', '14 d 0 h' ], 'durations are rounded before they are split (never "13 d 24 h")');
	has(/counted as unknown and never as a fault of the line/, 'method: says how doubt was resolved in the provider\'s favour');
	has(/It does not measure speed\./, 'method: says what the router cannot see');
	has(/It is not legal advice\. Made by Modem Health 0\.1\.0/, 'footer: not legal advice; made by which version');

	/* markup */
	ok(body.indexOf('&lt;script&gt;window.__xss=3&lt;/script&gt;S34') > 0 && body.indexOf('Example &lt;b&gt;Cable&lt;/b&gt;') > 0 &&
		body.indexOf('&lt;script&gt;window.__xss=9&lt;/script&gt; &amp; again &quot;later&quot;') > 0, 'markup: model name, provider and statement are escaped');
	ok(!/<script|<img|<i>|<b>|onmouseover|onerror/i.test(body), 'markup: none of it is in the report as markup');
	ok(!/undefined|NaN|\[object|%[sdf]|Infinity/.test(t.replace(hostileNote, '')), 'no placeholder or broken number in the text');
	ok(/^<!doctype html>/.test(page) && !/<script|<link|src=|@import|url\(/i.test(page) && page.indexOf(body) > 0,
		'file: one self-contained document: no script, no outside file');

	/* limits changed by the owner */
	var mine = health.applySettings(function(o) { return { us_power_4_good_max: '51', us_power_4_acceptable_max: '53' }[o]; });
	var G2 = await mh.loadDigest(since, NOW, 5, mine.limits);
	var t2 = text(rb.build(G2, opts).body);
	ok(/Upstream power \(SC-QAM, 4 channels\) \(changed by the owner; default: good 38 to 48, acceptable 23 to 51\) 38 to 51 dBmV 23 to 53 dBmV \[\d\]/.test(t2) &&
		/Changed by the owner in this router's settings/.test(t2), 'changed limit: marked as the owner\'s, with the default beside it and its own source');
	ok(G2.period.counts.failing < G.period.counts.failing, 'changed limit: the checks are judged against it');

	/* ------------------------------------------------- a healthy line */
	var goodMade = gen.make(NOW, 5, { good: true }), g = router(goodMade);
	var GG = await g.mh.loadDigest(since, NOW, 5);
	var good = g.rb.build(GG, { modem: MODEM, generated: NOW }), gt = text(good.body);
	eq([ good.level, good.findings.length, good.preliminary ], [ 'healthy', 0, false ], 'healthy line: no findings');
	ok(new RegExp('No problems found\\. Every one of the ' + goodMade.counts.readings + ' checks found the signal within the good range').test(gt), 'healthy line: says "no problems found" and how many checks that rests on');
	ok(/No outage: at every check that could ping, the internet host answered\./.test(gt) && /No channel had a value outside the good range at any check\./.test(gt) &&
		!/class="(bad|marginal)"/.test(good.body), 'healthy line: no outage, no channel with remarks, nothing marked');
	ok(/class="box healthy"/.test(good.body) && (good.body.match(/<svg /g) || []).length === 4, 'healthy line: still shows the charts');

	/* --------------------------------------- short, empty and unread */
	var shortMade = gen.make(NOW, 0.02, {}), s = router(shortMade);
	var GS = await s.mh.loadDigest(NOW - 86400, NOW, 5);
	var short = s.rb.build(GS, { modem: MODEM, generated: NOW }), st = text(short.body);
	ok(short.preliminary && /Preliminary\. The checks in this report span only \d+ min\./.test(st), 'S34 capture alone (half an hour of checks): the report calls itself preliminary');
	ok(/13 losses of downstream sync in the modem's own log\./.test(st) && /1 T4 time-out in/.test(st) && short.level === 'failing', 'S34 capture alone: its log\'s losses of sync and T4 are reported, without a rate a day');

	var m3 = gen.make(NOW, 3, {}), r3 = router(m3), rep3 = r3.rb.build(await r3.mh.loadDigest(NOW - 7 * 86400, NOW, 5), {});
	ok(rep3.preliminary && /span only 71 hours\./.test(text(rep3.body)), 'just under three days of checks: preliminary, and the time is not rounded up to "3 days"');

	var GE = await s.mh.loadDigest(NOW - 400 * 86400, NOW - 399 * 86400, 5);
	var empty = s.rb.build(GE, {});
	ok(empty.level === 'unknown' && /No checks are stored for this period/.test(empty.body) && !/<svg/.test(empty.body), 'no data: says so, judges nothing');

	var unread = gen.make(NOW, 0.02, {});
	Object.keys(unread.files).forEach(function(k) {
		if (/^readings\//.test(k)) unread.files[k] = unread.files[k].split('\n').map(function(l, i) { return i && l ? l.split(',')[0] + ',failed,login_refused,,,,,,,,,,,,,0,1.2,0,14.0' : l; }).join('\n');
		if (/^(channels|events)\//.test(k)) delete unread.files[k];
	});
	var u = router(unread), GU = await u.mh.loadDigest(NOW - 86400, NOW, 5), ur = u.rb.build(GU, {});
	ok(ur.level === 'unknown' && /None of the \d+ checks in this period could read the modem, so the line could not be judged\./.test(ur.body) &&
		!/No problems found/.test(ur.body), 'only failed checks: the line is not judged, and not called fine');

	/* -------------------------------------------------------- periods */
	var w = rb.periodWindow('30', NOW);
	eq([ w.from, w.to ], [ NOW - 30 * 86400, NOW ], 'period: last 30 days');
	eq(rb.periodWindow('all', NOW, null, null, 45).from, NOW - 45 * 86400, 'period: everything stored goes back as far as history is kept');
	w = rb.periodWindow('custom', NOW, '2026-11-10', '2026-11-12');
	eq([ new Date(w.from * 1000).getDate(), new Date(w.to * 1000).getHours(), Math.round((w.to - w.from) / 3600) ], [ 10, 23, 72 ], 'period: custom dates run from the start of the first day to the end of the last');
	ok(rb.periodWindow('custom', NOW, '', '2999-01-01').to === NOW, 'period: never beyond now');
	eq(rb.hints({ sub: {}, modem: {} }).length, 2, 'hints: missing account details and an unread modem are pointed out');
	eq(rb.hints({ sub: { subscriber: 'A', account: '1' }, modem: MODEM }).length, 0, 'hints: none when nothing is missing');

	/* ------------- the router pastes these files into <script> elements */
	[ 'modemhealth/health.js', 'modemhealth/common.js', 'modemhealth/report.js' ].map(function(f) { return [ f, read(f) ]; })
		.concat([ [ 'standalone.js', fs.readFileSync(path.join(PKG, 'root/usr/share/modemhealth/standalone.js'), 'utf8') ] ]).forEach(function(f) {
			ok(!/<\/script|<!--/i.test(f[1]), f[0] + ' can be embedded in a <script> element of the report file on a drive');
		});

	/* ------------------------------- LuCI's format() reads more than %s */
	/* In LuCI a "%" followed by a space or by one of b c o q t m u x X j is a
	 * conversion too, so "below 80% of" swallows an argument and prints
	 * garbage. Every "%" in a formatted string must be %s, %d, %f, %h (with
	 * zero padding or a precision) or a doubled "%%". */
	var views = path.join(RES, 'view/modemhealth');
	var sources = [ 'modemhealth/common.js', 'modemhealth/report.js', 'modemhealth/gl.js', 'modemhealth/health.js' ].map(function(f) { return path.join(RES, f); })
		.concat(fs.readdirSync(views).map(function(f) { return path.join(views, f); }))
		.concat([ path.join(PKG, 'root/usr/share/modemhealth/standalone.js') ]);
	var stray = [], found = 0;
	sources.forEach(function(f) {
		var src = fs.readFileSync(f, 'utf8'), re = /'((?:[^'\\\n]|\\.)*)'\)?\s*\.format\(/g, m;
		while ((m = re.exec(src))) {
			found++;
			if (/%(?!(?:0\d+|\.\d+)?[sdfh])/.test(m[1].replace(/%%/g, '')))
				stray.push(path.basename(f) + ':' + src.slice(0, m.index).split('\n').length);
		}
	});
	ok(stray.length === 0, 'no formatted string has a "%" that LuCI would misread' + (stray.length ? ': ' + stray.join(', ') : ''));
	ok(found > 80 && sources.length >= 7, 'formatted strings were found to check (%d in %d files)'.replace('%d', found).replace('%d', sources.length));
}

main().catch(function(e) { fail++; console.log('FAIL ' + (e.stack || e)); }).then(function() {
	console.log(fail ? '\n' + fail + ' check(s) failed' : '\nall checks passed');
	process.exit(fail ? 1 : 0);
});
