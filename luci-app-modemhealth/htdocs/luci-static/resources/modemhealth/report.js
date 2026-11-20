'use strict';
'require baseclass';
'require modemhealth.common as mh';

/*
 * Modem Health - the report for the ISP.
 *
 * build() turns a digest of a period (common.js: loadDigest) into one
 * self-contained HTML document: no scripts, no outside files, charts as
 * inline SVG. The Report page shows it in a frame, the same text is the
 * file to download, and it prints to PDF as it stands.
 *
 * The report is evidence, so it is cautious: a check that failed is listed
 * and counted as unknown, never as a fault of the line; an outage is said
 * to have lasted "at least" what the checks prove; every limit names its
 * source. Everything that comes from the modem, the stored files or the
 * settings goes through esc(). A literal percent sign in a string passed
 * to .format() is written %%.
 *
 * SPDX-License-Identifier: MIT
 */

var H = mh.health, esc = mh.esc;

/* Less than this much time between the first and the last check, and the
 * report calls itself preliminary (Modem Health's own rule of thumb). */
var PRELIMINARY_S = 72 * 3600;

var PERIODS = [ [ '1', _('Last 24 hours') ], [ '7', _('Last 7 days') ], [ '30', _('Last 30 days') ],
	[ 'all', _('Everything stored') ], [ 'custom', _('Custom dates…') ] ];

var KIND = {
	sync_loss: [ _('loss of downstream sync'), _('losses of downstream sync') ],
	t3: [ _('T3 time-out'), _('T3 time-outs') ],
	t4: [ _('T4 time-out'), _('T4 time-outs') ],
	t2: [ _('T2 time-out'), _('T2 time-outs') ],
	t6: [ _('T6 time-out'), _('T6 time-outs') ],
	mdd_loss: [ _('lost-MDD time-out'), _('lost-MDD time-outs') ]
};
var KIND_ORDER = [ 'sync_loss', 't4', 't3', 't2', 't6', 'mdd_loss' ];

var LEVEL = { good: _('good'), marginal: _('acceptable, outside the good range'), bad: _('out of spec'), unknown: _('unknown') };

/* -------------------------------------------------------------- period -- */

function localDay(s, end) {
	var m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(s || '');
	if (!m) return null;
	return Math.floor(new Date(+m[1], m[2] - 1, +m[3], end ? 23 : 0, end ? 59 : 0, end ? 59 : 0).getTime() / 1000);
}

/* The period a choice stands for, as { from, to } in epoch seconds.
 * now: the router's clock; historyDays: how long the router keeps history. */
function periodWindow(period, now, fromDate, toDate, historyDays) {
	if (period === 'custom') {
		var a = localDay(fromDate, false), b = localDay(toDate, true);
		if (a == null) a = now - 7 * 86400;
		if (b == null || b > now) b = now;
		return { from: Math.min(a, b), to: b };
	}
	if (period === 'all')
		return { from: now - (+historyDays || 90) * 86400, to: now };
	return { from: now - (+period || 7) * 86400, to: now };
}

/* -------------------------------------------------------------- helpers -- */

function n(count, one, many) {
	return '%d %s'.format(count, count === 1 ? one : many);
}

function pct(part, of) {
	if (!of) return '0%';
	var p = part / of * 100;
	return (p > 0 && p < 0.1 ? '<0.1' : p >= 99.95 && part < of ? '>99.9' : p.toFixed(p < 10 ? 1 : 0)) + '%';
}

function day(ts) { return mh.fmtTime(ts).slice(0, 10); }
function clock(ts) { return mh.isoTime(ts).slice(11); }

function zone(ts) {
	var off = -new Date(ts * 1000).getTimezoneOffset(), a = Math.abs(off);
	return 'UTC%s%s:%s'.format(off < 0 ? '−' : '+', (a / 60 < 10 ? '0' : '') + Math.floor(a / 60), (a % 60 < 10 ? '0' : '') + a % 60);
}

function range(r, scale, unit) {
	var f = function(v) { return String(+(v * (scale || 1)).toFixed(2)); };
	if (!r || (r[0] == null && r[1] == null)) return '–';
	if (r[0] == null && r[1] === 0) return _('none');
	var u = unit ? ' ' + unit : '';
	if (r[0] == null) return _('up to %s').format(f(r[1])) + u;
	if (r[1] == null) return _('%s or more').format(f(r[0])) + u;
	return '%s to %s'.format(f(r[0]), f(r[1])) + u;
}

function table(head, rows, cls) {
	return '<table class="' + (cls || '') + '"><thead><tr>' + head.map(function(h) { return '<th>' + esc(h) + '</th>'; }).join('') +
		'</tr></thead><tbody>' + rows.map(function(r) {
			return '<tr' + (r.cls ? ' class="' + r.cls + '"' : '') + '>' + (r.cells || r).map(function(c) {
				return '<td>' + (c && c.html != null ? c.html : esc(c == null ? '' : c)) + '</td>';
			}).join('') + '</tr>';
		}).join('') + '</tbody></table>';
}

function list(items) {
	return '<ul>' + items.map(function(i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul>';
}

function legend(items) {
	return '<p class="legend">' + items.map(function(i) {
		return '<span><i style="background:' + esc(i.color) + (i.faint ? ';opacity:.35' : '') + '"></i>' + esc(i.name) + '</span>';
	}).join('') + '</p>';
}

/* Points reduced to at most `max` slots of equal length, each holding
 * agg() of its values (or nothing: a gap). -> { points, width } */
function slots(points, from, to, max, agg) {
	if (points.length <= max) return { points: points, width: null };
	var w = Math.max((to - from) / max, 1), box = [], i;
	for (i = 0; i < max; i++) box.push([]);
	points.forEach(function(p) {
		var k = Math.floor((p[0] - from) / w);
		if (p[1] != null && k >= 0 && k < max) box[k].push(p[1]);
	});
	return { points: box.map(function(v, k) { return [ from + (k + 0.5) * w, v.length ? agg(v) : null ]; }), width: w };
}
function lowest(a) { return Math.min.apply(null, a); }
function highest(a) { return Math.max.apply(null, a); }
function total(a) { return a.reduce(function(s, v) { return s + v; }, 0); }

/* ---------------------------------------------------------------- style -- */

var css = [
	'@page{margin:16mm 14mm}',
	':root{color-scheme:light}',
	'body{font:14px/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#1c1c1e;background:#fff;margin:0 auto;padding:24px 28px;max-width:960px}',
	'h1{font-size:24px;line-height:1.25;margin:0 0 4px}',
	'h2{font-size:18px;margin:28px 0 8px;padding-bottom:4px;border-bottom:2px solid #1c1c1e;break-after:avoid}',
	'h3{font-size:15px;margin:18px 0 6px;break-after:avoid}',
	'p{margin:6px 0}',
	'.sub{color:#555;margin:0 0 14px}',
	'.box{border:1px solid #c9c9c9;border-radius:6px;padding:10px 14px;margin:12px 0;break-inside:avoid}',
	'.box.failing{border-color:#b3261e;background:#fbeeed}',
	'.box.degraded{border-color:#b7791f;background:#fff7e5}',
	'.box.healthy{border-color:#2e7d4f;background:#edf7f0}',
	'.box.unknown,.box.prelim{border-color:#8a8a8a;background:#f3f4f6}',
	'.box h3{margin-top:0}',
	'ul{margin:6px 0 6px 20px;padding:0}',
	'li{margin:2px 0}',
	'table{border-collapse:collapse;width:100%;margin:8px 0;font-size:13px}',
	'th,td{text-align:left;vertical-align:top;padding:4px 8px;border-bottom:1px solid #dcdcdc}',
	'th{background:#f3f4f6;font-weight:600}',
	'tr{break-inside:avoid}',
	'table.kv th{width:15em;background:none}',
	'tr.total td{font-weight:600;border-top:2px solid #1c1c1e}',
	'table.days th:first-child,table.days td:first-child{white-space:nowrap}',
	'.bad{color:#b3261e;font-weight:600}',
	'.marginal{color:#8a5a00;font-weight:600}',
	'.note{color:#555;font-size:13px}',
	'figure{margin:14px 0;break-inside:avoid}',
	'figcaption{font-weight:600;margin-bottom:2px}',
	'.mh-chart{display:block;max-width:100%;height:auto}',
	'.legend{font-size:12px;margin:2px 0}',
	'.legend span{display:inline-block;margin-right:14px}',
	'.legend i{display:inline-block;width:18px;height:8px;border-radius:2px;margin-right:5px}',
	'.times{font-size:12px;margin:2px 0 8px}',
	'.times strong{font-weight:600}',
	'.statement{white-space:pre-wrap;border-left:3px solid #8a8a8a;padding:4px 12px;margin:8px 0}',
	'footer{margin-top:28px;padding-top:8px;border-top:1px solid #c9c9c9;color:#555;font-size:12px}',
	'a{color:#1f5fae}',
	'@media print{body{padding:0;max-width:none}a{color:inherit;text-decoration:none}}'
].join('\n');

/* --------------------------------------------------------------- report -- */

/* build(G, o)
 * G: a digest (common.js: loadDigest), analysed.
 * o: {
 *   modem:   { model, firmware, mac, docsis }   (from the router's status)
 *   sub:     { isp, subscriber, account, address } (from Settings)
 *   notes:   the subscriber's statement, in their words
 *   changed: [ { key, limit } ]  limits the owner changed (health.applySettings)
 *   interval: minutes between checks; ping_host: what is pinged
 *   generated: when (epoch s, the router's clock); version: Modem Health's
 *   times: false leaves out the list of every event's time
 * }
 * With ISPy's speed tests in the digest (G.speedTests), the report gains a
 * section that sets them against the line's problems.
 * -> { body, page(), findings: [ { level, text } ], preliminary, level } */
function build(G, o) {
	o = o || {};
	var L = G.limits || H.LIMITS, R = G.readings || [], modem = o.modem || {}, sub = o.sub || {};
	var good = R.filter(function(r) { return r.result === 'ok'; }), failed = R.filter(function(r) { return r.result !== 'ok'; });
	var first = R.length ? +R[0].ts : null, last = R.length ? +R[R.length - 1].ts : null;
	var covered = first != null ? last - first : 0;
	var P = G.period || { level: 'unknown', reasons: [], counts: { events: {} }, hours: 0 }, counts = P.counts, ev = counts.events || {};
	var outages = G.outages || [], reboots = G.reboots || [], regs = G.reregistrations || [];
	var hours = P.hours || 0, days = hours / 24;
	var preliminary = R.length > 0 && covered < PRELIMINARY_S;
	var interval = o.interval || G.interval || 5;
	var disruptive = (G.events || []).filter(function(e) { return H.DISRUPTIVE[e.kind]; });
	var rate = function(count) {
		return days >= 1 ? _(' (%.1f a day on average)').format(count / days) : '';
	};

	/* ------------------------------------------------------ 1 findings */
	var findings = [], say = function(level, text) { findings.push({ level: level, text: text }); };
	var failing = counts.failing || 0, degraded = counts.degraded || 0, judged = good.length;
	var unc = 0, corr = 0, uncKnown = false;
	good.forEach(function(r) {
		if (r.agg && r.agg.unc != null) { unc += r.agg.unc; uncKnown = true; }
		if (r.agg && r.agg.corr != null) corr += r.agg.corr;
	});

	if (outages.length) {
		var least = total(outages.map(function(x) { return x.minS || 0; }));
		say('bad', _('%s with no internet connection, %s in total at the least.').format(n(outages.length, _('outage'), _('outages')), mh.fmtDuration(least)));
	}
	KIND_ORDER.forEach(function(k) {
		if (!ev[k]) return;
		var level = (P.reasons.filter(function(r) { return r.kind === k; })[0] || {}).level || (k === 't3' ? 'good' : 'bad');
		say(level, n(ev[k], KIND[k][0], KIND[k][1]) + rate(ev[k]) + _(' in the modem\'s own log.'));
	});
	if (regs.length)
		say('marginal', _('The modem had to register with the ISP\'s network again %s without being restarted.').format(n(regs.length, _('time'), _('times'))));
	if (reboots.length)
		say((P.reasons.filter(function(r) { return r.kind === 'reboot'; })[0] || {}).level || 'marginal',
			_('The modem restarted %s.').format(n(reboots.length, _('time'), _('times'))));
	if (failing)
		say('bad', _('%s of the %s that read the modem (%s) found at least one value out of spec.')
			.format(failing, n(judged, _('check'), _('checks')), pct(failing, judged)));
	if (degraded)
		say('marginal', _('%s of the %s that read the modem (%s) found a value outside the good range but within spec.')
			.format(degraded, n(judged, _('check'), _('checks')), pct(degraded, judged)));
	if (uncKnown && unc > 0)
		say('info', _('The modem counted %s uncorrectable codewords (data that was lost and had to be sent again) and %s corrected ones. These are reported, not judged: no published limit exists for them.')
			.format(mh.fmtInt(unc), mh.fmtInt(corr)));
	if (failed.length)
		say('info', _('%s could not read the modem and %s counted as unknown, not as a fault of the line.')
			.format(n(failed.length, _('check'), _('checks')), failed.length === 1 ? _('is') : _('are')));
	/* ISPy's speed tests, lined up with the above (null: ISPy has none). */
	var ST = G.speedTests || null, sc = ST ? ST.counts : null, win = ST ? Math.round(ST.windowS / 60) : 0;
	if (ST && sc.slow.total)
		say('info', _('%d of %s started within %d minutes of a line problem the modem recorded%s%s (section 5).').format(sc.slow.problem,
			n(sc.slow.total, _('slow speed test'), _('slow speed tests')), win,
			sc.slow.unknown ? _(' (for %d it is not known: no check read the modem then)').format(sc.slow.unknown) : '',
			sc.fine.total ? _('; so did %d of %s').format(sc.fine.problem, n(sc.fine.total, _('test that was not slow'), _('tests that were not slow'))) : ''));

	var problems = findings.filter(function(f) { return f.level === 'bad' || f.level === 'marginal'; }).length;
	var level = P.level, headline;
	if (!R.length) {
		level = 'unknown';
		headline = _('No checks are stored for this period, so nothing can be said about the line.');
	}
	else if (!judged) {
		level = 'unknown';
		headline = _('None of the %s in this period could read the modem, so the line could not be judged.').format(n(R.length, _('check'), _('checks')));
	}
	else if (level === 'failing')
		headline = _('The line had faults in this period.');
	else if (level === 'degraded')
		headline = _('The line worked in this period, with values outside the recommended range.');
	else if (!problems) {
		level = 'healthy';
		headline = failed.length
			? _('No problems found in the %s that read the modem.').format(n(judged, _('check'), _('checks')))
			: _('No problems found. Every one of the %s found the signal within the good range, and the modem logged no outage, time-out or loss of sync.').format(n(judged, _('check'), _('checks')));
	}
	else
		headline = _('The line worked in this period, with the remarks below.');

	var mark = function(lv, text) {
		return lv === 'bad' || lv === 'marginal' ? '<span class="' + lv + '">' + esc(text) + '</span>' : esc(text);
	};
	var summary = '<div class="box ' + esc(level) + '"><h3>' + esc(headline) + '</h3>' +
		(findings.length ? '<ul>' + findings.map(function(f) { return '<li>' + mark(f.level, f.text) + '</li>'; }).join('') + '</ul>' : '') + '</div>' +
		(preliminary ? '<div class="box prelim"><strong>' + esc(_('Preliminary.')) + '</strong> ' +
			esc(_('The checks in this report span only %s. A line can look better or worse over a few hours than it is; Modem Health asks for at least three days before a report is relied on.')
				/* Rounded down: "3 d 0 h" would contradict the sentence. */
				.format(covered < 3600 ? mh.fmtDuration(covered) : n(Math.floor(covered / 3600), _('hour'), _('hours')))) + '</div>' : '');

	/* ------------------------------------------------- 2 modem and line */
	var reasons = {};
	failed.forEach(function(r) { reasons[r.reason || '?'] = (reasons[r.reason || '?'] || 0) + 1; });
	var kv = [
		[ _('Modem'), [ modem.model, modem.docsis ].filter(Boolean).join(' · ') || _('not read yet') ],
		[ _('Firmware'), modem.firmware || '–' ],
		[ _('Modem MAC address'), modem.mac || '–' ]
	];
	if (sub.isp) kv.push([ _('Provider'), sub.isp ]);
	if (sub.subscriber) kv.push([ _('Subscriber'), sub.subscriber ]);
	if (sub.account) kv.push([ _('Account number'), sub.account ]);
	if (sub.address) kv.push([ _('Service address'), sub.address ]);
	kv.push([ _('Period of this report'), '%s to %s'.format(mh.fmtTime(G.since), mh.fmtTime(G.until)) ]);
	kv.push([ _('First and last check in it'), first != null ? '%s to %s (%s)'.format(mh.fmtTime(first), mh.fmtTime(last), mh.fmtDuration(covered)) : _('none') ]);
	kv.push([ _('Checks made'), n(R.length, _('check'), _('checks')) + _(', one every %d minutes').format(interval) ]);
	kv.push([ _('Checks that could not read the modem'), failed.length
		? '%d (%s)'.format(failed.length, Object.keys(reasons).sort().map(function(k) { return '%s: %d'.format(k, reasons[k]); }).join(', '))
		: '0' ]);
	kv.push([ _('Times in this report'), _('%s, the time zone of the device that made it').format(zone(o.generated || G.until)) ]);
	var line = '<table class="kv"><tbody>' + kv.map(function(r) { return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</tbody></table>';

	/* --------------------------------------------------------- 3 events */
	var byDay = {}, dayOf = function(ts) {
		var k = day(ts);
		return byDay[k] || (byDay[k] = { day: k, checks: 0, failed: 0, failing: 0, degraded: 0, kinds: {}, regs: 0, restarts: 0, outages: 0, unc: 0, times: {} });
	};
	R.forEach(function(r) {
		var d = dayOf(+r.ts);
		d.checks++;
		if (r.result !== 'ok') d.failed++;
		else if (r.verdict.level === H.FAILING) d.failing++;
		else if (r.verdict.level === H.DEGRADED) d.degraded++;
		if (r.agg && r.agg.unc != null) d.unc += r.agg.unc;
	});
	var stamp = function(d, what, ts) { (d.times[what] = d.times[what] || []).push(clock(ts)); };
	disruptive.forEach(function(e) { var d = dayOf(e.ts); d.kinds[e.kind] = (d.kinds[e.kind] || 0) + 1; stamp(d, e.kind, e.ts); });
	regs.forEach(function(r) { var ts = r.events[0].ts, d = dayOf(ts); d.regs++; stamp(d, 'reg', ts); });
	reboots.forEach(function(r) { var ts = +r.boot_ts || +r.ts, d = dayOf(ts); d.restarts++; stamp(d, 'restart', ts); });
	outages.forEach(function(x) { var d = dayOf(x.start); d.outages++; stamp(d, 'outage', x.start); });
	var dayList = Object.keys(byDay).sort().map(function(k) { return byDay[k]; });
	var sum = function(f) { return total(dayList.map(f)); };
	var z = function(v) { return v ? String(v) : '–'; };
	var dayRow = function(d, label) {
		var k = d.kinds;
		return [ label, d.checks, z(d.failed), z(d.failing), z(d.degraded), z(d.outages), z(k.sync_loss), z(k.t3), z(k.t4),
			z((k.t2 || 0) + (k.t6 || 0) + (k.mdd_loss || 0)), z(d.regs), z(d.restarts), uncKnown ? mh.fmtInt(d.unc) : '–' ];
	};
	var totals = { checks: R.length, failed: failed.length, failing: failing, degraded: degraded, outages: outages.length,
		kinds: ev, regs: regs.length, restarts: reboots.length, unc: unc };
	var dayTable = table([ _('Day'), _('Checks'), _('Could not read'), _('Out of spec'), _('Outside good range'), _('Outages'),
		_('Losses of sync'), _('T3'), _('T4'), _('Other time-outs'), _('Re-registrations'), _('Restarts'), _('Uncorrectable') ],
		dayList.map(function(d) { return dayRow(d, d.day); }).concat(dayList.length > 1 ? [ { cls: 'total', cells: dayRow(totals, _('Total')) } ] : []), 'days');

	var outageTable = outages.length ? table([ _('First check that found it down'), _('What did not answer'), _('Lasted at least'), _('Lasted at most'), _('Checks that found it down') ],
		outages.map(function(x) {
			return [ mh.fmtTime(x.start), x.kind === 'line_down' ? _('The internet; the modem still answered') : _('The internet and the modem'),
				mh.fmtDuration(x.minS), x.ongoing ? _('still down at the last check') : (x.maxS != null ? mh.fmtDuration(x.maxS) : _('unknown')), x.checks ];
		})) : '<p>' + esc(_('No outage: at every check that could ping, the internet host answered.')) + '</p>';

	var what = { reg: _('Re-registration'), restart: _('Modem restart'), outage: _('Outage found') };
	var timesHtml = '';
	if (o.times !== false) {
		var withTimes = dayList.filter(function(d) { return Object.keys(d.times).length; });
		timesHtml = '<h3>' + esc(_('Every event, with its time')) + '</h3>' + (withTimes.length ? withTimes.map(function(d) {
			return '<p class="times"><strong>' + esc(d.day) + '</strong><br>' + KIND_ORDER.concat([ 'reg', 'restart', 'outage' ]).filter(function(k) { return d.times[k]; }).map(function(k) {
				var name = KIND[k] ? KIND[k][0].charAt(0).toUpperCase() + KIND[k][0].slice(1) : what[k];
				return esc('%s (%d): %s'.format(name, d.times[k].length, d.times[k].join(', ')));
			}).join('<br>') + '</p>';
		}).join('') : '<p>' + esc(_('None in this period.')) + '</p>');
	}
	var failedHtml = failed.length ? '<h3>' + esc(_('Checks that could not read the modem')) + '</h3>' +
		(failed.length <= 60
			? table([ _('Time'), _('Why') ], failed.map(function(r) { return [ mh.fmtTime(+r.ts), r.reason || '?' ]; }))
			: '<p>' + esc(_('%d checks; their number per day is in the table above, and each one is in the exported data.').format(failed.length)) + '</p>') : '';

	/* --------------------------------------------------------- 4 signal */
	var tallies = Object.keys(G.channels || {}).map(function(k) { return G.channels[k]; });
	var isOfdm = function(t) { return /OFDM/.test(t.modulation || ''); };
	var latestRows = G.latest ? G.latest.verdict.channels.map(function(v) { return v.channel; }) : [];
	var usCount = latestRows.filter(function(c) { return c.dir === 'us' && !/OFDM/.test(c.modulation || ''); }).length ||
		tallies.filter(function(t) { return t.dir === 'us' && !isOfdm(t); }).length || 1;
	var usLimit = H.limitsFor({ dir: 'us', modulation: 'SC-QAM' }, usCount, L).power;
	var extremes = function(list, lo, hi) {
		var a = list.map(function(t) { return t[lo]; }).filter(function(v) { return v != null; });
		var b = list.map(function(t) { return t[hi]; }).filter(function(v) { return v != null; });
		return a.length ? [ lowest(a), highest(b) ] : null;
	};
	var group = function(dir, ofdm) { return tallies.filter(function(t) { return t.dir === dir && isOfdm(t) === ofdm; }); };
	var measured = [];
	var addMeasured = function(limit, ext) {
		if (!ext || !limit) return;
		var worst = H.band(ext[0], limit), w2 = H.band(ext[1], limit);
		if (w2 === 'bad' || (w2 === 'marginal' && worst === 'good')) worst = w2;
		measured.push({ cells: [ limit.label, String(ext[0]), String(ext[1]), range(limit.good, 1, limit.unit), range(limit.marginal, 1, limit.unit),
			{ html: mark(worst, LEVEL[worst]) } ] });
	};
	addMeasured(L.ds_power, extremes(group('ds', false), 'powerMin', 'powerMax'));
	addMeasured(L.ds_snr, extremes(group('ds', false), 'snrMin', 'snrMax'));
	addMeasured(L.ds_power_ofdm, extremes(group('ds', true), 'powerMin', 'powerMax'));
	addMeasured(L.ds_mer_ofdm, extremes(group('ds', true), 'snrMin', 'snrMax'));
	addMeasured(usLimit, extremes(group('us', false), 'powerMin', 'powerMax'));
	addMeasured(L.us_power_ofdma, extremes(group('us', true), 'powerMin', 'powerMax'));
	var measuredHtml = measured.length ? table([ _('Value'), _('Lowest seen'), _('Highest seen'), _('Good'), _('Acceptable'), _('Worst seen was') ], measured) +
		'<p class="note">' + esc(_('Lowest and highest of any channel at any check in the period. A value exactly at a limit is within it.')) + '</p>' : '';

	var troubled = tallies.filter(function(t) { return t.bad || t.marginal || t.unlocked; })
		.sort(function(a, b) { return b.bad - a.bad || b.marginal - a.marginal || b.unlocked - a.unlocked; });
	var mhz = function(hz) { var v = H.num(hz); return v == null ? '–' : String(+(v / 1e6).toFixed(1)); };
	var span2 = function(a, b) { return a == null ? '–' : (a === b ? String(a) : '%s to %s'.format(a, b)); };
	var worstHtml = troubled.length ? table([ _('Channel'), _('Type'), _('MHz'), _('Checks'), _('Out of spec'), _('Outside good range'), _('Not locked'),
		_('Power, dBmV'), _('SNR/MER, dB'), _('Uncorrectable') ],
		troubled.slice(0, 12).map(function(t) {
			return [ '%s %s'.format(t.dir === 'ds' ? _('Downstream') : _('Upstream'), t.channel_id), t.modulation || '–', mhz(t.freq_hz), t.n,
				t.bad ? '%d (%s)'.format(t.bad, pct(t.bad, t.n)) : '–', t.marginal ? '%d (%s)'.format(t.marginal, pct(t.marginal, t.n)) : '–',
				z(t.unlocked), span2(t.powerMin, t.powerMax), t.dir === 'ds' ? span2(t.snrMin, t.snrMax) : '–', t.dir === 'ds' ? mh.fmtInt(t.unc) : '–' ];
		})) + (troubled.length > 12 ? '<p class="note">' + esc(_('The 12 channels with the most checks out of spec, of %d with any remark.').format(troubled.length)) + '</p>' : '')
		: '<p>' + esc(_('No channel had a value outside the good range at any check.')) + '</p>';

	/* The time axis every chart shares, with the outages shaded and a tick
	 * for each stretch that had events. */
	var charts = '', MAX = 350, to = G.until;
	var from = first != null ? Math.max(G.since, first - Math.max((G.until - first) * 0.03, 300)) : G.since;
	var slotW = Math.max((to - from) / 330, 1), marked = {};
	disruptive.forEach(function(e) { var k = Math.floor((e.ts - from) / slotW); marked[k] = (marked[k] || 0) + 1; });
	var marks = Object.keys(marked).map(function(k) {
		return { ts: from + (+k + 0.5) * slotW, color: mh.C.bad, label: _('%s around %s').format(n(marked[k], _('event'), _('events')), mh.fmtTime(from + (+k + 0.5) * slotW)) };
	});
	reboots.forEach(function(r) { marks.push({ ts: +r.boot_ts || +r.ts, color: '#8e44ad', label: _('Modem restarted') }); });
	var common = { from: from, to: to, marks: marks,
		spans: outages.map(function(x) { return { from: x.start - 60, to: (x.end || x.start) + 60, color: mh.C.bad, label: _('Outage, %s').format(mh.fmtTime(x.start)) }; }) };
	var fig = function(title, note, opt, leg) {
		opt.title = title;
		Object.keys(common).forEach(function(k) { if (opt[k] == null) opt[k] = common[k]; });
		return '<figure><figcaption>' + esc(title) + '</figcaption><p class="note">' + esc(note) + '</p>' + legend(leg) + mh.chartSVG(opt) + '</figure>';
	};
	var chartKey = _('Red shading: an outage. Red ticks at the top: losses of sync and time-outs. Purple ticks: modem restarts.');
	if (good.length) {
		var pts = function(f) { return R.map(function(r) { return [ +r.ts, r.result === 'ok' && r.agg ? f(r.agg) : null ]; }); };
		var W = null, cut = function(f, agg) {
			var s = slots(pts(f), from, to, MAX, agg);
			if (s.width) W = s.width;
			return s.points;
		};
		var series = {
			pmin: cut(function(a) { return a.dsPowerMin; }, lowest), pmax: cut(function(a) { return a.dsPowerMax; }, highest),
			snr: cut(function(a) { return a.snrMin; }, lowest), mer: cut(function(a) { return a.merMin; }, lowest),
			unc: cut(function(a) { return a.unc; }, total)
		};
		var usIds = {};
		tallies.forEach(function(t) { if (t.dir === 'us') usIds[t.channel_id] = t.modulation || ''; });
		var usSeries = Object.keys(usIds).sort(function(a, b) { return a - b; }).map(function(id, i) {
			return { name: '%s %s'.format(usIds[id], id), color: mh.C.series[i % mh.C.series.length], dash: /OFDM/.test(usIds[id]) ? '4 3' : null,
				points: cut(function(a) { return a.us[id] != null ? a.us[id] : null; }, highest) };
		});
		var step = W || interval * 60;
		common.gap = Math.max(step * 3, 900);
		common.interval = step;
		var bands = function(limit) {
			return limit && limit.good ? [ { lo: limit.marginal[0], hi: limit.marginal[1], color: mh.C.marginal }, { lo: limit.good[0], hi: limit.good[1], color: mh.C.good } ] : [];
		};
		var per = W ? _(' Each point stands for %s: the worst value of that stretch.').format(mh.fmtDuration(W)) : '';
		charts = fig(_('Downstream power (dBmV)'), _('Lowest and highest SC-QAM channel at each check.') + per,
				{ bands: bands(L.ds_power), series: [ { name: _('lowest channel'), color: mh.C.series[0], points: series.pmin }, { name: _('highest channel'), color: mh.C.series[1], points: series.pmax } ] },
				[ { name: _('lowest channel'), color: mh.C.series[0] }, { name: _('highest channel'), color: mh.C.series[1] } ]) +
			fig(_('Downstream SNR and MER (dB)'), _('Worst SC-QAM channel (SNR) and worst OFDM channel (MER) at each check.') + per,
				{ bands: bands(L.ds_snr), series: [ { name: _('worst SC-QAM SNR'), color: mh.C.series[0], points: series.snr }, { name: _('worst OFDM MER'), color: mh.C.series[2], points: series.mer, dash: '4 3' } ] },
				[ { name: _('worst SC-QAM SNR'), color: mh.C.series[0] }, { name: _('worst OFDM MER'), color: mh.C.series[2] } ]) +
			fig(_('Upstream power (dBmV)'), _('How hard the modem has to transmit to reach the ISP, per channel. Shaded: the range for %d bonded SC-QAM channels.').format(usCount) + per,
				{ bands: bands(usLimit), series: usSeries }, usSeries.map(function(s) { return { name: s.name, color: s.color }; })) +
			fig(_('Uncorrectable codewords'), W ? _('Lost data across all downstream channels, added up over each %s.').format(mh.fmtDuration(W))
					: _('Lost data across all downstream channels since the check before.'),
				{ zero: true, series: [ { name: _('uncorrectable'), color: mh.C.bad, points: series.unc, bars: true } ] }, [ { name: _('uncorrectable'), color: mh.C.bad } ]) +
			'<p class="note">' + esc(_('Green: the good range. Amber: acceptable.') + ' ' + chartKey + ' ' + _('A break in a line: no check, or a check that could not read the modem.')) + '</p>';
	}

	/* ---------------------------------------------------- 5 speed tests */
	var speedHtml = '';
	if (ST) {
		var groups = [ [ 'slow', _('Slow tests') ], [ 'fine', _('Tests that were not slow') ], [ 'unjudged', _('Tests') ], [ 'failed', _('Tests that did not complete') ] ]
			.filter(function(g) { return sc[g[0]].total; });
		var STATE = {
			outage: _('An outage (no internet)'),
			events: _('A loss of sync or time-out in the modem\'s log'),
			out_of_spec: _('A signal value out of spec'),
			marginal: _('A signal value outside the good range, but within spec'),
			clear: _('Nothing: the checks around the test found every value good'),
			unknown: _('Not known: no check read the modem then')
		};
		var across = function(label, key, cls) {
			return { cls: cls, cells: [ label ].concat(groups.map(function(g) { return sc[g[0]][key]; })) };
		};
		var stateRows = [];
		H.LINE_STATES.forEach(function(k) {
			stateRows.push(across(STATE[k], k));
			if (k === 'out_of_spec') stateRows.push(across(_('A line problem (the three above together)'), 'problem', 'total'));
		});
		stateRows.push(across(_('All tests'), 'total', 'total'));
		var judgedOn = mh.speedDirections(ST), ran = ST.n - sc.failed.total;
		var advertised = [ ST.plan.down ? _('%s download').format(mh.fmtMbps(ST.plan.down)) : '', ST.plan.up ? _('%s upload').format(mh.fmtMbps(ST.plan.up)) : '' ].filter(Boolean).join(', ');
		var intro = _('Speed was measured by ISPy, a separate app on the same router, which ran %s in this period%s.')
			.format(n(ST.n, _('speed test'), _('speed tests')), sc.failed.total ? _(', of which %d did not complete').format(sc.failed.total) : '') + ' ' +
			(advertised
				? _('A test is called slow when its %s speed was below 80%% of the advertised speed set in ISPy (%s).').format(judgedOn, advertised)
				: _('No advertised speed is set in ISPy, so no test is called slow or not slow here.')) + ' ' +
			_('Each test is set against what the modem recorded within %d minutes of the moment the test started.').format(win);
		var speedFacts = [];
		if (advertised && ran) {
			speedFacts.push(sc.slow.total
				? _('%s: %d started within %d minutes of a line problem, %d did not%s.').format(n(sc.slow.total, _('slow test'), _('slow tests')), sc.slow.problem, win,
					sc.slow.total - sc.slow.problem - sc.slow.unknown, sc.slow.unknown ? _(', and for %d it is not known').format(sc.slow.unknown) : '')
				: _('No test was slow.'));
			if (sc.fine.total)
				speedFacts.push(_('%s: %d started within %d minutes of a line problem, %d did not%s.').format(n(sc.fine.total, _('test that was not slow'), _('tests that were not slow')), sc.fine.problem, win,
					sc.fine.total - sc.fine.problem - sc.fine.unknown, sc.fine.unknown ? _(', and for %d it is not known').format(sc.fine.unknown) : ''));
		}
		if (sc.failed.total)
			speedFacts.push(_('%s: %d within %d minutes of a line problem. A test that did not complete is not counted as slow.')
				.format(n(sc.failed.total, _('test that did not complete'), _('tests that did not complete')), sc.failed.problem, win));
		var chart = mh.speedChart(ST, { from: from, to: to, max: MAX });
		var speedFig = fig(chart.percent ? _('Speed tests (percent of the advertised speed)') : _('Speed tests (Mbit/s)'),
			_('Each dot is one test, at the time it started.') + (chart.stretch ? ' ' + _('Where tests are too close together to draw, the slowest of each %s is shown.').format(mh.fmtDuration(chart.stretch)) : '') +
				(chart.before ? ' ' + _('%s from before the first check of the modem are in the table but not in this chart.').format(n(chart.before, _('test'), _('tests'))) : ''),
			{ zero: true, suffix: chart.chart.suffix, tickStep: chart.chart.tickStep, series: chart.chart.series, bands: chart.chart.bands, marks: marks.concat(chart.chart.marks) }, chart.legend) +
			'<p class="note">' + esc(chartKey + (chart.chart.marks.length ? ' ' + _('Grey ticks at the bottom: speed tests that did not complete.') : '')) + '</p>';
		var slow = ST.tests.filter(function(t) { return t.group === 'slow'; }), SHOWN = 40;
		var speedCell = function(v, share, isSlow) {
			var text = mh.fmtMbps(v) + (share != null ? ' (%d%%)'.format(Math.round(share * 100)) : '');
			return isSlow ? { html: '<span class="bad">' + esc(text) + '</span>' } : text;
		};
		/* What the modem lost at the time of a test: the uncorrectable
		 * codewords of the first check that read the modem after the test
		 * started. They are counted since the check before, so that count
		 * covers the start of the test. Reported, not judged. */
		var lostAt = function(ts) {
			var lo = 0, hi = good.length;
			while (lo < hi) { var mid = (lo + hi) >> 1; if (+good[mid].ts < ts) lo = mid + 1; else hi = mid; }
			var r = good[lo];
			return r && +r.ts <= ts + ST.windowS && r.agg && r.agg.unc != null ? mh.fmtInt(r.agg.unc) : '–';
		};
		var slowHtml = slow.length ? '<h3>' + esc(_('The slow tests')) + '</h3>' +
			table([ _('Test started'), _('Download'), _('Upload'), _('Within %d minutes, the modem recorded').format(win) ].concat(uncKnown ? [ _('Uncorrectable codewords at the next check') ] : []),
				slow.slice(-SHOWN).map(function(t) {
					return [ mh.fmtTime(t.ts), speedCell(t.down, t.downShare, t.slowDown), speedCell(t.up, t.upShare, t.slowUp), STATE[t.line] ].concat(uncKnown ? [ lostAt(t.ts) ] : []);
				}), 'days') + '<p class="note">' + esc((slow.length > SHOWN ? _('The %d most recent of %d slow tests.').format(SHOWN, slow.length) + ' ' : '') +
				_('In brackets: the share of the advertised speed.') + (uncKnown ? ' ' + _('Uncorrectable codewords: data the modem lost, as counted by the first check after the test started. That count runs from the check before it, so it covers the start of the test. It is reported, not judged: no published limit exists for it.') : '') +
				' ' + _('ISPy\'s own report and results file hold every test.')) + '</p>' : '';
		speedHtml = '<p>' + esc(intro) + '</p>' + (speedFacts.length ? list(speedFacts) : '') +
			table([ _('Within %d minutes of the test, the modem recorded').format(win) ].concat(groups.map(function(g) { return g[1]; })), stateRows) +
			'<p class="note">' + esc(_('Each test is counted once, in the first row that applies. A line problem is one of the first three rows; a value outside the good range but within spec is shown apart and not counted as one.')) + '</p>' +
			'<p class="note">' + esc(_('This table shows what happened at the same time; that alone does not prove the cause. A test can also be slow because of the home network, the router\'s load or the test server; ISPy\'s own report deals with those.')) + '</p>' +
			speedFig + slowHtml;
	}

	/* ------------------------------------------------- 5 how measured */
	var cited = [], cite = function(keys) {
		return keys.map(function(k) {
			if (cited.indexOf(k) < 0) cited.push(k);
			return '[' + (cited.indexOf(k) + 1) + ']';
		}).join(' ');
	};
	var limitRows = H.limitList(L).map(function(it) {
		var l = it.limit, scale = l.unit === 'share' ? 100 : 1, unit = l.unit === 'share' ? _('percent of checks') : l.unit;
		return [ l.label + (l.default ? _(' (changed by the owner; default: good %s, acceptable %s)').format(range(l.default.good, scale), range(l.default.marginal, scale)) : ''),
			range(l.good, scale, unit), range(l.marginal, scale, unit), cite(l.sources) ];
	});
	limitRows.push([ L.lock.label, _('locked'), '–', cite(L.lock.sources) ]);
	var sourcesHtml = '<ol class="note">' + cited.map(function(k) {
		var s = H.SOURCES[k];
		return '<li>' + esc(s.title) + (s.url ? ' – <a href="' + esc(s.url) + '">' + esc(s.url) + '</a>' : '') + (s.note ? ' – ' + esc(s.note) : '') + '</li>';
	}).join('') + '</ol>';
	var how = '<p>' + esc(_('The customer\'s router logs in to the cable modem\'s own status pages every %d minutes and stores what the modem reports: each channel\'s power, signal-to-noise ratio, lock state and error counters, and the modem\'s event log. At the same check it sends three pings to the modem and three to %s. Nothing is measured by the router itself except those pings.')
		.format(interval, o.ping_host || '1.1.1.1')) + '</p>' +
		'<h3>' + esc(_('Limits the values were judged against')) + '</h3>' +
		table([ _('Value'), _('Good'), _('Acceptable'), _('Source') ], limitRows) + sourcesHtml +
		'<p class="note">' + esc(_('A value within "good" is good; outside "good" but within "acceptable" is reported as outside the good range; outside "acceptable" is out of spec. A check is out of spec if any channel is. Rates are per day.')) + '</p>' +
		'<h3>' + esc(_('Where doubt was resolved in the provider\'s favour')) + '</h3>' + list([
			_('A check that could not read the modem is counted as unknown and never as a fault of the line.'),
			_('An outage is counted from the first to the last check that found the internet unreachable. What happened between two checks is not known, so the shortest duration the checks prove is the one stated.'),
			_('One or two lost pings out of three are not an outage.'),
			_('After more than 30 minutes without a check (the router was off, for example), an outage is not assumed to have gone on.'),
			_('Uncorrectable codewords are reported but not judged, because no published limit exists for them.')
		].concat(ST ? [
			_('A speed test is credited, as in ISPy, with the higher of what the test measured and the traffic counted on the router\'s WAN port while it ran. A test that did not complete is not counted as slow, and a test with nothing recorded near it is counted as not known, never as during a line problem.')
		] : [])) +
		'<h3>' + esc(_('What the router can and cannot see')) + '</h3>' + list([
			_('It sees what the modem reports at each check. Anything that came and went between two checks is not in the signal figures; the modem\'s event log covers that time.'),
			_('The modem keeps only its last 100 log entries. The router copies new entries at every check, so entries are only lost if more than 100 were written between two checks or while the router was off.'),
			_('Event times are the modem\'s own, corrected by the difference between its clock and the router\'s at the moment the router first saw the entry. The router\'s clock is set from the internet (NTP).'),
			_('It does not see the provider\'s side of the line: the levels at the provider\'s equipment, the cause of a fault, or whether a fault is in the home or in the street.'),
			ST ? _('It does not measure speed itself. The speed tests in section 5 were made by ISPy, a separate app on the same router, and are shown as ISPy recorded them.')
				: _('It does not measure speed.')
		]);

	/* --------------------------------------------------- 6 statement */
	var statement = (o.notes || '').trim()
		? '<h2>' + esc(_('Subscriber\'s statement')) + '</h2><p class="note">' + esc(_('In the subscriber\'s own words.')) + '</p><div class="statement">' + esc(o.notes.trim()) + '</div>' : '';

	var body = '<h1>' + esc(_('Cable line health report')) + '</h1>' +
		'<p class="sub">' + esc(_('%s to %s · measured at the customer\'s cable modem · made %s').format(mh.fmtTime(G.since), mh.fmtTime(G.until), mh.fmtTime(o.generated || G.until))) + '</p>' +
		'<h2>' + esc(_('1. Findings')) + '</h2>' + summary +
		'<h2>' + esc(_('2. Modem and line')) + '</h2>' + line +
		'<h2>' + esc(_('3. Outages and events')) + '</h2>' +
		'<h3>' + esc(_('Outages')) + '</h3>' + outageTable +
		'<h3>' + esc(_('Day by day')) + '</h3>' + (dayList.length ? dayTable : '<p>' + esc(_('No checks in this period.')) + '</p>') +
		'<p class="note">' + esc(_('Losses of sync, time-outs (other: T2, T6 and lost MDD) and re-registrations are from the modem\'s own log; restarts are seen from the modem\'s uptime; outages from the pings.')) + '</p>' +
		timesHtml + failedHtml +
		'<h2>' + esc(_('4. Signal')) + '</h2>' + measuredHtml +
		'<h3>' + esc(_('Channels with values outside the good range')) + '</h3>' + worstHtml + charts +
		(ST ? '<h2>' + esc(_('5. Speed tests and line problems')) + '</h2>' + speedHtml : '') +
		'<h2>' + esc(ST ? _('6. How this was measured') : _('5. How this was measured')) + '</h2>' + how + statement +
		'<footer>' + esc(_('This report states measurements taken by the customer\'s own equipment. It is not legal advice. Made by Modem Health%s (github.com/chaffed/luci-app-modemhealth).').format(o.version ? ' ' + o.version : '')) + '</footer>';

	return {
		body: body, findings: findings, preliminary: preliminary, level: level, headline: headline,
		page: function() {
			return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
				'<meta name="generator" content="Modem Health (github.com/chaffed/luci-app-modemhealth)">' +
				'<title>' + esc(_('Cable line health report')) + '</title><style>' + css + '</style></head><body>' + body + '</body></html>\n';
		}
	};
}

/* What is missing for a report the ISP can match to an account. */
function hints(o) {
	var out = [], sub = o.sub || {};
	if (!sub.subscriber || !sub.account)
		out.push(_('Add your name and account number in Settings, so that the provider can match this report to your account.'));
	if (!o.modem || !o.modem.mac)
		out.push(_('The modem has not been read yet, so the report cannot name it.'));
	return out;
}

return baseclass.extend({
	PERIODS: PERIODS, PRELIMINARY_S: PRELIMINARY_S, periodWindow: periodWindow, css: css, build: build, hints: hints
});
