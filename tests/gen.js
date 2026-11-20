/*
 * Synthetic history for tests and demo screenshots, in the layout the
 * backend stores (daily files in readings/, channels/ and events/, the
 * channel line-up, modem.txt and events.seen). Built around the real S34
 * capture in tests/fixtures/s34: a line with upstream power at the limit,
 * an SNR dip, an outage followed by a modem restart, a failed check, two
 * hours with the router off, and the capture's own event log at the end.
 *
 *   node tests/gen.js OUTDIR [DAYS] [--hostile] [--good]
 *
 * --hostile adds events and a model name containing markup, to prove no
 * page renders it. --good gives a line with nothing wrong: every value
 * within the good range, no events, no failed checks.
 *
 * make() also returns the results file of an ISPy on the same router (the
 * speed tests of those days and one day more, in ISPy's own format): slow
 * tests while the line had its problems, slow tests while it had none, a
 * test that failed during the outage. It is not among the files of the
 * history: ISPy keeps it elsewhere (see .ispy).
 */
var fs = require('fs'), path = require('path');
var FIX = path.join(__dirname, 'fixtures', 's34');

exports.READINGS = 'ts,result,reason,model,firmware,uptime_s,connectivity,boot,network_access,modem_time,ds_channels,us_channels,reboot,boot_ts,clock_offset_s,modem_ping_loss,modem_ping_ms,inet_ping_loss,inet_ping_ms';
exports.CHANNELS = 'ts,dir,channel_id,lock,power_dbmv,snr_db,corrected,uncorrectable';
exports.EVENTS = 'first_seen_ts,modem_time,clock_offset_s,level,message';
exports.CHANNELMAP = 'ts,dir,ch,channel_id,modulation,freq_hz,width_hz';
exports.ISPY = 'ts,backend,server,ping_ms,jitter_ms,loss_pct,loaded_down_ms,loaded_up_ms,down_mbps,up_mbps,bytes,status,message,wan_down_mbps,wan_up_mbps,bg_down_mbps,bg_up_mbps,cpu_down_pct,cpu_up_pct,link_mbps,dev';
exports.HOSTILE = [ '<img src=x onerror=window.__xss=1>', '<b onmouseover=window.__xss=2>Critical</b>', '<script>window.__xss=3</script>S34' ];

function fields(s) {
	return s.split('|+|').filter(Boolean).map(function(r) { return r.split('^').map(function(x) { return x.trim(); }); });
}
function pad(n) { return (n < 10 ? '0' : '') + n; }
function modemTime(ts) {
	var d = new Date(ts * 1000);
	return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
/* The router names its daily files by its own date; the test container
 * runs in UTC. */
function day(ts) { return new Date(ts * 1000).toISOString().slice(0, 10); }

/* make(now, days, opts) -> {
 *   files: { 'readings/2026-11-19.csv': text, ..., 'channelmap.csv', 'modem.txt', 'events.seen' },
 *   counts: { readings, failed, restarts, events }, times: { outage, down, restart, dip, gap, lone, failed },
 *   ispy: { results: text of ISPy's results file, plan_down, plan_up (Mbit/s, as set in ISPy),
 *           times: { outage, failed, dip, sync, wan, quiet: when the tests made for those moments started } }
 * }
 * opts.interval: minutes between checks (default 5); opts.hostile, opts.good: see above. */
exports.make = function(now, days, opts) {
	opts = opts || {};
	var step = (opts.interval || 5) * 60, seed = 7;
	var rnd = function() { return (seed = (seed * 16807) % 2147483647) / 2147483647; };
	var st = JSON.parse(fs.readFileSync(path.join(FIX, 'cmconnectionstatus.json'), 'utf8')).GetMultipleHNAPsResponse;
	var ds = fields(st.GetCustomerStatusDownstreamChannelInfoResponse.CustomerConnDownstreamChannel);
	var us = fields(st.GetCustomerStatusUpstreamChannelInfoResponse.CustomerConnUpstreamChannel);
	var model = opts.hostile ? exports.HOSTILE[2] : 'S34', firmware = 'AT01.01.010.042324_S3.04.735';

	var start = now - days * 86400 + 240, last = now - 200;
	var T = {
		gap: [ now - 50 * 3600, now - 48 * 3600 ],        /* router off */
		lone: now - 49 * 3600,                            /* one check in the middle of it */
		dip: [ now - 30 * 3600, now - 30 * 3600 + 2400 ], /* noise on the line */
		outage: [ now - 20 * 3600, now - 20 * 3600 + 3 * step + 60 ],
		failed: now - 8 * 3600                            /* one check the modem did not answer in time */
	};
	if (opts.good)
		T = { gap: [ 0, 0 ], lone: 0, dip: [ 0, 0 ], outage: [ 0, 0 ], failed: 0 };
	var files = {}, counts = { readings: 0, failed: 0, restarts: 0, events: 0 }, stamps = [];
	var add = function(name, header, line) { files[name] = (files[name] || header + '\n') + line + '\n'; };
	var boot = start - 9 * 86400 - 4000, restartPending = false, lineDownNext = false;

	for (var t = start; t <= last; t += step) {
		var ts = t + Math.floor(rnd() * 20);
		if (ts > T.gap[0] && ts < T.gap[1] && Math.abs(ts - T.lone) > step / 2) continue;
		var r = 'readings/' + day(ts) + '.csv', c = 'channels/' + day(ts) + '.csv';
		counts.readings++;
		stamps.push(ts);
		if (ts >= T.outage[0] && ts < T.outage[1]) {
			add(r, exports.READINGS, [ ts, 'failed', 'unreachable', '', '', '', '', '', '', '', '', '', '', '', '', 100, '', 100, '' ].join(','));
			counts.failed++;
			if (!T.down) T.down = ts;   /* the first check that found the internet gone */
			restartPending = true; lineDownNext = true;
			continue;
		}
		if (Math.abs(ts - T.failed) < step / 2) {
			add(r, exports.READINGS, [ ts, 'failed', 'timeout', '', '', '', '', '', '', '', '', '', '', '', '', 0, 1.9, 0, 14.8 ].join(','));
			counts.failed++;
			continue;
		}
		var reboot = 0, bootTs = '';
		if (restartPending) { boot = ts - 95; reboot = 1; bootTs = boot; restartPending = false; counts.restarts++; T.restart = boot; }
		var inet = lineDownNext ? 100 : (rnd() < 0.01 && !opts.good ? 33 : 0);
		lineDownNext = false;
		add(r, exports.READINGS, [ ts, 'ok', '', model, firmware, ts - boot, 'Operational', 'Operational', 'Allowed', modemTime(ts + 2), ds.length, us.length,
			reboot, bootTs, 2, 0, (1.5 + rnd() * 0.6).toFixed(3), inet, inet === 100 ? '' : (13 + rnd() * 5).toFixed(3) ].join(','));
		var hour = (ts % 86400) / 3600, wave = Math.sin(2 * Math.PI * (ts % 86400) / 86400);
		var dip = ts >= T.dip[0] && ts <= T.dip[1];
		var evening = hour >= 2 && hour < 5 && !opts.good;   /* the evening on the US west coast, in UTC */
		ds.forEach(function(f) {
			var ofdm = /OFDM/.test(f[2]);
			var power = +f[5] + 1.2 * wave + (rnd() - 0.5) * 0.4;
			var snr = +f[6] + (rnd() - 0.5) * 0.8 - (dip && !ofdm ? 8.5 + rnd() * 3 : 0);
			var corrected = Math.round((dip ? 4000 : 20) * rnd() * (ofdm ? 30 : 1));
			var unc = dip ? Math.round(300 + rnd() * 2500) : (rnd() < 0.03 && !opts.good ? Math.round(rnd() * 40) : 0);
			add(c, exports.CHANNELS, [ ts, 'ds', f[3], f[1], power.toFixed(1), snr.toFixed(1), corrected, unc ].join(','));
		});
		us.forEach(function(f) {
			var ofdma = /OFDMA/.test(f[2]);
			/* The captured line transmits at 50.5 dBmV; a good one has headroom. */
			var power = +f[6] + 0.3 * wave + (rnd() - 0.5) * 0.3 + (evening && !ofdma ? 0.9 : 0) - (opts.good && !ofdma ? 6 : 0);
			add(c, exports.CHANNELS, [ ts, 'us', f[3], f[1], power.toFixed(1), '', '', '' ].join(','));
		});
	}

	/* The line-up, as first seen. */
	var map = [ exports.CHANNELMAP ];
	ds.forEach(function(f) { map.push([ stamps[0], 'ds', f[0], f[3], f[2], f[4], '' ].join(',')); });
	us.forEach(function(f) { map.push([ stamps[0], 'us', f[0], f[3], f[2], f[5], f[4] ].join(',')); });
	files['channelmap.csv'] = map.join('\n') + '\n';

	/* The captured log, cleaned the way the backend stores it, with the
	 * modem's clock offset chosen so that its last entry is ten minutes old.
	 * Each entry is first seen at the next check. */
	var log = JSON.parse(fs.readFileSync(path.join(FIX, 'cmeventlog.json'), 'utf8')).GetCustomerStatusLogResponse.CustomerStatusLogList;
	var entries = log.replace(/[\x00-\x1f",\\<>]/g, '').split('}-{').map(function(e) { return e.split('^'); })
		.filter(function(f) { return f[1] && !/WebGUI login/.test(f[4]); }).reverse()
		.map(function(f) { return { when: f[1], level: f[3], msg: f[4].replace(/;CM-MAC=.*$/, '').replace(/(\d+\.){3}\d+/g, 'x.x.x.x') }; });
	var local = function(when) {
		var m = /^(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+)$/.exec(when);
		return new Date(+m[3], m[1] - 1, +m[2], +m[4], +m[5], +m[6]).getTime() / 1000;
	};
	var offset = Math.round(local(entries[entries.length - 1].when) - (now - 600)), seen = [];
	if (opts.good)
		entries = [];
	if (opts.hostile) {
		entries.push({ when: modemTime(now - 420 + offset), level: 'Notice', msg: exports.HOSTILE[0] + ' markup in a message' });
		entries.push({ when: modemTime(now - 400 + offset), level: exports.HOSTILE[1], msg: 'markup in a level' });
	}
	/* Entries from before the modem's clock was set (it starts at 1970)
	 * were seen together with the first dated entry after them. */
	var dated = function(e) { return +/\/(\d+) /.exec(e.when)[1] >= 2000; };
	entries.forEach(function(e, i) {
		var next = entries.slice(i).filter(dated)[0] || e;
		var at = local(next.when) - offset;
		var first = stamps.filter(function(s) { return s >= at; })[0] || now;
		add('events/' + day(first) + '.csv', exports.EVENTS, [ first, e.when, offset, e.level, e.msg ].join(','));
		seen.push(e.when + '^' + e.msg);
		counts.events++;
	});
	files['events.seen'] = seen.join('\n') + '\n';
	files['modem.txt'] = [ 'model=' + model, 'firmware=' + firmware, 'mac=00:00:5E:00:53:01', 'docsis=DOCSIS 3.1' ].join('\n') + '\n';

	/* ISPy on the same router: a test an hour (from a day before Modem
	 * Health's first check, and not while the router was off), plus tests
	 * at the moments that matter. Speeds as shares of the advertised
	 * 1000/40 Mbit/s; "wan" is what ISPy counted on the WAN port. */
	var PD = 1000, PU = 40, seed2 = 11, tests = [], IT = {};
	var rnd2 = function() { return (seed2 = (seed2 * 16807) % 2147483647) / 2147483647; };
	var test = function(ts, down, up, o) {
		o = o || {};
		var d = (down * PD).toFixed(2), u = (up * PU).toFixed(2);
		tests.push([ ts, o.status === 'skipped'
			? [ ts, 'cloudflare', '', '', '', '', '', '', '', '', 0, 'skipped', 'line busy (61.20 Mbit/s > 50)', '', '', '', '', '', '', '', 'eth0' ]
			: o.status === 'error'
			? [ ts, 'cloudflare', '', '', '', '', '', '', '', '', 0, 'error', o.message || 'the test server could not be reached', '', '', '0.02', '0.00', '', '', 2500, 'eth0' ]
			: [ ts, 'cloudflare', 'SJC', (11 + rnd2() * 4).toFixed(2), (0.4 + rnd2()).toFixed(2), '0.0', (20 + rnd2() * 15).toFixed(2), (25 + rnd2() * 20).toFixed(2),
				d, u, Math.round(down * PD * 1.6e6), 'ok', '', ((o.wan || down * 1.004) * PD).toFixed(2), (up * 1.004 * PU).toFixed(2), '0.31', '0.05', 41, 23, 2500, 'eth0' ] ]);
	};
	for (var h = start - 86400 + 1500; h <= last; h += 3600) {
		if (h > T.gap[0] - 600 && h < T.gap[1] + 600) continue;
		var hr = (h % 86400) / 3600;
		if (hr >= 14 && hr < 15 && !opts.good) test(h, 0.7, 1, {});                        /* slow at a quiet time of day */
		else if (hr >= 3 && hr < 4 && !opts.good) test(h, 0.97, 0.6, {});                  /* slow upload in the evening */
		else if (hr >= 20 && hr < 21) test(h, 0, 0, { status: 'skipped' });                /* the line was busy */
		else test(h, 0.93 + rnd2() * 0.14, 0.95 + rnd2() * 0.1, {});
	}
	if (!opts.good) {
		IT.outage = (T.down || T.outage[0]) - 120;   /* two minutes before the first check that found the internet gone */
		IT.failed = T.outage[0] + 400;
		IT.dip = T.dip[0] + 900;
		test(IT.outage, 0.12, 0.3, {});
		test(IT.failed, 0, 0, { status: 'error' });
		test(IT.dip, 0.45, 0.9, {});
		var sync = entries.filter(function(e) { return /SYNC Timing Synchronization failure/.test(e.msg) && dated(e); })[0];
		if (sync) { IT.sync = Math.round(local(sync.when) - offset) + 30; test(IT.sync, 0.3, 0.5, {}); }
	}
	/* Slow by the test's own figure, not by what crossed the WAN port: ISPy
	 * credits the higher of the two. */
	if (start + 7 * 3600 + 700 <= last) {
		IT.wan = start + 5 * 3600 + 700;
		test(IT.wan, 0.7, 1, { wan: 0.96 });
		IT.quiet = start + 7 * 3600 + 700;
		test(IT.quiet, 0.55, 1, {});
	}
	tests.sort(function(a, b) { return a[0] - b[0]; });
	var ispy = { results: exports.ISPY + '\n' + tests.map(function(t) { return t[1].join(','); }).join('\n') + '\n', plan_down: PD, plan_up: PU, times: IT };

	return { files: files, counts: counts, times: T, first: stamps[0], last: stamps[stamps.length - 1], ispy: ispy };
};

exports.write = function(dir, made) {
	Object.keys(made.files).forEach(function(name) {
		fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
		fs.writeFileSync(path.join(dir, name), made.files[name]);
	});
};

if (require.main === module) {
	var args = process.argv.slice(2).filter(function(a) { return a.slice(0, 2) !== '--'; });
	if (!args[0]) { console.error('usage: node tests/gen.js OUTDIR [DAYS] [--hostile] [--good]'); process.exit(2); }
	var made = exports.make(Math.floor(Date.now() / 1000), +args[1] || 3,
		{ hostile: process.argv.indexOf('--hostile') > 0, good: process.argv.indexOf('--good') > 0 });
	exports.write(args[0], made);
	console.log('%d checks (%d failed), %d events in %s', made.counts.readings, made.counts.failed, made.counts.events, args[0]);
}
