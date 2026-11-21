/*
 * Health rules: verdicts at and around every limit, and on the real S34
 * capture. Run: node tests/health.test.js
 */
var fs = require('fs'), path = require('path');

var ROOT = path.join(__dirname, '..');
var src = fs.readFileSync(path.join(ROOT, 'luci-app-modemhealth/htdocs/luci-static/resources/modemhealth/health.js'), 'utf8');
var H = new Function('baseclass', src)({ extend: function(o) { return o; } });

var fail = 0;
function ok(cond, name) {
	if (!cond) fail++;
	console.log((cond ? 'ok   ' : 'FAIL ') + name);
}
function eq(got, want, name) {
	var g = JSON.stringify(got), w = JSON.stringify(want);
	ok(g === w, name + (g === w ? '' : ' (got ' + g + ', expected ' + w + ')'));
}

/* ------------------------------------------------- every limit is sourced */
Object.keys(H.LIMITS).forEach(function(k) {
	var L = H.LIMITS[k];
	var list = L.label ? [ L ] : Object.keys(L).map(function(n) { return L[n]; });
	list.forEach(function(l) {
		ok(Array.isArray(l.sources) && l.sources.length > 0 && l.sources.every(function(s) { return H.SOURCES[s]; }),
			'limit ' + k + ' names at least one known source');
		ok(typeof l.label === 'string' && l.label.length > 0, 'limit ' + k + ' has a label for the report');
	});
});
Object.keys(H.SOURCES).forEach(function(s) {
	var S = H.SOURCES[s];
	ok(S.title && (S.url || S.judgement), 'source ' + s + ' has a title and a URL (or is marked as Modem Health\'s judgement)');
});

/* ------------------------------------------------ boundaries of each band */
function edges(limit) {
	/* values just inside and just outside each finite bound */
	var out = [], e = 0.05;
	[ 'good', 'marginal' ].forEach(function(b) {
		var r = limit[b];
		if (!r) return;
		if (r[0] != null) out.push(r[0], r[0] - e, r[0] + e);
		if (r[1] != null) out.push(r[1], r[1] - e, r[1] + e);
	});
	return out;
}
function expectBand(v, limit) {
	var inR = function(r) { return r && (r[0] == null || v >= r[0]) && (r[1] == null || v <= r[1]); };
	return inR(limit.good) ? 'good' : inR(limit.marginal) ? 'marginal' : 'bad';
}
function testChannel(name, ch, metric, limit, usN) {
	edges(limit).forEach(function(v) {
		var c = Object.assign({ lock: 'Locked' }, ch);
		c[metric === 'power' ? 'power_dbmv' : 'snr_db'] = String(v);
		var got = H.channelVerdict(c, usN).checks.filter(function(x) { return x.metric === metric; })[0];
		eq(got && got.level, expectBand(v, limit), name + ' ' + metric + ' ' + v);
	});
}
testChannel('ds SC-QAM', { dir: 'ds', modulation: '256QAM', snr_db: '40' }, 'power', H.LIMITS.ds_power);
testChannel('ds SC-QAM', { dir: 'ds', modulation: '256QAM', power_dbmv: '0' }, 'snr', H.LIMITS.ds_snr);
testChannel('ds SC-QAM at -8 dBmV', { dir: 'ds', modulation: '256QAM', power_dbmv: '-8' }, 'snr', H.LIMITS.ds_snr_low_power);
eq(H.channelVerdict({ dir: 'ds', lock: 'Locked', modulation: '256QAM', power_dbmv: '-6', snr_db: '31' }).level, 'marginal', 'SNR 31 dB at -6 dBmV uses the normal minimum (marginal)');
eq(H.channelVerdict({ dir: 'ds', lock: 'Locked', modulation: '256QAM', power_dbmv: '-6.1', snr_db: '31' }).level, 'bad', 'SNR 31 dB below -6 dBmV is under the raised minimum (bad)');
testChannel('ds OFDM', { dir: 'ds', modulation: 'OFDM PLC', snr_db: '44' }, 'power', H.LIMITS.ds_power_ofdm);
testChannel('ds OFDM', { dir: 'ds', modulation: 'OFDM PLC', power_dbmv: '0' }, 'snr', H.LIMITS.ds_mer_ofdm);
testChannel('us OFDMA', { dir: 'us', modulation: 'OFDMA' }, 'power', H.LIMITS.us_power_ofdma);
[ 1, 2, 3, 4 ].forEach(function(n) {
	testChannel('us SC-QAM with ' + n + ' channel(s)', { dir: 'us', modulation: 'SC-QAM' }, 'power', H.LIMITS.us_power_by_channels[n], n);
});

/* --------------------------------------------------- a gateway's radios */
[ 'lte', 'nr' ].forEach(function(tech) {
	[ [ 'rsrp', 'rsrp_dbm' ], [ 'rsrq', 'rsrq_db' ], [ 'sinr', 'sinr_db' ] ].forEach(function(m) {
		var limit = H.LIMITS[tech + '_' + m[0]];
		edges(limit).forEach(function(v) {
			var r = { tech: tech, rsrp_dbm: '-80', rsrq_db: '-8', sinr_db: '25' };
			r[m[1]] = String(v);
			var got = H.radioVerdict(r).checks.filter(function(x) { return x.metric === m[0]; })[0];
			eq(got && got.level, expectBand(v, limit), tech + ' ' + m[0] + ' ' + v);
		});
	});
});
['lte_rsrp', 'lte_rsrq', 'lte_sinr', 'nr_rsrp', 'nr_rsrq', 'nr_sinr'].forEach(function(k) {
	var L = H.LIMITS[k];
	ok(L.sources.indexOf('teltonika_signal') >= 0 && L.sources.some(function(s) { return H.SOURCES[s].kind === 'spec'; }) &&
		L.sources.every(function(s) { return H.SOURCES[s].kind !== 'spec' || /reporting range/.test(H.SOURCES[s].title); }),
		k + ': graded by vendor guidance; the only spec cited is the 3GPP reporting range');
});
eq([ H.radioVerdict({ tech: 'nr', rsrp_dbm: '-89' }).level, H.radioVerdict({ tech: 'nr', rsrp_dbm: '-95' }).level,
	H.radioVerdict({ tech: 'nr', rsrp_dbm: '-101' }).level, H.radioVerdict({ tech: 'nr', sinr_db: '0' }).level,
	H.radioVerdict({ tech: 'lte', rsrq_db: '-20' }).level ],
	[ 'good', 'marginal', 'bad', 'bad', 'bad' ], 'radio: Teltonika\'s grades (-90/-100 dBm RSRP; SINR 0 and RSRQ -20 dB are poor)');
eq(H.radioVerdict({ tech: 'nr', rsrp_dbm: '', rsrq_db: '', sinr_db: '', rssi_dbm: '-60', bars: '1' }).level, 'unknown',
	'radio: no judged value (stored empty because out of the 3GPP range) is unknown, not good; RSSI and bars are not judged');
var gwReading = { result: 'ok', connectivity: 'registered' };
var goodR = { tech: 'nr', bands: 'n41', rsrp_dbm: '-85', rsrq_db: '-10', sinr_db: '20' };
eq(H.readingVerdict(gwReading, [], null, [ goodR ]).level, 'healthy', 'gateway: a good radio on a registered gateway is healthy');
var weak = H.readingVerdict(gwReading, [], null, [ goodR, { tech: 'lte', bands: 'b66', rsrp_dbm: '-110', rsrq_db: '-12', sinr_db: '5' } ]);
eq([ weak.level, weak.reasons.map(function(r) { return r.kind + ':' + r.level; }) ], [ 'failing', [ 'lte_rsrp:bad', 'lte_sinr:marginal' ] ],
	'gateway: a weak 4G radio fails the reading, worst reason first');
eq(H.readingVerdict(gwReading, [], null, []).reasons.map(function(r) { return r.kind; }), [ 'no_radio' ], 'gateway: no radio connected is failing');
eq(H.readingVerdict({ result: 'ok', connectivity: 'searching' }, [], null, [ goodR ]).reasons.map(function(r) { return r.kind + ':' + r.detail; }),
	[ 'not_registered:searching' ], 'gateway: not registered on the network is failing');
eq(H.readingVerdict({ result: 'ok', connectivity: 'registered' }, [ { dir: 'ds', lock: 'Locked', power_dbmv: '0', snr_db: '40' } ]).reasons.map(function(r) { return r.kind; }),
	[ 'not_operational' ], 'a cable modem reading is judged as before (radios not given)');
eq(H.readingVerdict({ result: 'failed', reason: 'timeout' }, [], null, [ goodR ]).level, 'unknown', 'gateway: a failed reading is unknown, never judged');
eq([ 'Tower change on 5G: 1588321-141 to 1777001-141', 'Band change on 4G: b2 to b66', '5G radio no longer connected', 'Tower change at the modem' ].map(H.classifyEvent),
	[ 'cell_change', 'band_change', 'radio_lost', 'other' ], 'events: the gateway events Modem Health writes are recognised, nothing else');
ok(H.DISRUPTIVE.cell_change && H.DISRUPTIVE.radio_lost && !H.DISRUPTIVE.band_change, 'events: tower changes and lost radios count as disruptions; band changes do not');
var pv = H.periodVerdict({ hours: 24, readings: [ { level: 'healthy' } ],
	events: [ 1, 2, 3 ].map(function() { return { kind: 'cell_change' }; }).concat([ { kind: 'radio_lost' } ]) });
eq(pv.reasons.map(function(r) { return r.kind + ':' + r.level; }).sort(), [ 'cell_change:marginal', 'radio_lost:marginal' ],
	'period: 3 tower changes and a lost radio in a day are marginal');
eq(H.periodVerdict({ hours: 24, readings: [ { level: 'healthy' } ], events: [ { kind: 'cell_change' }, { kind: 'cell_change' }, { kind: 'band_change' } ] }).level,
	'healthy', 'period: two tower changes a day (gateways report brief false ones) and band changes are not held against the line');

/* --------------------------------------------------------- lock and gaps */
eq(H.channelVerdict({ dir: 'ds', lock: 'Not Locked', modulation: '256QAM', power_dbmv: '0', snr_db: '40' }).level, 'bad', 'an unlocked channel is bad');
eq(H.channelVerdict({ dir: 'ds', lock: 'Locked', modulation: '256QAM', power_dbmv: '', snr_db: '' }).checks, [], 'missing values are not judged');
eq(H.readingVerdict({ result: 'failed', reason: 'unreachable' }, []).level, 'unknown', 'a failed reading is unknown, never healthy');

/* ------------------------------------------------- the real S34 capture */
function csvChannels(dir, raw) {
	return raw.split('|+|').filter(Boolean).map(function(r) {
		var f = r.split('^').map(function(s) { return s.trim(); });
		return dir === 'ds'
			? { dir: 'ds', ch: f[0], lock: f[1], modulation: f[2], channel_id: f[3], freq_hz: f[4], power_dbmv: f[5], snr_db: f[6], corrected: f[7], uncorrectable: f[8] }
			: { dir: 'us', ch: f[0], lock: f[1], modulation: f[2], channel_id: f[3], width_hz: f[4], freq_hz: f[5], power_dbmv: f[6] };
	});
}
var fx = path.join(ROOT, 'tests/fixtures/s34');
var cs = JSON.parse(fs.readFileSync(path.join(fx, 'cmconnectionstatus.json'), 'utf8')).GetMultipleHNAPsResponse;
var channels = csvChannels('ds', cs.GetCustomerStatusDownstreamChannelInfoResponse.CustomerConnDownstreamChannel)
	.concat(csvChannels('us', cs.GetCustomerStatusUpstreamChannelInfoResponse.CustomerConnUpstreamChannel));
var reading = { result: 'ok', connectivity: 'Operational' };
var rv = H.readingVerdict(reading, channels);

var dsLevels = rv.channels.filter(function(v) { return v.channel.dir === 'ds'; }).map(function(v) { return v.level; });
ok(dsLevels.length === 34 && dsLevels.every(function(l) { return l === 'good'; }), 'S34: all 34 downstream channels good (power -1.4..+2.2 dBmV, SNR 40.4..44.6 dB)');
var usScqam = rv.channels.filter(function(v) { return v.channel.dir === 'us' && v.channel.modulation === 'SC-QAM'; });
ok(usScqam.length === 4 && usScqam.every(function(v) { return v.level === 'marginal'; }), 'S34: the 4 upstream SC-QAM channels at 50.0-50.8 dBmV are marginal');
var ofdma = rv.channels.filter(function(v) { return v.channel.modulation === 'OFDMA'; })[0];
eq(ofdma.level, 'good', 'S34: upstream OFDMA at 44.5 dBmV is judged by its own limit and is good');
eq(rv.level, 'degraded', 'S34: the reading is degraded (marginal upstream power)');
ok(rv.reasons[0].kind === 'us_power', 'S34: the first reason is upstream power');

var log = JSON.parse(fs.readFileSync(path.join(fx, 'cmeventlog.json'), 'utf8')).GetCustomerStatusLogResponse.CustomerStatusLogList;
var events = H.parseModemLog(log);
var kinds = {};
events.forEach(function(e) { kinds[e.kind] = (kinds[e.kind] || 0) + 1; });
eq(events.length, 100, 'S34 log: 100 entries parsed');
eq([ kinds.sync_loss, kinds.t3, kinds.t4, kinds.mdd_loss, kinds.login ], [ 13, 1, 1, 3, 13 ], 'S34 log: 13 losses of sync, 1 T3, 1 T4, 3 lost MDD, 13 web logins');
eq(events[events.length - 1].time, '11/19/2026 12:06:13', 'S34 log: oldest entry time');

var regs = H.reregistrations(events);
eq(regs.map(function(r) { return r.time; }), [ '11/19/2026 12:28:58', '11/19/2026 13:32:01' ],
	'S34 log: two re-registrations (12:29 and 13:32), each made of several entries');
eq(H.reregistrations([ { modem_time: '11/19/2026 10:00:00', message: 'REG-RSP-MP Mismatch' },
	{ modem_time: '11/19/2026 10:05:00', message: 'REG-RSP-MP Mismatch' } ]).length, 2, 're-registrations more than two minutes apart are counted apart');

/* The log covers 12:06:13 to 14:13:54: just over two hours. */
var pv = H.periodVerdict({
	hours: (2 * 3600 + 7 * 60 + 41) / 3600,
	readings: [ { level: rv.level } ],
	events: events.filter(function(e) { return e.kind !== 'login'; })
});
eq(pv.level, 'failing', 'S34: the two hours of the capture are failing');
ok(pv.reasons.some(function(r) { return r.kind === 'sync_loss' && r.level === 'bad'; }), 'S34: losses of sync are a reason');
ok(pv.reasons.some(function(r) { return r.kind === 't4'; }), 'S34: the T4 time-out is a reason');

/* ------------------------------------------------------------- outages */
function R(ts, inet, modem, extra) { return Object.assign({ ts: String(ts), result: 'ok', inet_ping_loss: String(inet), modem_ping_loss: String(modem) }, extra || {}); }
var T = 1795000000;
var o = H.outages([ R(T, 0, 0), R(T + 300, 100, 0), R(T + 600, 100, 0), R(T + 900, 0, 0) ]);
eq(o.length, 1, 'outages: two consecutive down checks are one outage');
eq([ o[0].start, o[0].end, o[0].before, o[0].after, o[0].minS, o[0].maxS, o[0].checks, o[0].kind, o[0].ongoing ],
	[ T + 300, T + 600, T, T + 900, 300, 900, 2, 'line_down', false ],
	'outages: lasted at least 5 and at most 15 minutes (between the good checks around it); modem answered: line down');
eq(H.outages([ R(T, 0, 0), R(T + 300, 33, 0), R(T + 600, 67, 0), R(T + 900, 0, 0) ]).length, 0, 'outages: one or two lost pings are not an outage');
o = H.outages([ R(T, 0, 0), R(T + 300, 100, 100, { result: 'failed', reason: 'unreachable' }), R(T + 600, 100, 0) ]);
eq([ o.length, o[0].kind, o[0].ongoing, o[0].after, o[0].maxS ], [ 1, 'modem_unreachable', true, null, null ],
	'outages: the modem stopped answering too: modem unreachable; still down at the last check: ongoing, end unknown');
o = H.outages([ R(T, 0, 0), R(T + 300, 100, 0), R(T + 300 + 7200, 100, 0), R(T + 7800, 0, 0) ]);
eq(o.map(function(x) { return [ x.start, x.end, x.ongoing ]; }), [ [ T + 300, T + 300, false ], [ T + 7500, T + 7500, false ] ],
	'outages: two hours without checks in between: counted as two outages, not one long one');
eq([ o[1].before, o[1].maxS ], [ null, null ], 'outages: no good check shortly before: the longest duration is unknown');
eq(H.outages([ R(T, 0, 0), R(T + 300, '', '', { result: 'failed', reason: 'no_password' }) ]).length, 0,
	'outages: a check without ping results is not an outage');
eq(H.outages([ R(T + 600, 0, 0), R(T + 300, 100, 0), R(T, 0, 0) ]).length, 1, 'outages: readings in any order');

/* The backend's awk (outages_csv, for the copy on a drive) is held to the
 * same answers: see tests/fixtures/outages. */
var fx = fs.readFileSync(path.join(ROOT, 'tests/fixtures/outages/readings.csv'), 'utf8').split('\n').filter(Boolean);
var cols = fx[0].split(',');
var fxRows = fx.slice(1).map(function(l) { var f = l.split(','), r = {}; cols.forEach(function(c, i) { r[c] = f[i] != null ? f[i] : ''; }); return r; });
eq(H.outages(fxRows).map(function(x) { return { start: x.start, end: x.end, kind: x.kind, checks: x.checks, minS: x.minS, maxS: x.maxS, ongoing: x.ongoing }; }),
	JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/outages/expected.json'), 'utf8')), 'outages: the fixture shared with the backend gives the expected five');

/* --------------------------------------------------- quiet line is healthy */
var quiet = H.periodVerdict({ hours: 24 * 7, readings: new Array(2016).fill({ level: 'healthy' }), events: [], reboots: 0, outages: [] });
eq(quiet.level, 'healthy', 'a week of good readings with no events is healthy');
eq(H.periodVerdict({ hours: 24, readings: [ { level: 'unknown' } ], events: [] }).level, 'unknown', 'only failed readings: unknown, not healthy');

/* ----------------------------------------------- limits from the settings */
var none = H.applySettings(function() { return ''; });
eq([ none.changed.length, JSON.stringify(none.limits) === JSON.stringify(H.LIMITS) ], [ 0, true ], 'settings: empty settings leave every default');
eq(H.limitList().length, 25, 'settings: 25 limits with bounds (us_power_1 ... us_power_4 and the 4G/5G ones among them)');
ok(H.limitList().every(function(it) { return H.limitFields(it.key, it.limit).length > 0; }), 'settings: each has at least one bound to set');
eq(H.limitFields('ds_snr', H.LIMITS.ds_snr).map(function(f) { return f.option; }), [ 'ds_snr_good_min', 'ds_snr_acceptable_min' ],
	'settings: a limit without an upper bound gets none');
eq(H.limitFields('share_readings_failing', H.LIMITS.share_readings_failing).map(function(f) { return f.value; }), [ 0, 5 ],
	'settings: shares are set as percentages');
var set = { ds_power_good_min: '-5', ds_power_good_max: '7', us_power_4_acceptable_max: '53', share_readings_failing_acceptable_max: '10', t3_per_day_good_max: 'x' };
var mine = H.applySettings(function(o) { return set[o]; });
eq(mine.changed.map(function(c) { return c.key; }), [ 'ds_power', 'us_power_4', 'share_readings_failing' ],
	'settings: changed limits listed; a value equal to the default or not a number changes nothing');
eq([ mine.limits.ds_power.good, mine.limits.ds_power.default.good, mine.limits.ds_power.sources ], [ [ -5, 7 ], [ -7, 7 ], [ 'settings' ] ],
	'settings: a changed limit cites the settings and keeps the default for the report');
eq([ mine.limits.us_power_by_channels[4].marginal[1], mine.limits.share_readings_failing.marginal[1], H.LIMITS.ds_power.good[0] ], [ 53, 0.1, -7 ],
	'settings: upstream by channel count and shares applied; the defaults themselves untouched');
eq([ H.channelVerdict({ dir: 'ds', power_dbmv: '-6', snr_db: '40' }).level, H.channelVerdict({ dir: 'ds', power_dbmv: '-6', snr_db: '40' }, 1, mine.limits).level ],
	[ 'good', 'marginal' ], 'settings: verdicts use the changed limits');
ok(H.SOURCES.settings.judgement, 'settings: the settings source is marked as judgement');

/* ------------------------------------- speed tests (ISPy) and the line */
/* Checks every 300 s from 10000; a window of 300 s around each test. */
var W = 300, chk = function(ts, level) { return { ts: ts, level: level }; };
var lineOf = {
	windowS: W,
	readings: [ chk(10000, 'healthy'), chk(10300, 'healthy'), chk(10600, 'degraded'), chk(10900, 'healthy'), chk(11200, 'failing'), chk(11500, 'healthy'),
		chk(11800, 'healthy'), chk(12100, 'unknown'), chk(12400, 'unknown'), chk(12700, 'healthy'), chk(13000, 'healthy'),
		chk(20000, 'unknown'), chk(30000, 'healthy'), chk(30300, 'healthy'), chk(40000, 'failing'), chk(40300, 'failing'), chk(60000, 'failing') ],
	events: [ { ts: 12850, kind: 'sync_loss' }, { ts: 30100, kind: 'registration' }, { ts: 30150, kind: 'login' }, { ts: 50000, kind: 't3' } ],
	outages: [ { start: 12100, end: 12400 }, { start: 40000, end: 40300 } ]
};
var PLAN = { down: 1000, up: 40 }, okT = function(ts, down, up) { return { ts: ts, status: 'ok', down: down, up: up }; };
var one = function(t, plan) { return H.speedTests([ t ], plan === undefined ? PLAN : plan, lineOf).tests[0]; };
eq([ one(okT(10100, 990, 39)).line, one(okT(10100, 990, 39)).group ], [ 'clear', 'fine' ], 'speed: a test between two good checks: nothing recorded, not slow');
eq([ one(okT(10400, 990, 39)).line, one(okT(10800, 990, 39)).line ], [ 'marginal', 'marginal' ], 'speed: a marginal check before or after the test: outside the good range, told apart from a problem');
eq([ one(okT(11100, 990, 39)).line, one(okT(11400, 990, 39)).line ], [ 'out_of_spec', 'out_of_spec' ], 'speed: an out-of-spec check before or after the test');
eq([ one(okT(60000 - W - 1, 990, 39)).line, one(okT(60000 - W, 990, 39)).line, one(okT(60000 + W, 990, 39)).line, one(okT(60000 + W + 1, 990, 39)).line ],
	[ 'unknown', 'out_of_spec', 'out_of_spec', 'unknown' ], 'speed: the window is the time between two checks, its ends included');
eq([ one(okT(12100 - W, 990, 39)).line, one(okT(12100 - W - 1, 990, 39)).line, one(okT(12250, 990, 39)).line, one(okT(12400 + W, 990, 39)).line ],
	[ 'outage', 'clear', 'outage', 'outage' ], 'speed: within the window of an outage\'s first or last failing check: during the outage');
eq(one(okT(12400 + W + 1, 990, 39)).line, 'events', 'speed: just after the outage\'s window, with a loss of sync in the log close by: events');
eq([ one(okT(12850 + W, 990, 39)).line, one(okT(12850 + W + 1, 990, 39)).line ], [ 'events', 'clear' ], 'speed: a log entry counts within the same window');
eq([ one(okT(30100, 990, 39)).line, one(okT(50000, 990, 39)).line ], [ 'clear', 'events' ],
	'speed: a registration or login entry is not a problem; a time-out is, even with no check near it');
eq([ one(okT(20000, 990, 39)).line, one(okT(25000, 990, 39)).line ], [ 'unknown', 'unknown' ],
	'speed: only a check that could not read the modem, or no check at all: not known, never good');
eq(one(okT(40100, 990, 39)).line, 'outage', 'speed: the worst of what applies is the one counted (outage before signal values)');
eq([ one(okT(10100, 799.9, 39)).group, one(okT(10100, 800, 39)).group, one(okT(10100, 990, 31.9)).group, one(okT(10100, 990, 32)).group ],
	[ 'slow', 'fine', 'slow', 'fine' ], 'speed: slow is below 80% of the advertised speed, in either direction; exactly 80% is not slow');
var both = one(okT(10100, 500, 20));
eq([ both.slowDown, both.slowUp, both.downShare, both.upShare ], [ true, true, 0.5, 0.5 ], 'speed: each direction says whether it was slow, and its share of the advertised speed');
eq([ one(okT(10100, 500, 20), { down: 1000, up: null }).slowUp, one(okT(10100, 990, 20), { down: 1000, up: null }).group, one(okT(10100, 500, 20), {}).group, one(okT(10100, 500, 20), null).group ],
	[ false, 'fine', 'unjudged', 'unjudged' ], 'speed: a direction with no advertised speed is not judged; with none at all no test is called slow or not');
var failedTest = one({ ts: 12250, status: 'error', down: 3, up: 1 });
eq([ failedTest.group, failedTest.line, failedTest.down, failedTest.slowDown ], [ 'failed', 'outage', null, undefined ], 'speed: a test that did not complete is failed, never slow, and has no speed');
var many = H.speedTests([ okT(40100, 100, 39), okT(10100, 990, 39), okT(11100, 700, 39), okT(10400, 500, 39), okT(25000, 500, 39), okT(12850, 990, 39),
	{ ts: 12250, status: 'error' }, { ts: 10100, status: 'skipped' }, { ts: 'x', status: 'ok', down: 1, up: 1 }, okT(10110, 990, 10) ], PLAN, lineOf);
eq(many.tests.map(function(t) { return t.ts; }), [ 10100, 10110, 10400, 11100, 12250, 12850, 25000, 40100 ], 'speed: oldest first; skipped tests and rows without a time are left out');
eq([ many.n, many.counts.slow, many.counts.fine, many.counts.failed, many.counts.unjudged.total ], [ 8,
	{ total: 5, problem: 2, outage: 1, events: 0, out_of_spec: 1, marginal: 1, clear: 1, unknown: 1 },
	{ total: 2, problem: 1, outage: 0, events: 1, out_of_spec: 0, marginal: 0, clear: 1, unknown: 0 },
	{ total: 1, problem: 1, outage: 1, events: 0, out_of_spec: 0, marginal: 0, clear: 0, unknown: 0 }, 0 ],
	'speed: counted by group and by what the modem recorded; a line problem is an outage, events or a value out of spec');
ok([ 'slow', 'fine', 'failed', 'unjudged' ].every(function(g) {
	var c = many.counts[g];
	return H.LINE_STATES.reduce(function(s2, k) { return s2 + c[k]; }, 0) === c.total && c.problem === c.outage + c.events + c.out_of_spec;
}), 'speed: every test is counted exactly once');
eq([ H.speedTests([], PLAN, lineOf).n, H.speedTests(null, PLAN, { windowS: W }).n, H.speedTests([ okT(1, 1, 1) ], PLAN, {}).tests[0].line ], [ 0, 0, 'unknown' ],
	'speed: no tests, or no history at all, is not an error');

/* ------------------------------------------------ automatic restarts -- */
/* The backend judges "outside the acceptable range" itself (signal_signs,
 * for automatic restarts). Its table of bounds must be health.js's, and
 * both are held to tests/fixtures/restart/signal.json (the backend in
 * tests/backend.test.py). */
(function() {
	var backend = fs.readFileSync(path.join(__dirname, '..', 'luci-app-modemhealth/root/usr/bin/modemhealth'), 'utf8');
	var table = /^ACCEPTABLE='([^']*)'/m.exec(backend)[1].split('\n').map(function(l) { return l.split(' '); });
	var want = H.limitList().filter(function(it) { return /^(ds_|us_)/.test(it.key); }).map(function(it) {
		var g = it.limit.good, m = it.limit.marginal, b = function(v) { return v == null ? '-' : String(v); };
		return [ it.key, b(g[0]), b(g[1]), b(m[0]), b(m[1]) ];
	});
	eq(table, want, 'restarts: the backend\'s good and acceptable ranges are health.js\'s');
	eq(+/^LOW_POWER_BELOW=(-?\d+)/m.exec(backend)[1], H.LIMITS.ds_snr_low_power.below_power, 'restarts: the same power below which the higher SNR minimum applies');
	var fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/restart/signal.json'), 'utf8'));
	fx.cases.forEach(function(c) {
		var limits = H.applySettings(function(k) { return (c.limits || {})[k]; }).limits;
		var usN = c.channels.filter(function(ch) { return ch.dir === 'us' && !/OFDM/i.test(ch.modulation); }).length;
		var locked = function(ch) { return !ch.lock || /^locked$/i.test(ch.lock); };
		var out = c.channels.filter(function(ch) {
			return H.channelVerdict(ch, usN, limits).checks.some(function(x) { return x.metric !== 'lock' && x.level === H.BAD; });
		}).length;
		eq([ c.channels.filter(function(ch) { return !locked(ch); }).length, out,
			c.channels.filter(function(ch) { return ch.dir === 'ds' && locked(ch); }).length ], c.expect, 'restarts fixture: ' + c.name);
	});
})();

console.log(fail ? '\n' + fail + ' check(s) failed' : '\nall checks passed');
process.exit(fail ? 1 : 0);
