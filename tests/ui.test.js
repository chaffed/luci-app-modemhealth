/*
 * The page logic in common.js: loading what the backend's `data` command
 * returns, joining channels to the line-up, and the analysis and texts the
 * Overview shows. Run: node tests/ui.test.js
 */
var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');
var RES = path.join(ROOT, 'luci-app-modemhealth/htdocs/luci-static/resources');

/* LuCI's String.prototype.format and _() stand-ins (from ISPy's tests). */
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
function ok(cond, name) { if (!cond) fail++; console.log((cond ? 'ok   ' : 'FAIL ') + name); }
function eq(got, want, name) {
	var g = JSON.stringify(got), w = JSON.stringify(want);
	ok(g === w, name + (g === w ? '' : ' (got ' + g + ', expected ' + w + ')'));
}

var baseclass = { extend: function(o) { return o; } };
var health = new Function('baseclass', fs.readFileSync(path.join(RES, 'modemhealth/health.js'), 'utf8'))(baseclass);
var served = {};
/* data(since, until) answers like the backend: rows whose first column
 * is within the range, each part with its header. */
var dataCalls = 0;
var rpc = { declare: function(o) { return function(since, until) {
	if (o.method !== 'data') return Promise.resolve(served[o.method]);
	dataCalls++;
	var d = served.data, cut = function(t) {
		var l = t.split('\n').filter(Boolean);
		return [ l[0] ].concat(l.slice(1).filter(function(r) { var ts = +r.split(',')[0]; return ts >= since && ts <= until; })).join('\n') + '\n';
	};
	var reply = { readings: cut(d.readings), channels: cut(d.channels), events: cut(d.events), channelmap: d.channelmap };
	/* ISPy's speed tests, when the router has any (see the end). */
	if (d.speed) reply.speed = { plan_down: d.speed.plan_down, plan_up: d.speed.plan_up, tests: cut(d.speed.tests) };
	return Promise.resolve(reply);
}; } };
var mh = new Function('baseclass', 'rpc', 'health', fs.readFileSync(path.join(RES, 'modemhealth/common.js'), 'utf8'))(baseclass, rpc, health);

/* What the backend stores, built from the real S34 capture. */
var READINGS = 'ts,result,reason,model,firmware,uptime_s,connectivity,boot,network_access,modem_time,ds_channels,us_channels,reboot,boot_ts,clock_offset_s,modem_ping_loss,modem_ping_ms,inet_ping_loss,inet_ping_ms';
var fx = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/s34/cmconnectionstatus.json'), 'utf8')).GetMultipleHNAPsResponse;
var ds = fx.GetCustomerStatusDownstreamChannelInfoResponse.CustomerConnDownstreamChannel.split('|+|').filter(Boolean).map(function(r) { return r.split('^').map(function(s) { return s.trim(); }); });
var us = fx.GetCustomerStatusUpstreamChannelInfoResponse.CustomerConnUpstreamChannel.split('|+|').filter(Boolean).map(function(r) { return r.split('^').map(function(s) { return s.trim(); }); });
var T = 1795000000, S = 300;
var readings = [ READINGS ], channels = [ 'ts,dir,channel_id,lock,power_dbmv,snr_db,corrected,uncorrectable' ];
var map = [ 'ts,dir,ch,channel_id,modulation,freq_hz,width_hz' ];
ds.forEach(function(f) { map.push([ T, 'ds', f[0], f[3], f[2], f[4], '' ].join(',')); });
us.forEach(function(f) { map.push([ T, 'us', f[0], f[3], f[2], f[5], f[4] ].join(',')); });
function good(ts, extra) {
	var e = Object.assign({ reboot: 0, boot_ts: '', inet: 0, modem: 0, unc: 3 }, extra || {});
	readings.push([ ts, 'ok', '', 'S34', 'fw', 6000, 'Operational', 'Operational', 'Allowed', '11/19/2026 14:13:57', ds.length, us.length,
		e.reboot, e.boot_ts, 0, e.modem, e.modem === 100 ? '' : 1.2, e.inet, e.inet === 100 ? '' : 15 ].join(','));
	ds.forEach(function(f) { channels.push([ ts, 'ds', f[3], f[1], f[5], f[6], 10, e.unc ].join(',')); });
	us.forEach(function(f) { channels.push([ ts, 'us', f[3], f[1], f[6], '', '', '' ].join(',')); });
}
good(T); good(T + S); good(T + 2 * S, { reboot: 1, boot_ts: T + 2 * S - 60 });
readings.push([ T + 3 * S, 'failed', 'unreachable', '', '', '', '', '', '', '', '', '', '', '', '', 100, '', 100, '' ].join(','));
good(T + 4 * S, { inet: 100 }); good(T + 5 * S); good(T + 6 * S);
/* The captured log ran 12:06:13 to 14:13:54 modem time; put the period
 * around it: the modem's 14:13:54 is T + 6 * S on the router's clock. */
var lastLocal = new Date(2026, 10, 19, 14, 13, 54).getTime() / 1000;
var OFFSET = Math.round(lastLocal - (T + 6 * S));
var log = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/s34/cmeventlog.json'), 'utf8')).GetCustomerStatusLogResponse.CustomerStatusLogList;
var events = [ 'first_seen_ts,modem_time,clock_offset_s,level,message' ].concat(health.parseModemLog(log).reverse()
	.filter(function(e) { return e.kind !== 'login'; })
	.map(function(e) { return [ T + 6 * S, e.time, OFFSET, e.level, e.message.replace(/;CM-MAC=.*$/, '').replace(/,/g, '') ].join(','); }));
served.data = { readings: readings.join('\n') + '\n', channels: channels.join('\n') + '\n', events: events.join('\n') + '\n', channelmap: map.join('\n') + '\n' };

mh.load(T - 6 * 3600, T + 7 * S, 1).then(async function(D) {
	eq(D.readings.length, 7, 'load: all readings');
	eq([ dataCalls, D.channels.length ], [ 2, 7 * 39 - 39 ], 'load: asked for in pieces (250 checks at 1 minute = 4 h 10 min) and put back together without loss');
	var c = D.channelsAt[String(T)].filter(function(x) { return x.dir === 'ds' && x.channel_id === '194'; })[0];
	eq([ c.modulation, c.freq_hz, c.ch ], [ 'OFDM PLC', '957000000', '34' ], 'load: channels joined to the line-up (modulation, frequency, index)');
	var u = D.channelsAt[String(T)].filter(function(x) { return x.dir === 'us' && x.channel_id === '41'; })[0];
	eq([ u.modulation, u.width_hz ], [ 'OFDMA', '44400000' ], 'load: upstream OFDMA channel joined (channel ID 41 exists in both directions)');
	eq(D.events.filter(function(e) { return e.kind === 'sync_loss'; }).length, 13, 'load: events classified');
	var oldest = D.events[0];
	eq([ oldest.modem_time, oldest.ts ], [ '11/19/2026 12:06:13', T + 6 * S - (2 * 3600 + 7 * 60 + 41) ],
		'load: events dated by the modem\'s clock corrected to the router\'s, not by when the router first saw them');
	eq(mh.load === undefined, false, 'load: exported');

	mh.analyse(D, 5);
	eq(D.readings[0].verdict.level, 'degraded', 'analyse: a reading with marginal upstream power is degraded');
	eq(D.readings[3].verdict.level, 'unknown', 'analyse: a failed reading is unknown');
	eq(D.outages.length, 1, 'analyse: the failed check and the next one without internet are one outage');
	eq([ D.outages[0].kind, D.outages[0].start, D.outages[0].end, D.outages[0].minS, D.outages[0].maxS ],
		[ 'modem_unreachable', T + 3 * S, T + 4 * S, S, 3 * S ], 'analyse: outage kind and duration range');
	eq(D.reboots.length, 1, 'analyse: one modem restart');
	eq(D.reregistrations.length, 2, 'analyse: two re-registrations in the log');
	eq(D.period.level, 'failing', 'analyse: the period is failing (outage, T4, losses of sync)');
	eq(D.period.reasons[0].level, 'bad', 'analyse: worst reasons first');

	ok(Math.abs(D.period.hours - (2 * 3600 + 12 * 60 + 41) / 3600) < 1e-6, 'analyse: the period runs from the earliest event (2 h 12 min 41 s to its end), not the first reading');
	var texts = D.period.reasons.map(function(r) { return mh.reasonText(r, D.period.hours); })
		.concat(D.readings[0].verdict.reasons.concat(D.readings[3].verdict.reasons).map(function(r) { return mh.reasonText(r); }));
	ok(texts.some(function(t) { return /13 loss\(es\) of downstream sync in 2 h 13 min\./.test(t); }), 'texts: short periods give a count over the time, not a rate a day');
	eq(mh.reasonText({ kind: 't3', count: 30, perDay: 1.5 }, 480), '30 T3 time-out(s), 1.5 a day: the ISP did not answer the modem.', 'texts: periods of a day or more give a rate a day');
	ok(texts.length > 3 && texts.every(function(t) { return t && !/undefined|NaN|%[sdf]/.test(t); }),
		'texts: every reason reads as a sentence (' + texts.length + ')');
	console.log('     e.g. ' + texts.slice(0, 4).join(' | '));
	ok(mh.fmtLimit(health.LIMITS.ds_power) === 'Downstream power (SC-QAM): good -7 … 7, acceptable -15 … 15 dBmV', 'texts: a limit in words');
	eq([ mh.fmtDuration(45), mh.fmtDuration(900), mh.fmtDuration(5400), mh.fmtDuration(90000), mh.fmtDuration(null) ],
		[ '45 s', '15 min', '1 h 30 min', '1 d 1 h', 'unknown' ], 'texts: durations');
	eq(mh.fmtInt('1234567'), '1,234,567', 'texts: thousands separators');
	var grouped = mh.groupReasons(D.readings[0].verdict.reasons);
	eq(grouped.map(function(g) { return mh.groupedText(g); }),
		[ 'Upstream power (SC-QAM, 4 channels) marginal on 4 channels: 50 to 50.8 dBmV.' ],
		'texts: the four marginal upstream channels are one line with the range of values');

	/* The line-up holds an entry for a channel only when it changed: a row
	 * is joined to the entry of its own time. */
	var whole = served.data;
	served.data = Object.assign({}, whole, { channelmap: whole.channelmap + [ T + 2 * S, 'ds', '34', '194', 'OFDM PLC', '963000000', '' ].join(',') + '\n' });
	var Dm = await mh.load(T - 6 * 3600, T + 7 * S, 5);
	var f194 = function(ts) { return Dm.channelsAt[String(ts)].filter(function(x) { return x.dir === 'ds' && x.channel_id === '194'; })[0].freq_hz; };
	eq([ f194(T), f194(T + S), f194(T + 2 * S), f194(T + 6 * S), Dm.channelsAt[String(T + 6 * S)].filter(function(x) { return x.modulation; }).length ],
		[ '957000000', '957000000', '963000000', '963000000', 39 ],
		'load: a channel that moved has its old frequency before the change and the new one from it on; the others keep their one entry');
	served.data = whole;

	/* CSV export */
	var csv = function(kind) { return mh.toCSV(D, kind).split('\r\n').filter(Boolean); };
	eq([ csv('readings').length, csv('channels').length, csv('events').length ], [ 1 + 7, 1 + 6 * 39, 1 + D.events.length ], 'csv: a header and every row of the period');
	ok(/^time,ts,result,reason,/.test(csv('readings')[0]) && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,1795000000,ok,/.test(csv('readings')[1]), 'csv: readings start with the local time');
	ok(csv('channels').some(function(l) { return /,ds,34,194,OFDM PLC,957000000,/.test(l); }), 'csv: channels carry the line-up (index, modulation, frequency)');
	eq([ mh.csvField('=HYPERLINK("x")'), mh.csvField('-1.4'), mh.csvField('@SUM'), mh.csvField('a,b'), mh.csvField(null) ],
		[ '"\'=HYPERLINK(""x"")"', '-1.4', '\'@SUM', '"a,b"', '' ], 'csv: formulas defused, numbers kept, commas and quotes quoted');

	/* limits from the settings */
	var mine = health.applySettings(function(o) { return { us_power_4_good_max: '51', us_power_4_acceptable_max: '53' }[o]; });
	var D2 = mh.analyse(D, 5, mine.limits);
	eq([ D2.readings[0].verdict.level, D2.limits === mine.limits ], [ 'healthy', true ], 'analyse: judged against the limits from the settings');
	mh.analyse(D, 5);

	/* ---------------------------------------------- ISPy's speed tests */
	eq([ D.speed, D.speedTests ], [ null, null ], 'speed: without ISPy there is nothing about speed');
	/* As the backend passes them on: time, status, the test's own figures
	 * and what ISPy counted on the WAN port. Checks were at T, T + S, ...,
	 * the outage at T + 3 S and T + 4 S, and the log's last loss of sync
	 * 200 s before T; the advertised speed is 1000/40. */
	var HEAD = 'ts,status,down_mbps,up_mbps,wan_down_mbps,wan_up_mbps';
	var speedRows = [
		[ T - 5 * 3600, 'ok', 950, 39, 952, 39.2 ],        /* in the earlier piece, hours before the first check */
		[ T + 30, 'ok', 990.5, 39, 995.25, 39.1 ],         /* 230 s after that loss of sync */
		[ T + S + 40, 'ok', 700, 39, 960, 39.1 ],          /* slow by the test, not by what crossed the WAN port */
		[ T + 3 * S + 20, 'error', '', '', '', '' ],
		[ T + 4 * S + 20, 'ok', 120, 12, 118, 11.5 ],
		[ T + 5 * S + 250, 'ok', 610, 38, '', '' ],        /* no WAN figures (an older ISPy) */
		[ T + 6 * S + 10, 'ok', '', 39, '', 39 ],          /* no download figure at all: not a test */
		[ 'x', 'ok', 1, 1, 1, 1 ]
	].map(function(r) { return r.join(','); });
	served.data = Object.assign({}, whole, { speed: { plan_down: '1000', plan_up: '40', tests: [ HEAD ].concat(speedRows).join('\n') + '\n' } });
	var before = dataCalls;
	var Ds = mh.analyse(await mh.load(T - 6 * 3600, T + 7 * S, 1), 5), ST = Ds.speedTests;
	eq([ dataCalls - before, Ds.speed.planDown, Ds.speed.planUp, Ds.speed.tests.length ], [ 2, 1000, 40, 5 + 1 ],
		'speed: the tests of every piece of the period, once each; rows without a time or a speed are not tests');
	eq(ST.tests.map(function(t) { return [ t.ts - T, t.group, t.line, t.down, t.up ]; }), [
		[ -5 * 3600, 'fine', 'unknown', 952, 39.2 ],
		[ 30, 'fine', 'events', 995.25, 39.1 ],
		[ S + 40, 'fine', 'marginal', 960, 39.1 ],
		[ 3 * S + 20, 'failed', 'outage', null, null ],
		[ 4 * S + 20, 'slow', 'outage', 120, 12 ],
		[ 5 * S + 250, 'slow', 'marginal', 610, 38 ]
	], 'speed: each test credited with the higher of the test and the WAN port (as ISPy does), and set against what the modem recorded around it');
	eq([ ST.windowS, mh.analyse(Ds, 1).speedTests.windowS, mh.analyse(Ds, 15).speedTests.windowS ], [ 300, 300, 900 ],
		'speed: the window is the time between two checks, and never less than five minutes');
	mh.analyse(Ds, 5);
	eq(mh.speedSentences(ST), [
		'6 speed tests by ISPy in this period, of which 1 did not complete.',
		'Slow (download or upload below 80% of the advertised speed): 2 tests, 1 of them within 5 minutes of a line problem the modem recorded.',
		'Not slow: 3 tests, 1 of them within 5 minutes of a line problem. For 1 it is not known: no check read the modem then.'
	], 'speed: in words, for the Overview; a test with no check near it is said to be not known');
	var sc = mh.speedChart(ST, { from: T - 600, to: T + 7 * S });
	eq([ sc.percent, sc.before, sc.stretch, sc.chart.suffix, sc.chart.series.map(function(x) { return [ x.name, x.dots, x.points.length ]; }), sc.chart.marks.length, sc.chart.bands ],
		[ true, 1, null, '%', [ [ 'download', true, 4 ], [ 'upload', true, 4 ] ], 1, [ { lo: null, hi: 80, color: mh.C.bad } ] ],
		'speed chart: a dot for each test that completed, in percent of the advertised speed, the slow band shaded, a tick for the failed test, and the test from before the axis left out');
	eq([ sc.chart.series[0].points[2].slice(0, 2), sc.chart.series[1].points[2][1], /download 120 Mbit\/s, 12% of the advertised 1000 Mbit\/s$/.test(sc.chart.series[0].points[2][2]) ],
		[ [ T + 4 * S + 20, 12 ], 30, true ], 'speed chart: each dot at the test\'s time and share, described in Mbit/s and percent');
	var svg = mh.chartSVG(Object.assign({ from: T - 600, to: T + 7 * S, title: 'Speed' }, sc.chart));
	eq([ (svg.match(/<circle /g) || []).length, (svg.match(/<path /g) || []).length, />80%</.test(svg), /speed test did not complete/.test(svg) ],
		[ 8, 0, true, true ], 'speed chart: drawn as dots without a line, the axis in percent');
	var few = mh.speedChart(ST, { from: T - 600, to: T + 7 * S, max: 2 });
	eq([ few.chart.series[0].points.length <= 2, few.stretch > 0, few.chart.series[0].points.some(function(p) { return p[1] === 12; }) ], [ true, true, true ],
		'speed chart: too many tests to draw: the slowest of each stretch is kept, and the chart says how long a stretch is');

	served.data = Object.assign({}, whole, { speed: { plan_down: '', plan_up: 'fast', tests: [ HEAD ].concat(speedRows).join('\n') + '\n' } });
	var Dn = mh.analyse(await mh.load(T - 6 * 3600, T + 7 * S, 1), 5), noPlan = mh.speedChart(Dn.speedTests, { from: T - 600, to: T + 7 * S });
	eq([ Dn.speed.planDown, Dn.speed.planUp, Dn.speedTests.counts.unjudged.total, Dn.speedTests.counts.slow.total, mh.speedSentences(Dn.speedTests)[1] ],
		[ null, null, 5, 0, 'No advertised speed is set in ISPy, so its tests cannot be called slow or not.' ],
		'speed: with no advertised speed set in ISPy (or one that is not a number) no test is called slow');
	eq([ noPlan.percent, noPlan.chart.bands.length, noPlan.chart.series[0].points[2][1], noPlan.chart.suffix ], [ false, 0, 120, '' ], 'speed chart: then in Mbit/s, with no slow band');
	served.data = Object.assign({}, whole, { speed: { plan_down: '1000', plan_up: '', tests: [ HEAD ].concat(speedRows).join('\n') + '\n' } });
	var D1 = mh.analyse(await mh.load(T - 6 * 3600, T + 7 * S, 1), 5);
	eq([ mh.speedSentences(D1.speedTests)[1], mh.speedChart(D1.speedTests, { from: T - 600, to: T + 7 * S }).chart.series.length ],
		[ 'Slow (download below 80% of the advertised speed): 2 tests, 1 of them within 5 minutes of a line problem the modem recorded.', 1 ], 'speed: with only a download speed advertised, only download is judged and drawn');
	served.data = Object.assign({}, whole, { speed: { plan_down: '1000', plan_up: '40', tests: HEAD + '\n' } });
	eq((mh.analyse(await mh.load(T - 6 * 3600, T + 7 * S, 1), 5)).speedTests, null, 'speed: ISPy installed but with no test in the period: nothing about speed');
	served.data = whole;
}).catch(function(e) { fail++; console.log('FAIL ' + e.stack); }).then(function() {
	console.log(fail ? '\n' + fail + ' check(s) failed' : '\nall checks passed');
	process.exit(fail ? 1 : 0);
});
