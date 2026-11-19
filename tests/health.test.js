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

/* The log covers 12:06:13 to 14:13:54: just over two hours. */
var pv = H.periodVerdict({
	hours: (2 * 3600 + 7 * 60 + 41) / 3600,
	readings: [ { level: rv.level } ],
	events: events.filter(function(e) { return e.kind !== 'login'; })
});
eq(pv.level, 'failing', 'S34: the two hours of the capture are failing');
ok(pv.reasons.some(function(r) { return r.kind === 'sync_loss' && r.level === 'bad'; }), 'S34: losses of sync are a reason');
ok(pv.reasons.some(function(r) { return r.kind === 't4'; }), 'S34: the T4 time-out is a reason');

/* --------------------------------------------------- quiet line is healthy */
var quiet = H.periodVerdict({ hours: 24 * 7, readings: new Array(2016).fill({ level: 'healthy' }), events: [], reboots: 0, outages: [] });
eq(quiet.level, 'healthy', 'a week of good readings with no events is healthy');
eq(H.periodVerdict({ hours: 24, readings: [ { level: 'unknown' } ], events: [] }).level, 'unknown', 'only failed readings: unknown, not healthy');

console.log(fail ? '\n' + fail + ' check(s) failed' : '\nall checks passed');
process.exit(fail ? 1 : 0);
