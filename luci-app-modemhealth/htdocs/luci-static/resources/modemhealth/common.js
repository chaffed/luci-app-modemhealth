'use strict';
'require baseclass';
'require rpc';
'require modemhealth.health as health';

/*
 * Modem Health - data loading, formatting and charts shared by the pages.
 *
 * Note on E(): LuCI assigns a bare string child via innerHTML. Anything
 * that comes from the modem or the stored files is therefore always passed
 * as an array child ([ text ]), which LuCI appends as a text node. Strings
 * passed to .format() write a literal percent sign as %%.
 *
 * SPDX-License-Identifier: MIT
 */

var callStatus = rpc.declare({ object: 'luci.modemhealth', method: 'status' });
var callData = rpc.declare({ object: 'luci.modemhealth', method: 'data', params: [ 'since', 'until' ] });
var callCheck = rpc.declare({ object: 'luci.modemhealth', method: 'check' });
var callTest = rpc.declare({ object: 'luci.modemhealth', method: 'test', params: [ 'host', 'username', 'password' ] });
var callSetPassword = rpc.declare({ object: 'luci.modemhealth', method: 'set_password', params: [ 'password' ] });
var callExport = rpc.declare({ object: 'luci.modemhealth', method: 'export' });
var callClear = rpc.declare({ object: 'luci.modemhealth', method: 'clear' });
var callRestart = rpc.declare({ object: 'luci.modemhealth', method: 'restart' });

var SVGNS = 'http://www.w3.org/2000/svg';

var C = {
	good: '#3fa66b', marginal: '#d99a1c', bad: '#d9534f', unknown: '#888888',
	healthy: '#3fa66b', degraded: '#d99a1c', failing: '#d9534f',
	series: [ '#2f7ed8', '#e8743b', '#8e44ad', '#16a085', '#c0392b', '#7f8c8d', '#2c3e50', '#d35400' ]
};

/* ---------------------------------------------------------------- data -- */

function parseCSV(text) {
	var lines = String(text || '').split('\n').filter(function(l) { return l.length; });
	if (!lines.length) return [];
	var head = lines[0].split(',');
	return lines.slice(1).map(function(l) {
		var f = l.split(','), o = {};
		head.forEach(function(h, i) { o[h] = f[i] != null ? f[i] : ''; });
		return o;
	});
}

/* When an event happened, on the router's clock: the modem's own time
 * (its local time) corrected by the offset measured when the event was
 * first seen. Falls back to when the router first saw it if the modem's
 * clock was not set yet (it starts at 1970 until the ISP sets it). */
function eventTime(e) {
	var m = /^(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+)$/.exec(String(e.modem_time || '').trim());
	var off = health.num(e.clock_offset_s), seen = +e.first_seen_ts;
	if (!m || +m[3] < 2000 || off == null) return seen;
	var local = new Date(+m[3], m[1] - 1, +m[2], +m[4], +m[5], +m[6]).getTime() / 1000;
	var ts = Math.round(local - off);
	/* An event cannot happen after the router first saw it. */
	return ts > seen + 60 ? seen : ts;
}

/* The line-up (position, modulation, frequency, width) of a channel at a
 * time: the latest entry stored at or before it. A channel's entry changes
 * (one that lost lock reports no modulation), so a row is joined to the
 * line-up of its own moment, not to the newest. */
function lineUp(text) {
	var by = {};
	parseCSV(text).forEach(function(m) {
		var k = m.dir + ',' + m.channel_id;
		(by[k] = by[k] || []).push(m);
	});
	Object.keys(by).forEach(function(k) { by[k].sort(function(a, b) { return a.ts - b.ts; }); });
	return function(dir, id, ts) {
		var list = by[dir + ',' + id], m = null;
		if (!list) return {};
		for (var i = 0; i < list.length && +list[i].ts <= +ts; i++) m = list[i];
		return m || list[0];
	};
}

/* ISPy's speed tests, as the backend passes them on (see speed_rows
 * there), or null when ISPy has none. A test is credited, as in ISPy, with
 * the higher of what the test measured and the traffic counted on the WAN
 * port while it ran; a test that failed has no speed.
 * -> { planDown, planUp (Mbit/s or null), tests: [ { ts, status, down, up } ] } */
function speedData(sp) {
	if (!sp || !sp.tests) return null;
	var plan = function(v) { var n = health.num(v); return n != null && n > 0 ? n : null; };
	var best = function(a, b) { a = health.num(a); b = health.num(b); return a == null ? b : (b == null ? a : Math.max(a, b)); };
	return { planDown: plan(sp.plan_down), planUp: plan(sp.plan_up), tests: parseCSV(sp.tests).map(function(t) {
		var ok = t.status === 'ok';
		return { ts: +t.ts, status: t.status, down: ok ? best(t.down_mbps, t.wan_down_mbps) : null, up: ok ? best(t.up_mbps, t.wan_up_mbps) : null };
	}).filter(function(t) { return t.ts > 0 && (t.status === 'error' || (t.down != null && t.up != null)); }) };
}

/* What the backend's data command returns, joined up: channels carry
 * their position, modulation, frequency and width from the line-up, events
 * their kind and their time on the router's clock. */
function assemble(d) {
	var at = lineUp(d.channelmap);
	var channels = parseCSV(d.channels).map(function(c) {
		var m = at(c.dir, c.channel_id, c.ts);
		c.ch = m.ch; c.modulation = m.modulation; c.freq_hz = m.freq_hz; c.width_hz = m.width_hz;
		return c;
	});
	var byTs = {};
	channels.forEach(function(c) { (byTs[c.ts] = byTs[c.ts] || []).push(c); });
	var events = parseCSV(d.events).map(function(e) {
		e.kind = health.classifyEvent(e.message);
		e.ts = eventTime(e);
		return e;
	});
	var radios = parseCSV(d.radios), radiosAt = {};
	radios.forEach(function(r) { (radiosAt[r.ts] = radiosAt[r.ts] || []).push(r); });
	var restarts = parseCSV(d.restarts).map(function(r) { r.ts = +r.ts; return r; });
	return { readings: parseCSV(d.readings), channels: channels, channelsAt: byTs, radios: radios, radiosAt: radiosAt,
		events: events, restarts: restarts, speed: speedData(d.speed) };
}

/* A reading of a T-Mobile gateway rather than a cable modem: it has radios,
 * or (no radio connected at all) no channels and a cellular registration
 * state. */
function isGateway(r, D) {
	if ((D.radiosAt || {})[r.ts]) return true;
	return !(D.channelsAt || {})[r.ts] && /registered|searching|denied/i.test(r.connectivity || '') && !/operational/i.test(r.connectivity || '');
}

/* readingVerdict with a gateway's radios when the reading is a gateway's. */
function verdictOf(r, D, limits) {
	return isGateway(r, D)
		? health.readingVerdict(r, [], limits, (D.radiosAt || {})[r.ts] || [])
		: health.readingVerdict(r, (D.channelsAt || {})[r.ts] || [], limits);
}

/* The speed tests of several pieces of a period as one. */
function addSpeed(all, sp) {
	if (!sp) return all;
	if (!all) return { planDown: sp.planDown, planUp: sp.planUp, tests: sp.tests.slice() };
	sp.tests.forEach(function(t) { all.tests.push(t); });
	return all;
}

/* A ubus reply fails somewhere between 1 and 2 MB, and a check stores
 * about 1.4 KB, so a period is asked for in pieces of 250 checks (about
 * 350 KB, 21 hours at 5-minute checks). */
function pieces(since, until, intervalMin) {
	var step = Math.max(3600, (intervalMin || 5) * 60 * 250), out = [];
	for (var a = since; a <= until; a += step)
		out.push([ a, Math.min(a + step - 1, until) ]);
	return out;
}

/* The restarts file is one file, not one per day: every piece of a period
 * gets the rows of its own time, but keep each once, oldest first. */
function uniqueRestarts(rows) {
	var seen = {};
	return rows.filter(function(r) { var k = r.ts + ',' + r.trigger + ',' + r.result; if (seen[k]) return false; seen[k] = 1; return true; })
		.sort(function(a, b) { return a.ts - b.ts; });
}

function inPeriod(since, until) {
	return function(e) { return e.ts >= since && e.ts <= until; };
}

/* Everything stored between since and until (epoch seconds), joined up and
 * kept whole: for the Overview's tables, charts and CSV files (days, not
 * months; see loadDigest). LuCI sends the pieces as one request. */
function load(since, until, intervalMin) {
	return Promise.all(pieces(since, until, intervalMin).map(function(p) { return callData(p[0], p[1]); })).then(function(parts) {
		var join = function(k) {
			return parts.map(function(p, i) {
				var t = String((p || {})[k] || '');
				return i ? t.slice(t.indexOf('\n') + 1) : t;
			}).join('');
		};
		var D = assemble({ readings: join('readings'), channels: join('channels'), events: join('events'), radios: join('radios'),
			restarts: join('restarts'), channelmap: join('channelmap') });
		D.speed = parts.reduce(function(all, p) { return addSpeed(all, speedData((p || {}).speed)); }, null);
		D.since = since; D.until = until;
		D.events = D.events.filter(inPeriod(since, until)).sort(function(a, b) { return a.ts - b.ts; });
		D.restarts = uniqueRestarts(D.restarts.filter(inPeriod(since, until)));
		D.readings.sort(function(a, b) { return a.ts - b.ts; });
		return D;
	});
}

/* One piece of a period reduced to what a report needs: every reading
 * keeps its verdict and a few figures for the charts, every channel a
 * tally, and the channel rows themselves are let go. */
function reduce(G, P) {
	P.readings.forEach(function(r) {
		var v = verdictOf(r, P, G.limits);
		var a = { dsPowerMin: null, dsPowerMax: null, snrMin: null, merMin: null, us: {}, unc: null, corr: null, unlocked: 0, radio: {} };
		if (isGateway(r, P)) G.gateway = true;
		/* A gateway's radios: the figures for the charts, and a tally per
		 * radio (4G, 5G). */
		(v.radios || []).forEach(function(rv) {
			var x = rv.radio, t = G.radios[x.tech];
			var nums = { rsrp: health.num(x.rsrp_dbm), rsrq: health.num(x.rsrq_db), sinr: health.num(x.sinr_db), rssi: health.num(x.rssi_dbm) };
			a.radio[x.tech] = nums;
			if (!t) t = G.radios[x.tech] = { tech: x.tech, n: 0, marginal: 0, bad: 0, bands: {}, cells: {} };
			t.n++;
			if (rv.level === health.MARGINAL) t.marginal++;
			if (rv.level === health.BAD) t.bad++;
			if (x.bands) t.bands[x.bands] = (t.bands[x.bands] || 0) + 1;
			if (x.cell) t.cells[x.cell] = (t.cells[x.cell] || 0) + 1;
			Object.keys(nums).forEach(function(k) {
				var val = nums[k];
				if (val == null) return;
				if (t[k + 'Min'] == null || val < t[k + 'Min']) t[k + 'Min'] = val;
				if (t[k + 'Max'] == null || val > t[k + 'Max']) t[k + 'Max'] = val;
			});
		});
		var low = function(k, x) { if (x != null && (a[k] == null || x < a[k])) a[k] = x; };
		v.channels.forEach(function(cv) {
			var c = cv.channel, ofdm = /OFDM/.test(c.modulation || ''), p = health.num(c.power_dbmv), q = health.num(c.snr_db);
			var unc = health.num(c.uncorrectable), corr = health.num(c.corrected);
			var locked = !c.lock || /^locked$/i.test(c.lock);
			if (!locked) a.unlocked++;
			if (c.dir === 'ds') {
				if (!ofdm) {
					low('dsPowerMin', p);
					if (p != null && (a.dsPowerMax == null || p > a.dsPowerMax)) a.dsPowerMax = p;
					low('snrMin', q);
				}
				else low('merMin', q);
				if (unc != null) a.unc = (a.unc || 0) + unc;
				if (corr != null) a.corr = (a.corr || 0) + corr;
			}
			else if (p != null) a.us[c.channel_id] = p;

			var k = c.dir + ',' + c.channel_id, t = G.channels[k];
			if (!t) t = G.channels[k] = { dir: c.dir, channel_id: c.channel_id, n: 0, marginal: 0, bad: 0, unlocked: 0,
				powerMin: null, powerMax: null, snrMin: null, snrMax: null, unc: 0, corr: 0 };
			/* How it was last described while it had a modulation. */
			if (c.modulation && c.modulation !== 'Unknown' || !t.modulation) { t.modulation = c.modulation; t.ch = c.ch; t.freq_hz = c.freq_hz; t.width_hz = c.width_hz; }
			t.n++;
			if (cv.level === health.MARGINAL) t.marginal++;
			if (cv.level === health.BAD) t.bad++;
			if (!locked) t.unlocked++;
			if (p != null) { if (t.powerMin == null || p < t.powerMin) t.powerMin = p; if (t.powerMax == null || p > t.powerMax) t.powerMax = p; }
			if (q != null) { if (t.snrMin == null || q < t.snrMin) t.snrMin = q; if (t.snrMax == null || q > t.snrMax) t.snrMax = q; }
			if (unc != null) t.unc += unc;
			if (corr != null) t.corr += corr;
		});
		if (r.result === 'ok' && (!G.latest || +r.ts > +G.latest.reading.ts))
			G.latest = { reading: r, verdict: v };
		r.agg = a;
		r.verdict = { level: v.level, reasons: v.reasons };
		G.readings.push(r);
	});
	P.events.forEach(function(e) { G.events.push(e); });
	(P.restarts || []).forEach(function(r) { G.restarts.push(r); });
	G.speed = addSpeed(G.speed, P.speed);
}

/* A period reduced piece by piece (see reduce), so that months of channel
 * rows are never held at once. progress(done, of) is called as it goes.
 * -> what analyse() returns, with .channels a tally per channel and
 *    .latest the newest good reading with its channels. */
function loadDigest(since, until, intervalMin, limits, progress) {
	var G = { since: since, until: until, interval: intervalMin || 5, limits: limits || health.LIMITS,
		readings: [], events: [], restarts: [], channels: {}, radios: {}, gateway: false, latest: null, speed: null, judged: true };
	var todo = pieces(since, until, intervalMin), i = 0;
	var next = function() {
		if (i >= todo.length) {
			G.readings.sort(function(a, b) { return a.ts - b.ts; });
			G.events = G.events.filter(inPeriod(since, until)).sort(function(a, b) { return a.ts - b.ts; });
			G.restarts = uniqueRestarts(G.restarts.filter(inPeriod(since, until)));
			return analyse(G, G.interval, G.limits);
		}
		var batch = todo.slice(i, i + 4);
		return Promise.all(batch.map(function(p) { return callData(p[0], p[1]); })).then(function(parts) {
			parts.forEach(function(p) { reduce(G, assemble(p || {})); });
			i += batch.length;
			if (progress) progress(Math.min(i, todo.length), todo.length);
			return next();
		});
	};
	return next();
}

/* Verdicts for every reading, and for the whole period. limits: from
 * health.applySettings (default: health.LIMITS). */
function analyse(D, intervalMin, limits) {
	D.limits = limits = limits || health.LIMITS;
	/* A digest's readings are judged already (see reduce). */
	if (!D.judged) {
		D.readings.forEach(function(r) { r.verdict = verdictOf(r, D, limits); });
		D.gateway = D.readings.some(function(r) { return isGateway(r, D); });
	}
	var outages = health.outages(D.readings, Math.max(1800, (intervalMin || 5) * 60 * 3));
	var disruptive = D.events.filter(function(e) { return e.kind !== 'login'; });
	var hours = Math.max((D.until - D.since) / 3600, 1 / 60);
	/* A period only counts from the earliest reading or event in it. */
	var first = Math.min(D.readings.length ? +D.readings[0].ts : Infinity, disruptive.length ? disruptive[0].ts : Infinity);
	if (isFinite(first)) hours = Math.max((D.until - first) / 3600, 1 / 60);
	D.outages = outages;
	D.reregistrations = health.reregistrations(disruptive);
	D.reboots = D.readings.filter(function(r) { return r.reboot === '1'; });
	/* Restarts Modem Health made, and what they caused: not the line's. */
	D.restarts = D.restarts || [];
	D.own = health.ownRestarts(D.readings, D.restarts, outages, Math.max(900, (intervalMin || 5) * 60 + 60));
	D.period = health.periodVerdict({
		hours: hours,
		readings: D.readings.map(function(r) { return { ts: r.ts, level: r.verdict.level }; }),
		events: disruptive,
		reboots: D.reboots.filter(function(r) { return !r.byModemHealth; }).length,
		outages: outages.filter(function(o) { return !o.byModemHealth; })
	}, limits);
	D.period.hours = hours;
	/* ISPy's speed tests of the period, each lined up with what the modem
	 * recorded within one check interval of it, and no less than five
	 * minutes: a test takes about a minute (null: ISPy has none). */
	var tests = D.speed ? D.speed.tests.filter(inPeriod(D.since, D.until)) : [];
	D.speedTests = tests.length ? health.speedTests(tests, { down: D.speed.planDown, up: D.speed.planUp }, {
		readings: D.readings.map(function(r) { return { ts: +r.ts, level: r.verdict.level }; }),
		events: disruptive, outages: outages, windowS: Math.max(intervalMin || 5, 5) * 60
	}) : null;
	if (D.speedTests && !D.speedTests.n) D.speedTests = null;
	return D;
}

/* ---------------------------------------------------------- formatting -- */

function pad(n) { return (n < 10 ? '0' : '') + n; }

function fmtTime(ts) {
	var d = new Date(ts * 1000);
	return '%d-%s-%s %s:%s'.format(d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate()), pad(d.getHours()), pad(d.getMinutes()));
}

function fmtShort(ts) {
	var d = new Date(ts * 1000);
	return '%s/%s %s:%s'.format(pad(d.getMonth() + 1), pad(d.getDate()), pad(d.getHours()), pad(d.getMinutes()));
}

function fmtDuration(s) {
	if (s == null) return _('unknown');
	s = Math.round(s);
	if (s < 60) return _('%d s').format(s);
	/* Rounded first, then split: never "1 h 60 min" or "13 d 24 h". */
	var m = Math.round(s / 60), h = Math.round(s / 3600);
	if (m < 60) return _('%d min').format(m);
	if (h < 24) return _('%d h %d min').format(Math.floor(m / 60), m % 60);
	return _('%d d %d h').format(Math.floor(h / 24), h % 24);
}

function fmtNum(v, digits) {
	var n = health.num(v);
	return n == null ? '–' : n.toFixed(digits == null ? 1 : digits);
}

function fmtInt(v) {
	var n = health.num(v);
	return n == null ? '–' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

var LEVEL_TEXT = {
	good: _('good'), marginal: _('marginal'), bad: _('out of spec'), unknown: _('unknown'),
	healthy: _('Healthy'), degraded: _('Degraded'), failing: _('Failing')
};

/* A limit in words: "good -7 to +7 dBmV, acceptable -15 to +15". */
function fmtLimit(limit) {
	if (!limit || !limit.good) return limit ? limit.label : '';
	var r = function(x) {
		if (x[0] == null) return _('up to %s').format(x[1]);
		if (x[1] == null) return _('%s or more').format(x[0]);
		return '%s … %s'.format(x[0], x[1]);
	};
	return _('%s: good %s, acceptable %s %s').format(limit.label, r(limit.good), r(limit.marginal), limit.unit || '');
}

/* Plain-language reason for the summary. hours: length of the period;
 * rates "a day" are only quoted for periods of a day or more. */
/* Why a check could not read the modem, in words; the stored code follows. */
var FAILED = {
	no_password: _('no modem password is saved'),
	login_refused: _('the modem refused the user name or password'),
	login_not_ready: _('the modem accepts no login and asks for its login page to be loaded again'),
	login_LOCKUP: _('the modem has locked logins after too many wrong passwords'),
	login_REBOOT: _('the modem has locked logins until it is restarted'),
	unreachable: _('nothing answered at the modem\'s address'),
	timeout: _('no answer in time'),
	tls_error: _('no secure connection to the modem'),
	bad_reply: _('the reply could not be read'),
	not_a_supported_modem: _('the login reply was not one Modem Health knows'),
	not_a_supported_device: _('the reply was not a T-Mobile gateway\'s')
};
function failedText(code) {
	return Object.prototype.hasOwnProperty.call(FAILED, code || '') ? '%s (%s)'.format(FAILED[code], code) : (code || '?');
}

function reasonText(r, hours, gateway) {
	var L = r.limit || {};
	var rate = function() {
		return hours >= 24 ? _(', %.1f a day').format(r.perDay) : (hours ? _(' in %s').format(fmtDuration(hours * 3600)) : '');
	};
	switch (r.kind) {
	case 'failed_reading': return _('The last check could not read the modem: %s.').format(failedText(r.detail));
	case 'not_operational': return _('The modem reports it is not operational (%s).').format(r.detail || '?');
	case 'no_downstream': return _('No downstream channels are locked.');
	case 'not_registered': return _('The gateway is not registered on the mobile network (%s).').format(r.detail || '?');
	case 'no_radio': return _('No 4G or 5G radio is connected.');
	case 'cell_change': return _('%d tower change(s)%s.').format(r.count, rate());
	case 'radio_lost': return _('%d time(s) the 4G or 5G connection was lost%s.').format(r.count, rate());
	case 'outage': return _('%d outage(s) with no internet.').format(r.count);
	case 't4': return _('%d T4 time-out(s): the modem lost its connection and searched for the signal again.').format(r.count);
	case 't3': return _('%d T3 time-out(s)%s: the ISP did not answer the modem.').format(r.count, rate());
	case 'sync_loss': return _('%d loss(es) of downstream sync%s.').format(r.count, rate());
	case 'reboot': return (gateway ? _('%d gateway restart(s)%s.') : _('%d modem restart(s)%s.')).format(r.count, rate());
	case 'readings_out_of_spec': return _('%.0f%% of checks found a value out of spec.').format(r.share * 100);
	case 'readings_marginal': return _('%.0f%% of checks found a marginal value.').format(r.share * 100);
	}
	if (r.radio)
		return _('%s on %s: %s %s (%s).').format(L.label || r.kind, r.radio.bands || '?', String(r.value), L.unit || '', LEVEL_TEXT[r.level]);
	if (r.channel)
		return _('%s channel %s: %s %s (%s).').format(r.channel.dir === 'ds' ? _('Downstream') : _('Upstream'),
			r.channel.channel_id, L.label || r.kind, String(r.value), LEVEL_TEXT[r.level]);
	return r.kind;
}

/* Channel reasons of the same kind and level become one line: "Upstream
 * power (SC-QAM, 4 channels) marginal on 4 channels: 50.0 to 50.8 dBmV." */
function groupReasons(reasons) {
	var out = [], groups = {};
	(reasons || []).forEach(function(r) {
		if (!r.channel) { out.push(r); return; }
		var k = r.kind + '|' + r.level + '|' + ((r.limit || {}).label || '');
		if (!groups[k]) out.push(groups[k] = { kind: r.kind, level: r.level, limit: r.limit, channels: [], values: [], grouped: true });
		groups[k].channels.push(r.channel);
		if (typeof r.value === 'number') groups[k].values.push(r.value);
	});
	return out;
}

function groupedText(g, hours) {
	if (!g.grouped) return reasonText(g, hours);
	var L = g.limit || {}, v = g.values;
	var range = !v.length ? '' : (Math.min.apply(null, v) === Math.max.apply(null, v)
		? String(Math.min.apply(null, v)) : _('%s to %s').format(Math.min.apply(null, v), Math.max.apply(null, v)));
	var where = g.channels.length === 1
		? _('channel %s').format(g.channels[0].channel_id)
		: _('%d channels').format(g.channels.length);
	if (g.kind.slice(-5) === '_lock') return _('%s not locked on %s.').format(g.channels[0].dir === 'ds' ? _('Downstream') : _('Upstream'), where);
	return _('%s %s on %s: %s %s.').format(L.label || g.kind, LEVEL_TEXT[g.level], where, range, L.unit || '');
}

/* --------------------------------------------------------- speed tests -- */

function nOf(count, one, many) {
	return '%d %s'.format(count, count === 1 ? one : many);
}

function fmtMbps(v) {
	/* Whole numbers from 100 up; below that one decimal, if it has one. */
	return v == null ? '–' : _('%s Mbit/s').format(v >= 100 ? fmtNum(v, 0) : String(+(+v).toFixed(1)));
}

/* Which speeds a test is judged on: those ISPy has an advertised speed for. */
function speedDirections(ST) {
	return ST.plan.down && ST.plan.up ? _('download or upload') : (ST.plan.down ? _('download') : _('upload'));
}

/* ISPy's speed tests of a period in a few sentences (ST: what analyse()
 * leaves in .speedTests), for the Overview. */
function speedSentences(ST) {
	var c = ST.counts, min = Math.round(ST.windowS / 60), ran = ST.n - c.failed.total, out = [];
	out.push(c.failed.total
		? _('%s by ISPy in this period, of which %d did not complete.').format(nOf(ST.n, _('speed test'), _('speed tests')), c.failed.total)
		: _('%s by ISPy in this period.').format(nOf(ST.n, _('speed test'), _('speed tests'))));
	if (!ran)
		return out;
	if (!ST.plan.down && !ST.plan.up) {
		out.push(_('No advertised speed is set in ISPy, so its tests cannot be called slow or not.'));
		return out;
	}
	/* Tests with no check of the modem near them are said to be so: "1 of
	 * 8" must not read as "7 were at times without a problem". */
	var unknown = function(g) { return g.unknown ? ' ' + _('For %d it is not known: no check read the modem then.').format(g.unknown) : ''; };
	out.push(_('Slow (%s below 80%% of the advertised speed): %s, %d of them within %d minutes of a line problem the modem recorded.')
		.format(speedDirections(ST), nOf(c.slow.total, _('test'), _('tests')), c.slow.problem, min) + unknown(c.slow));
	if (c.fine.total)
		out.push(_('Not slow: %s, %d of them within %d minutes of a line problem.').format(nOf(c.fine.total, _('test'), _('tests')), c.fine.problem, min) + unknown(c.fine));
	return out;
}

/* The speed tests as a chart on the pages' time axis: a dot for each test
 * that completed, as a share of the advertised speed where ISPy has one
 * (download and upload then fit one scale, and slow is the shaded part
 * below 80%), otherwise in Mbit/s. Tests that did not complete are grey
 * ticks at the bottom.
 * o: { from, to: the axis; max: draw at most this many dots per direction
 *      (the slowest test of each stretch is kept) }
 * -> { chart: options for chartSVG (series, bands, marks, zero, suffix, tickStep),
 *      legend: [ { name, color, faint } ], percent, stretch: seconds each
 *      dot stands for (null: every test is drawn), before: tests that
 *      started before the axis does } */
function speedChart(ST, o) {
	var pd = ST.plan.down, pu = ST.plan.up, percent = !!(pd || pu);
	var shown = ST.tests.filter(function(t) { return t.ts >= o.from && t.ts <= o.to; });
	var ok = shown.filter(function(t) { return t.status === 'ok'; }), stretch = null;
	var points = function(key, plan, word) {
		var pts = ok.filter(function(t) { return t[key] != null; }).map(function(t) {
			return percent
				? [ t.ts, +(t[key] / plan * 100).toFixed(1), _('%s · %s %s, %d%% of the advertised %s').format(fmtTime(t.ts), word, fmtMbps(t[key]), Math.round(t[key] / plan * 100), fmtMbps(plan)) ]
				: [ t.ts, t[key], '%s · %s %s'.format(fmtTime(t.ts), word, fmtMbps(t[key])) ];
		});
		if (!o.max || pts.length <= o.max) return pts;
		/* Too many to draw: the slowest test of each stretch. */
		var w = Math.max((o.to - o.from) / o.max, 1), box = {};
		stretch = w;
		pts.forEach(function(p) {
			var k = Math.floor((p[0] - o.from) / w);
			if (!box[k] || p[1] < box[k][1]) box[k] = p;
		});
		return Object.keys(box).sort(function(a, b) { return a - b; }).map(function(k) { return box[k]; });
	};
	var series = [], legend = [];
	[ [ 'down', pd, _('download'), C.series[0] ], [ 'up', pu, _('upload'), C.series[1] ] ].forEach(function(d) {
		if (percent && !d[1]) return;
		series.push({ name: d[2], color: d[3], dots: true, points: points(d[0], d[1], d[2]) });
		legend.push({ name: d[2], color: d[3] });
	});
	if (percent) legend.push({ name: _('slow: below 80% of the advertised speed'), color: C.bad, faint: true });
	var failed = shown.filter(function(t) { return t.status !== 'ok'; });
	if (failed.length) legend.push({ name: _('test did not complete'), color: C.unknown });
	var top = 0;
	series.forEach(function(sr) { sr.points.forEach(function(p) { if (p[1] > top) top = p[1]; }); });
	return {
		/* A line every 20%, so that 80% has one, unless that would be a crowd. */
		chart: { zero: true, suffix: percent ? '%' : '', tickStep: percent && top <= 200 ? 20 : null, series: series,
			bands: percent ? [ { lo: null, hi: 80, color: C.bad } ] : [],
			marks: failed.map(function(t) { return { ts: t.ts, color: C.unknown, bottom: true, label: _('%s · speed test did not complete').format(fmtTime(t.ts)) }; }) },
		legend: legend, percent: percent, stretch: stretch, before: ST.tests.length - shown.length
	};
}

/* ------------------------------------------------------------------ CSV -- */

/* One CSV field. Text that a spreadsheet would run as a formula (=, +, -,
 * @ not followed by a number) gets a leading apostrophe. */
function csvField(v) {
	var s = v == null ? '' : String(v);
	if (/^[=+\-@]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s)) s = "'" + s;
	return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function isoTime(ts) {
	var d = new Date(ts * 1000);
	return '%d-%s-%s %s:%s:%s'.format(d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate()), pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds()));
}

var CSV_COLUMNS = {
	readings: [ 'time', 'ts', 'result', 'reason', 'model', 'firmware', 'uptime_s', 'connectivity', 'boot', 'network_access', 'modem_time',
		'ds_channels', 'us_channels', 'reboot', 'boot_ts', 'clock_offset_s', 'modem_ping_loss', 'modem_ping_ms', 'inet_ping_loss', 'inet_ping_ms' ],
	channels: [ 'time', 'ts', 'dir', 'ch', 'channel_id', 'modulation', 'freq_hz', 'width_hz', 'lock', 'power_dbmv', 'snr_db', 'corrected', 'uncorrectable' ],
	events: [ 'time', 'ts', 'modem_time', 'clock_offset_s', 'first_seen_ts', 'level', 'kind', 'message' ],
	radios: [ 'time', 'ts', 'tech', 'bands', 'bars', 'rsrp_dbm', 'rsrq_db', 'rssi_dbm', 'sinr_db', 'cell' ]
};

/* The period's readings, channels (with the line-up joined in) or events
 * as CSV. "time" is the router's local time; channel error counts are the
 * change since the previous good check. */
function toCSV(D, kind) {
	var cols = CSV_COLUMNS[kind];
	var rows = kind === 'readings' ? D.readings : kind === 'channels' ? D.channels : kind === 'radios' ? (D.radios || []) : D.events;
	return [ cols.join(',') ].concat(rows.map(function(r) {
		return cols.map(function(c) { return csvField(c === 'time' ? isoTime(+r.ts) : r[c]); }).join(',');
	})).join('\r\n') + '\r\n';
}

/* --------------------------------------------------------------- charts -- */

function esc(v) {
	return String(v == null ? '' : v).replace(/[&<>"']/g, function(c) {
		return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
	});
}

/* SVG as text, so that the same chart serves the pages and the report
 * file. Attribute values are escaped here; children are markup made the
 * same way, and text goes through esc(). */
function S(tag, attrs, children) {
	var a = Object.keys(attrs || {}).map(function(k) {
		var v = attrs[k];
		if (v == null) return '';
		return ' ' + k + '="' + esc(typeof v === 'number' ? +v.toFixed(2) : v) + '"';
	}).join('');
	return '<' + tag + a + '>' + (children || []).join('') + '</' + tag + '>';
}

function niceTicks(lo, hi, n) {
	var span = hi - lo || 1, step = Math.pow(10, Math.floor(Math.log10(span / n)));
	[ 1, 2, 5, 10 ].some(function(m) { if (span / (step * m) <= n) { step *= m; return true; } });
	var out = [];
	for (var v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
	return out;
}

/* chartSVG({
 *   from, to: time range (epoch s); unit, title (for the description)
 *   series: [ { name, color, points: [ [ts, v|null], ... ], bars: bool,
 *               dots: bool (a dot for every point, no line; a point may
 *               carry its own description as a third element) } ]
 *   suffix: text after each value on the axis ("%")
 *   bands:  [ { lo, hi, color } ]  shaded value ranges (limits)
 *   spans:  [ { from, to, color, label } ] shaded time ranges (outages)
 *   marks:  [ { ts, color, label, bottom } ] events, drawn as ticks at the
 *           top (bottom: true = at the bottom, clear of those)
 *   tickStep: the distance between the lines of the value axis (default:
 *           chosen to fit)
 *   gap:    seconds without a point after which a line breaks
 *   interval: seconds between checks (the width of a bar)
 * }) -> the chart as SVG text */
function chartSVG(o) {
	var W = 720, H = 220, ml = 48, mr = 10, mt = 14, mb = 26;
	var vals = [];
	o.series.forEach(function(s) { s.points.forEach(function(p) { if (p[1] != null) vals.push(p[1]); }); });
	(o.bands || []).forEach(function(b) { if (o.fitBands) { if (b.lo != null) vals.push(b.lo); if (b.hi != null) vals.push(b.hi); } });
	var lo = vals.length ? Math.min.apply(null, vals) : 0, hi = vals.length ? Math.max.apply(null, vals) : 1;
	if (o.zero) lo = Math.min(lo, 0);
	var pad = (hi - lo) * 0.1 || 1;
	lo -= o.zero && lo === 0 ? 0 : pad; hi += pad;
	var x = function(ts) { return ml + (ts - o.from) / Math.max(o.to - o.from, 1) * (W - ml - mr); };
	var y = function(v) { return mt + (hi - v) / (hi - lo) * (H - mt - mb); };
	var parts = [];

	(o.bands || []).forEach(function(b) {
		var top = y(Math.min(b.hi == null ? hi : b.hi, hi)), bottom = y(Math.max(b.lo == null ? lo : b.lo, lo));
		if (bottom > top) parts.push(S('rect', { x: ml, y: top, width: W - ml - mr, height: bottom - top, fill: b.color, 'fill-opacity': 0.10 }));
	});
	(o.spans || []).forEach(function(sp) {
		var a = x(Math.max(sp.from, o.from)), b = x(Math.min(sp.to, o.to));
		parts.push(S('rect', { x: a, y: mt, width: Math.max(b - a, 2), height: H - mt - mb, fill: sp.color, 'fill-opacity': 0.25 },
			[ S('title', {}, [ esc(sp.label) ]) ]));
	});
	var ticks = niceTicks(lo, hi, 5);
	if (o.tickStep) {
		ticks = [];
		for (var tv = Math.ceil(lo / o.tickStep) * o.tickStep; tv <= hi + 1e-9; tv += o.tickStep) ticks.push(tv);
	}
	ticks.forEach(function(v) {
		parts.push(S('line', { x1: ml, x2: W - mr, y1: y(v), y2: y(v), stroke: 'currentColor', 'stroke-opacity': 0.12 }));
		parts.push(S('text', { x: ml - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'currentColor' }, [ esc(v + (o.suffix || '')) ]));
	});
	var span = o.to - o.from, step = span > 3 * 86400 ? 86400 : span > 86400 ? 6 * 3600 : span > 8 * 3600 ? 3 * 3600 : span > 3 * 3600 ? 3600 : 1800;
	var t0 = new Date(o.from * 1000);
	t0.setMinutes(0, 0, 0);
	if (step === 86400) t0.setHours(0);
	for (var t = t0.getTime() / 1000 + step; t < o.to; t += step) {
		parts.push(S('line', { x1: x(t), x2: x(t), y1: mt, y2: H - mb, stroke: 'currentColor', 'stroke-opacity': 0.08 }));
		parts.push(S('text', { x: x(t), y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: 'currentColor' },
			[ esc(step === 86400 ? fmtShort(t).split(' ')[0] : fmtShort(t).split(' ')[1]) ]));
	}
	o.series.forEach(function(s) {
		if (s.bars) {
			/* A bar is as wide as the time between checks, not as the
			 * number of bars would allow: a few checks on a long axis
			 * must not merge into one block. */
			var per = (W - ml - mr) * (o.interval || (o.to - o.from) / Math.max(s.points.length, 1)) / Math.max(o.to - o.from, 1);
			var bw = Math.min(Math.max(per * 0.8, 1.5), 14);
			s.points.forEach(function(p) {
				if (p[1] == null || p[1] <= 0) return;
				parts.push(S('rect', { x: x(p[0]) - bw / 2, y: y(p[1]), width: bw, height: y(Math.max(lo, 0)) - y(p[1]), fill: s.color },
					[ S('title', {}, [ esc('%s · %s: %s'.format(fmtTime(p[0]), s.name, fmtInt(p[1]))) ]) ]));
			});
			return;
		}
		if (s.dots) {
			s.points.forEach(function(p) {
				if (p[1] == null) return;
				parts.push(S('circle', { cx: x(p[0]), cy: y(p[1]), r: 3, fill: s.color, 'fill-opacity': 0.85 },
					[ S('title', {}, [ esc(p[2] || '%s · %s: %s'.format(fmtTime(p[0]), s.name, String(p[1]))) ]) ]));
			});
			return;
		}
		var d = '', prev = null, pts = s.points;
		var joined = function(a, b) { return a && b && a[1] != null && b[1] != null && !(o.gap && b[0] - a[0] > o.gap); };
		pts.forEach(function(p, i) {
			if (p[1] == null) { prev = null; return; }
			var brk = prev == null || (o.gap && p[0] - prev > o.gap);
			d += (brk ? 'M' : 'L') + x(p[0]).toFixed(1) + ',' + y(p[1]).toFixed(1);
			prev = p[0];
			/* A reading with no neighbour to join is drawn as a dot. */
			if (!joined(pts[i - 1], p) && !joined(p, pts[i + 1]))
				parts.push(S('circle', { cx: x(p[0]), cy: y(p[1]), r: 3, fill: s.color },
					[ S('title', {}, [ esc('%s · %s: %s'.format(fmtTime(p[0]), s.name, String(p[1]))) ]) ]));
		});
		if (d) parts.push(S('path', { d: d, fill: 'none', stroke: s.color, 'stroke-width': 1.6, 'stroke-dasharray': s.dash || null },
			[ S('title', {}, [ esc(s.name) ]) ]));
	});
	(o.marks || []).forEach(function(m) {
		parts.push(S('line', { x1: x(m.ts), x2: x(m.ts), y1: m.bottom ? H - mb - 12 : mt - 2, y2: m.bottom ? H - mb : mt + 10, stroke: m.color, 'stroke-width': 2 },
			[ S('title', {}, [ esc(m.label) ]) ]));
	});
	return S('svg', { xmlns: SVGNS, viewBox: '0 0 ' + W + ' ' + H, width: '100%', role: 'img', 'class': 'mh-chart', 'aria-label': o.title || '' }, parts);
}

/* The same chart as an element, for the pages. */
function lineChart(o) {
	var box = document.createElement('div');
	box.innerHTML = chartSVG(o);
	return box.firstChild;
}

function legend(items) {
	return E('div', { 'class': 'mh-legend' }, items.map(function(it) {
		return E('span', { 'class': 'mh-legend-item' }, [
			E('span', { 'class': 'mh-swatch', 'style': 'background:' + it.color + (it.faint ? ';opacity:.35' : '') }),
			[ it.name ]
		]);
	}));
}

/* Test connection's answer for a T-Mobile gateway. */
function gatewayText(r) {
	var radios = (r.radios || []).map(function(x) {
		return _('%s %s: RSRP %s dBm, SINR %s dB').format(x.tech === 'nr' ? '5G' : '4G', x.bands || '?',
			x.rsrp == null ? '?' : x.rsrp, x.sinr == null ? '?' : x.sinr);
	});
	return _('Connected: %s, firmware %s (T-Mobile gateway, %s). %s').format(r.model || '?', r.firmware || '?',
		r.registration || _('registration unknown'), radios.length ? radios.join('; ') + '.' : _('No radio is connected.'));
}

return baseclass.extend({
	C: C, health: health, gatewayText: gatewayText, isGateway: isGateway, verdictOf: verdictOf,
	callStatus: callStatus, callData: callData, callCheck: callCheck, callTest: callTest, callSetPassword: callSetPassword,
	callExport: callExport, callClear: callClear, callRestart: callRestart, failedText: failedText,
	parseCSV: parseCSV, load: load, loadDigest: loadDigest, analyse: analyse, toCSV: toCSV, csvField: csvField, esc: esc,
	fmtTime: fmtTime, isoTime: isoTime, fmtShort: fmtShort, fmtDuration: fmtDuration, fmtNum: fmtNum, fmtInt: fmtInt, fmtLimit: fmtLimit,
	LEVEL_TEXT: LEVEL_TEXT, reasonText: reasonText, groupReasons: groupReasons, groupedText: groupedText,
	nOf: nOf, fmtMbps: fmtMbps, speedDirections: speedDirections, speedSentences: speedSentences, speedChart: speedChart,
	chartSVG: chartSVG, lineChart: lineChart, legend: legend
});
