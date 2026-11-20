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

/* Everything stored between since and until (epoch seconds), joined up:
 * channels carry their modulation, frequency and width from the line-up,
 * events their kind. */
function load(since, until) {
	return callData(since, until).then(function(d) {
		var map = {};
		parseCSV(d.channelmap).forEach(function(m) { map[m.dir + ',' + m.channel_id] = m; });
		var channels = parseCSV(d.channels).map(function(c) {
			var m = map[c.dir + ',' + c.channel_id] || {};
			c.ch = m.ch; c.modulation = m.modulation; c.freq_hz = m.freq_hz; c.width_hz = m.width_hz;
			return c;
		});
		var byTs = {};
		channels.forEach(function(c) { (byTs[c.ts] = byTs[c.ts] || []).push(c); });
		var events = parseCSV(d.events).map(function(e) {
			e.kind = health.classifyEvent(e.message);
			e.ts = eventTime(e);
			return e;
		}).filter(function(e) { return e.ts >= since && e.ts <= until; })
		  .sort(function(a, b) { return a.ts - b.ts; });
		var readings = parseCSV(d.readings).sort(function(a, b) { return a.ts - b.ts; });
		return { since: since, until: until, readings: readings, channelsAt: byTs, events: events };
	});
}

/* Verdicts for every reading, and for the whole period. */
function analyse(D, intervalMin) {
	D.readings.forEach(function(r) { r.verdict = health.readingVerdict(r, D.channelsAt[r.ts] || []); });
	var outages = health.outages(D.readings, Math.max(1800, (intervalMin || 5) * 60 * 3));
	var disruptive = D.events.filter(function(e) { return e.kind !== 'login'; });
	var hours = Math.max((D.until - D.since) / 3600, 1 / 60);
	/* A period only counts from the earliest reading or event in it. */
	var first = Math.min(D.readings.length ? +D.readings[0].ts : Infinity, disruptive.length ? disruptive[0].ts : Infinity);
	if (isFinite(first)) hours = Math.max((D.until - first) / 3600, 1 / 60);
	D.outages = outages;
	D.reregistrations = health.reregistrations(disruptive);
	D.reboots = D.readings.filter(function(r) { return r.reboot === '1'; });
	D.period = health.periodVerdict({
		hours: hours,
		readings: D.readings.map(function(r) { return { ts: r.ts, level: r.verdict.level }; }),
		events: disruptive,
		reboots: D.reboots.length,
		outages: outages
	});
	D.period.hours = hours;
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
	if (s < 3600) return _('%d min').format(Math.round(s / 60));
	if (s < 86400) return _('%d h %d min').format(Math.floor(s / 3600), Math.round(s % 3600 / 60));
	return _('%d d %d h').format(Math.floor(s / 86400), Math.round(s % 86400 / 3600));
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
function reasonText(r, hours) {
	var L = r.limit || {};
	var rate = function() {
		return hours >= 24 ? _(', %.1f a day').format(r.perDay) : (hours ? _(' in %s').format(fmtDuration(hours * 3600)) : '');
	};
	switch (r.kind) {
	case 'failed_reading': return _('The last check could not read the modem (%s).').format(r.detail || '?');
	case 'not_operational': return _('The modem reports it is not operational (%s).').format(r.detail || '?');
	case 'no_downstream': return _('No downstream channels are locked.');
	case 'outage': return _('%d outage(s) with no internet.').format(r.count);
	case 't4': return _('%d T4 time-out(s): the modem lost its connection and searched for the signal again.').format(r.count);
	case 't3': return _('%d T3 time-out(s)%s: the ISP did not answer the modem.').format(r.count, rate());
	case 'sync_loss': return _('%d loss(es) of downstream sync%s.').format(r.count, rate());
	case 'reboot': return _('%d modem restart(s)%s.').format(r.count, rate());
	case 'readings_out_of_spec': return _('%.0f%% of checks found a value out of spec.').format(r.share * 100);
	case 'readings_marginal': return _('%.0f%% of checks found a marginal value.').format(r.share * 100);
	}
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

/* --------------------------------------------------------------- charts -- */

function S(tag, attrs, children) {
	var el = document.createElementNS(SVGNS, tag);
	Object.keys(attrs || {}).forEach(function(k) { if (attrs[k] != null) el.setAttribute(k, attrs[k]); });
	(children || []).forEach(function(c) { el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
	return el;
}

function niceTicks(lo, hi, n) {
	var span = hi - lo || 1, step = Math.pow(10, Math.floor(Math.log10(span / n)));
	[ 1, 2, 5, 10 ].some(function(m) { if (span / (step * m) <= n) { step *= m; return true; } });
	var out = [];
	for (var v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
	return out;
}

/* lineChart({
 *   from, to: time range (epoch s); unit, title (for the description)
 *   series: [ { name, color, points: [ [ts, v|null], ... ], bars: bool } ]
 *   bands:  [ { lo, hi, color } ]  shaded value ranges (limits)
 *   spans:  [ { from, to, color, label } ] shaded time ranges (outages)
 *   marks:  [ { ts, color, label } ] events, drawn as ticks at the top
 *   gap:    seconds without a point after which a line breaks
 * }) -> <svg> */
function lineChart(o) {
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
	var svg = S('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', role: 'img', 'class': 'mh-chart' });

	(o.bands || []).forEach(function(b) {
		var top = y(Math.min(b.hi == null ? hi : b.hi, hi)), bottom = y(Math.max(b.lo == null ? lo : b.lo, lo));
		if (bottom > top) svg.appendChild(S('rect', { x: ml, y: top, width: W - ml - mr, height: bottom - top, fill: b.color, 'fill-opacity': 0.10 }));
	});
	(o.spans || []).forEach(function(sp) {
		var a = x(Math.max(sp.from, o.from)), b = x(Math.min(sp.to, o.to));
		svg.appendChild(S('rect', { x: a, y: mt, width: Math.max(b - a, 2), height: H - mt - mb, fill: sp.color, 'fill-opacity': 0.25 },
			[ S('title', {}, [ sp.label ]) ]));
	});
	niceTicks(lo, hi, 5).forEach(function(v) {
		svg.appendChild(S('line', { x1: ml, x2: W - mr, y1: y(v), y2: y(v), stroke: 'currentColor', 'stroke-opacity': 0.12 }));
		svg.appendChild(S('text', { x: ml - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'currentColor' }, [ String(v) ]));
	});
	var span = o.to - o.from, step = span > 3 * 86400 ? 86400 : span > 86400 ? 6 * 3600 : span > 8 * 3600 ? 3 * 3600 : span > 3 * 3600 ? 3600 : 1800;
	var t0 = new Date(o.from * 1000);
	t0.setMinutes(0, 0, 0);
	if (step === 86400) t0.setHours(0);
	for (var t = t0.getTime() / 1000 + step; t < o.to; t += step) {
		svg.appendChild(S('line', { x1: x(t), x2: x(t), y1: mt, y2: H - mb, stroke: 'currentColor', 'stroke-opacity': 0.08 }));
		svg.appendChild(S('text', { x: x(t), y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: 'currentColor' },
			[ step === 86400 ? fmtShort(t).split(' ')[0] : fmtShort(t).split(' ')[1] ]));
	}
	o.series.forEach(function(s) {
		if (s.bars) {
			var bw = Math.max((W - ml - mr) / Math.max(s.points.length, 1) * 0.8, 1.5);
			s.points.forEach(function(p) {
				if (p[1] == null || p[1] <= 0) return;
				svg.appendChild(S('rect', { x: x(p[0]) - bw / 2, y: y(p[1]), width: bw, height: y(Math.max(lo, 0)) - y(p[1]), fill: s.color },
					[ S('title', {}, [ '%s · %s: %s'.format(fmtTime(p[0]), s.name, fmtInt(p[1])) ]) ]));
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
				svg.appendChild(S('circle', { cx: x(p[0]), cy: y(p[1]), r: 3, fill: s.color },
					[ S('title', {}, [ '%s · %s: %s'.format(fmtTime(p[0]), s.name, String(p[1])) ]) ]));
		});
		if (d) svg.appendChild(S('path', { d: d, fill: 'none', stroke: s.color, 'stroke-width': 1.6, 'stroke-dasharray': s.dash || null },
			[ S('title', {}, [ s.name ]) ]));
	});
	(o.marks || []).forEach(function(m) {
		svg.appendChild(S('line', { x1: x(m.ts), x2: x(m.ts), y1: mt - 2, y2: mt + 10, stroke: m.color, 'stroke-width': 2 },
			[ S('title', {}, [ m.label ]) ]));
	});
	svg.setAttribute('aria-label', o.title || '');
	return svg;
}

function legend(items) {
	return E('div', { 'class': 'mh-legend' }, items.map(function(it) {
		return E('span', { 'class': 'mh-legend-item' }, [
			E('span', { 'class': 'mh-swatch', 'style': 'background:' + it.color + (it.faint ? ';opacity:.35' : '') }),
			[ it.name ]
		]);
	}));
}

return baseclass.extend({
	C: C, health: health,
	callStatus: callStatus, callData: callData, callCheck: callCheck, callTest: callTest, callSetPassword: callSetPassword,
	parseCSV: parseCSV, load: load, analyse: analyse,
	fmtTime: fmtTime, fmtShort: fmtShort, fmtDuration: fmtDuration, fmtNum: fmtNum, fmtInt: fmtInt, fmtLimit: fmtLimit,
	LEVEL_TEXT: LEVEL_TEXT, reasonText: reasonText, groupReasons: groupReasons, groupedText: groupedText,
	lineChart: lineChart, legend: legend
});
