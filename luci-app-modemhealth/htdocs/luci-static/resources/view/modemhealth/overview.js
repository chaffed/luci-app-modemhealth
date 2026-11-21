'use strict';
'require view';
'require ui';
'require uci';
'require modemhealth.common as mh';

/*
 * Modem Health - Overview: the line's health now and over a period.
 * Text from the modem or the stored files is always an array child of E()
 * (see common.js).
 * SPDX-License-Identifier: MIT
 */

var H = mh.health;
var PERIODS = [ [ 1, _('Last 24 hours') ], [ 7, _('Last 7 days') ] ];

var CSS = [
	'.mh-badge{display:inline-block;padding:.15em .6em;border-radius:1em;color:#fff;font-weight:bold}',
	'.mh-summary{display:flex;flex-wrap:wrap;gap:1em 2em;align-items:flex-start}',
	'.mh-summary>div{flex:1 1 18em;min-width:0}',
	'.mh-summary ul{margin:.4em 0 0 1.2em;padding:0}',
	'.mh-cell-good{}',
	'.mh-cell-marginal{background:rgba(217,154,28,.18)}',
	'.mh-cell-bad{background:rgba(217,83,79,.22);font-weight:bold}',
	'.mh-legend{display:flex;flex-wrap:wrap;gap:.3em 1.2em;font-size:90%;margin:.2em 0 .6em}',
	'.mh-legend-item{display:inline-flex;align-items:center;gap:.4em}',
	'.mh-swatch{display:inline-block;width:1.4em;height:.7em;border-radius:2px}',
	'.mh-chart{max-width:100%;height:auto;display:block}',
	'.mh-tablewrap{overflow-x:auto}',
	'.mh-note{opacity:.75;font-size:90%}',
	'.mh-events td{vertical-align:top}',
	'.mh-events td:first-child{white-space:nowrap}',
	'.mh-ev-Critical td:first-child{border-left:4px solid #d9534f}',
	'.mh-ev-Warning td:first-child{border-left:4px solid #d99a1c}',
	'.mh-explain dt{font-weight:bold;margin-top:.6em}',
	'.mh-explain dd{margin:0 0 0 1em}'
].join('\n');

function badge(level) {
	return E('span', { 'class': 'mh-badge', 'style': 'background:' + (mh.C[level] || mh.C.unknown) }, [ mh.LEVEL_TEXT[level] || level ]);
}

function cell(text, check) {
	var level = check ? check.level : null;
	return E('td', {
		'class': 'td' + (level ? ' mh-cell-' + level : ''),
		'title': check ? mh.fmtLimit(check.limit) + ' · ' + (mh.LEVEL_TEXT[level] || '') : null
	}, [ text ]);
}

function channelTable(verdicts, dir) {
	var rows = verdicts.filter(function(v) { return v.channel.dir === dir; })
		.sort(function(a, b) { return (+a.channel.ch || 0) - (+b.channel.ch || 0); });
	if (!rows.length) return E('p', {}, [ _('No channels.') ]);
	var head = dir === 'ds'
		? [ _('Channel'), _('ID'), _('Modulation'), _('Frequency (MHz)'), _('Power (dBmV)'), _('SNR/MER (dB)'), _('Corrected'), _('Uncorrectable') ]
		: [ _('Channel'), _('ID'), _('Type'), _('Frequency (MHz)'), _('Width (MHz)'), _('Power (dBmV)') ];
	return E('div', { 'class': 'mh-tablewrap' }, E('table', { 'class': 'table' }, [
		E('tr', { 'class': 'tr table-titles' }, head.map(function(h) { return E('th', { 'class': 'th' }, [ h ]); }))
	].concat(rows.map(function(v) {
		var c = v.channel, chk = {};
		v.checks.forEach(function(x) { chk[x.metric] = x; });
		var mhz = function(hz) { var n = H.num(hz); return n == null ? '–' : (n / 1e6).toFixed(n % 1e6 ? 1 : 0); };
		var lockCell = chk.lock ? cell('%s · %s'.format(c.ch || '–', c.lock), chk.lock) : null;
		var cells = dir === 'ds' ? [
			lockCell || E('td', { 'class': 'td' }, [ c.ch || '–' ]),
			E('td', { 'class': 'td' }, [ c.channel_id ]),
			E('td', { 'class': 'td' }, [ c.modulation || '–' ]),
			E('td', { 'class': 'td' }, [ mhz(c.freq_hz) ]),
			cell(mh.fmtNum(c.power_dbmv), chk.power),
			cell(mh.fmtNum(c.snr_db), chk.snr),
			E('td', { 'class': 'td' }, [ mh.fmtInt(c.corrected) ]),
			/* Reported, not judged: no published threshold exists (see health.js). */
			E('td', { 'class': 'td' }, [ mh.fmtInt(c.uncorrectable) ])
		] : [
			lockCell || E('td', { 'class': 'td' }, [ c.ch || '–' ]),
			E('td', { 'class': 'td' }, [ c.channel_id ]),
			E('td', { 'class': 'td' }, [ c.modulation || '–' ]),
			E('td', { 'class': 'td' }, [ mhz(c.freq_hz) ]),
			E('td', { 'class': 'td' }, [ mhz(c.width_hz) ]),
			cell(mh.fmtNum(c.power_dbmv), chk.power)
		];
		return E('tr', { 'class': 'tr' }, cells);
	}))));
}

/* A gateway's radios at its latest reading. */
function radioTable(verdicts) {
	if (!verdicts || !verdicts.length) return E('p', {}, [ _('No 4G or 5G radio was connected at the last check.') ]);
	var head = [ _('Radio'), _('Band'), _('Bars'), _('RSRP (dBm)'), _('RSRQ (dB)'), _('SINR (dB)'), _('RSSI (dBm)'), _('Tower (eNB/gNB-cell)') ];
	return E('div', { 'class': 'mh-tablewrap' }, E('table', { 'class': 'table' }, [
		E('tr', { 'class': 'tr table-titles' }, head.map(function(h) { return E('th', { 'class': 'th' }, [ h ]); }))
	].concat(verdicts.slice().sort(function(a, b) { return a.radio.tech < b.radio.tech ? -1 : 1; }).map(function(v) {
		var r = v.radio, chk = {};
		v.checks.forEach(function(x) { chk[x.metric] = x; });
		return E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td' }, [ r.tech === 'nr' ? _('5G (NR)') : _('4G (LTE)') ]),
			E('td', { 'class': 'td' }, [ r.bands || '–' ]),
			/* Reported, not judged: the gateway's own summary. */
			E('td', { 'class': 'td' }, [ r.bars || '–' ]),
			cell(mh.fmtNum(r.rsrp_dbm), chk.rsrp),
			cell(mh.fmtNum(r.rsrq_db), chk.rsrq),
			cell(mh.fmtNum(r.sinr_db), chk.sinr),
			E('td', { 'class': 'td' }, [ mh.fmtNum(r.rssi_dbm) ]),
			E('td', { 'class': 'td' }, [ r.cell || '–' ])
		]);
	}))));
}

/* Points over time from each reading's radios of one kind (lte, nr). */
function radioSeries(D, tech, key) {
	return D.readings.map(function(r) {
		var x = ((D.radiosAt || {})[r.ts] || []).filter(function(y) { return y.tech === tech; })[0];
		return [ +r.ts, x ? H.num(x[key]) : null ];
	});
}

/* Points over time from each reading's channels. */
function seriesBy(D, dir, pick, agg) {
	return D.readings.map(function(r) {
		var vals = (D.channelsAt[r.ts] || []).filter(function(c) { return c.dir === dir && pick(c) != null; }).map(pick);
		return [ +r.ts, vals.length ? agg(vals) : null ];
	});
}
function min(a) { return Math.min.apply(null, a); }
function max(a) { return Math.max.apply(null, a); }
function sum(a) { return a.reduce(function(s, v) { return s + v; }, 0); }

function bandsFor(limit) {
	if (!limit || !limit.good) return [];
	return [ { lo: limit.marginal[0], hi: limit.marginal[1], color: mh.C.marginal }, { lo: limit.good[0], hi: limit.good[1], color: mh.C.good } ];
}

function charts(D) {
	/* Start where the data starts when there is less than the period. */
	var first = Math.min(D.readings.length ? +D.readings[0].ts : Infinity, D.events.length ? D.events[0].ts : Infinity);
	var to = D.until, from = Math.max(D.since, isFinite(first) ? first - Math.max((to - first) * 0.03, 300) : D.since);
	var gap = Math.max(D.interval * 60 * 3, 900);
	var spans = D.outages.map(function(o) {
		return { from: o.start - 60, to: (o.end || o.start) + 60, color: mh.C.bad,
			label: _('Outage, %s: %s').format(mh.fmtTime(o.start), o.kind === 'line_down' ? _('line down') : _('modem unreachable')) };
	});
	var marks = D.events.filter(function(e) { return H.DISRUPTIVE[e.kind]; }).map(function(e) {
		return { ts: e.ts, color: mh.C.bad, label: '%s · %s'.format(mh.fmtTime(e.ts), e.message) };
	});
	D.reboots.forEach(function(r) {
		marks.push({ ts: +r.boot_ts || +r.ts, color: '#8e44ad', label: (D.gateway ? _('Gateway restarted') : _('Modem restarted')) + (r.byModemHealth ? _(' by Modem Health') : '') });
	});
	var scqam = function(c) { return /OFDM/.test(c.modulation || '') ? null : H.num(c.power_dbmv); };
	var snr = function(c) { return /OFDM/.test(c.modulation || '') ? null : H.num(c.snr_db); };
	var mer = function(c) { return /OFDM/.test(c.modulation || '') ? H.num(c.snr_db) : null; };
	var unc = function(c) { return H.num(c.uncorrectable); };
	var usIds = {};
	D.readings.forEach(function(r) { (D.channelsAt[r.ts] || []).forEach(function(c) { if (c.dir === 'us') usIds[c.channel_id] = c.modulation; }); });
	var lastUs = (D.channelsAt[(D.readings[D.readings.length - 1] || {}).ts] || []).filter(function(c) { return c.dir === 'us' && !/OFDM/.test(c.modulation || ''); }).length;
	var usLimit = H.limitsFor({ dir: 'us', modulation: 'SC-QAM' }, lastUs, D.limits).power;
	var common = { from: from, to: to, spans: spans, marks: marks, gap: gap, interval: D.interval * 60 };
	var block = function(title, note, chart, leg) {
		return E('div', { 'class': 'cbi-section' }, [ E('h3', {}, [ title ]), note ? E('p', { 'class': 'mh-note' }, [ note ]) : '', leg || '', chart ]);
	};
	var out = [];
	if (D.gateway) {
		var techs = [ [ 'lte', _('4G (LTE)'), mh.C.series[0] ], [ 'nr', _('5G (NR)'), mh.C.series[1] ] ].filter(function(t) {
			return D.readings.some(function(r) { return ((D.radiosAt || {})[r.ts] || []).some(function(x) { return x.tech === t[0]; }); });
		});
		var leg = mh.legend(techs.map(function(t) { return { name: t[1], color: t[2] }; }).concat([ { name: _('outage'), color: mh.C.bad, faint: true } ]));
		[ [ 'rsrp_dbm', _('Signal power (RSRP, dBm)'), _('How strong the tower\'s signal is at the gateway.'), 'rsrp' ],
		  [ 'sinr_db', _('Signal to noise (SINR, dB)'), _('How far the signal stands above interference and noise.'), 'sinr' ],
		  [ 'rsrq_db', _('Signal quality (RSRQ, dB)'), _('How much of the received power is the gateway\'s own signal rather than other traffic.'), 'rsrq' ] ].forEach(function(m) {
			var limit = D.limits[(techs[0] || [ 'nr' ])[0] + '_' + m[3]];
			out.push(block(m[1], m[2] + ' ' + _('Shaded: good (green) and acceptable (amber), by Teltonika\'s guidance; neither 3GPP nor T-Mobile publishes grades.'),
				mh.lineChart(Object.assign({ title: m[1], bands: bandsFor(limit), series: techs.map(function(t) {
					return { name: t[1], color: t[2], points: radioSeries(D, t[0], m[0]) };
				}) }, common)), leg));
		});
		out.push(E('p', { 'class': 'mh-note' }, [ _('Red ticks at the top of each chart mark tower changes and lost radios; purple ticks mark gateway restarts. Hover for details.') ]));
		return out;
	}
	out.push(block(_('Downstream power'), _('Lowest and highest SC-QAM channel at each check. Shaded: good (green) and acceptable (amber) range.'),
		mh.lineChart(Object.assign({ title: _('Downstream power'), fitBands: false, bands: bandsFor(D.limits.ds_power), series: [
			{ name: _('lowest'), color: mh.C.series[0], points: seriesBy(D, 'ds', scqam, min) },
			{ name: _('highest'), color: mh.C.series[1], points: seriesBy(D, 'ds', scqam, max) } ] }, common)),
		mh.legend([ { name: _('lowest channel'), color: mh.C.series[0] }, { name: _('highest channel'), color: mh.C.series[1] },
			{ name: _('outage'), color: mh.C.bad, faint: true } ])));
	out.push(block(_('Downstream SNR and MER'), _('Worst SC-QAM channel (SNR) and worst OFDM channel (MER) at each check.'),
		mh.lineChart(Object.assign({ title: _('Downstream SNR'), bands: bandsFor(D.limits.ds_snr), series: [
			{ name: _('worst SNR'), color: mh.C.series[0], points: seriesBy(D, 'ds', snr, min) },
			{ name: _('worst MER (OFDM)'), color: mh.C.series[2], points: seriesBy(D, 'ds', mer, min), dash: '4 3' } ] }, common)),
		mh.legend([ { name: _('worst SC-QAM SNR'), color: mh.C.series[0] }, { name: _('worst OFDM MER'), color: mh.C.series[2] } ])));
	var usSeries = Object.keys(usIds).sort(function(a, b) { return a - b; }).map(function(id, i) {
		return { name: '%s %s'.format(usIds[id] || '', id), color: mh.C.series[i % mh.C.series.length], dash: /OFDM/.test(usIds[id] || '') ? '4 3' : null,
			points: seriesBy(D, 'us', function(c) { return c.channel_id === id ? H.num(c.power_dbmv) : null; }, max) };
	});
	out.push(block(_('Upstream power'), _('How hard the modem has to transmit to reach the ISP. Shaded: the range for %d bonded SC-QAM channels.').format(lastUs || 1),
		mh.lineChart(Object.assign({ title: _('Upstream power'), bands: bandsFor(usLimit), series: usSeries }, common)),
		mh.legend(usSeries.map(function(s) { return { name: s.name, color: s.color }; }))));
	out.push(block(_('Errors per check'), _('Codewords the modem corrected, and codewords it could not correct (lost data), across all downstream channels since the previous check.'),
		mh.lineChart(Object.assign({ title: _('Errors per check'), zero: true, series: [
			{ name: _('uncorrectable'), color: mh.C.bad, points: seriesBy(D, 'ds', unc, sum), bars: true } ] }, common)),
		mh.legend([ { name: _('uncorrectable'), color: mh.C.bad } ])));
	/* ISPy's speed tests, when it has any, on the same time axis. */
	var ST = D.speedTests;
	if (ST) {
		var sc = mh.speedChart(ST, { from: from, to: to });
		out.push(E('div', { 'class': 'cbi-section', 'id': 'mh-speed' }, [
			E('h3', {}, [ _('Speed tests (ISPy)') ]),
			E('p', { 'class': 'mh-note' }, [ (sc.percent
				? _('Each dot is one speed test by ISPy at the time it started, as a percentage of the advertised speed set in ISPy. In the red band at the bottom: slow.')
				: _('Each dot is one speed test by ISPy at the time it started, in Mbit/s.')) + ' ' +
				_('The outages and events of the charts above are marked here too, so the two can be compared.') ]),
			mh.legend(sc.legend),
			mh.lineChart(Object.assign({ title: _('Speed tests (ISPy)') }, common, sc.chart, { marks: marks.concat(sc.chart.marks) })),
			E('ul', {}, mh.speedSentences(ST).map(function(t) { return E('li', {}, [ t ]); })),
			E('p', { 'class': 'mh-note' }, [ _('A line problem here is an outage, a loss of sync or time-out in the modem\'s log, or a signal value out of spec. The Report page has the full count.') +
				(sc.before ? ' ' + _('%s from before the first check of the modem are counted but not drawn.').format(mh.nOf(sc.before, _('test'), _('tests'))) : '') ])
		]));
	}
	out.push(E('p', { 'class': 'mh-note' }, [ _('Red ticks at the top of each chart mark losses of sync and time-outs; purple ticks mark modem restarts. Hover for details.') ]));
	return out;
}

function eventsTable(D) {
	var evs = D.events.filter(function(e) { return e.kind !== 'status_report'; }).slice(-60).reverse();
	if (!evs.length) return E('p', {}, [ D.gateway ? _('No tower or band changes in this period.') : _('No modem events in this period.') ]);
	var KIND = {
		t4: _('T4 time-out'), t3: _('T3 time-out'), t2: _('T2 time-out'), t6: _('T6 time-out'), sync_loss: _('Loss of sync'),
		mdd_loss: _('Lost MDD'), registration: _('Registration'), ranging: _('Ranging'), reboot: _('Restart'), config: _('Configuration'),
		cell_change: _('Tower change'), band_change: _('Band change'), radio_lost: _('Radio lost'), mh_restart: _('Restart by Modem Health'), other: ''
	};
	return E('div', { 'class': 'mh-tablewrap' }, E('table', { 'class': 'table mh-events' }, [
		E('tr', { 'class': 'tr table-titles' }, [ _('Time'), _('Level'), _('What'), _('Message') ].map(function(h) { return E('th', { 'class': 'th' }, [ h ]); }))
	].concat(evs.map(function(e) {
		return E('tr', { 'class': 'tr mh-ev-' + (e.level || '').replace(/[^A-Za-z]/g, '') }, [
			E('td', { 'class': 'td', 'title': _('Modem clock: %s').format(e.modem_time) }, [ mh.fmtTime(e.ts) ]),
			E('td', { 'class': 'td' }, [ e.level ]),
			E('td', { 'class': 'td' }, [ KIND[e.kind] || '' ]),
			E('td', { 'class': 'td' }, [ e.message ])
		]);
	}))));
}

/* The copy on a USB drive: where it goes and whether the last attempt
 * worked. ex = { dir, mounted, ts, ok, message } (from the status). */
function driveBox(ex, redraw) {
	if (!ex || !ex.dir)
		return E('p', { 'class': 'mh-note', 'id': 'mh-drive' }, [
			_('Modem Health can also copy the history and the report to a USB drive after every check.') + ' ',
			E('a', { 'href': L.url('admin/services/modemhealth/settings') }, [ _('Settings → Storage') ])
		]);
	var save = E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(null, function() {
		return mh.callExport().then(function() { return mh.callStatus(); }).then(redraw);
	}) }, [ _('Save to the drive now') ]);
	var bad = !ex.mounted
		? _('No drive is connected at %s, so the copy is not being saved. The history on the router is not affected.').format(ex.dir)
		: (ex.ok === false ? _('The copy to %s failed: %s. The history on the router is not affected.').format(ex.dir, ex.message || _('unknown error')) : null);
	if (bad)
		return E('div', { 'class': 'alert-message warning', 'id': 'mh-drive' }, [ E('p', {}, [ bad ]), save ]);
	return E('p', { 'id': 'mh-drive' }, [
		(ex.ts ? _('After every check the history is copied to %s. Last saved: %s.').format(ex.dir, mh.fmtTime(ex.ts))
			: _('After every check the history is copied to %s. Nothing has been saved yet since the router started.').format(ex.dir)) + ' ',
		save
	]);
}

function listOrNone(items, none) {
	return items.length ? E('ul', {}, items.map(function(t) { return E('li', {}, [ t ]); })) : E('p', {}, [ none ]);
}

function explanations(gateway) {
	var items = gateway ? [
		[ _('RSRP'), _('How strong the tower\'s signal is at the gateway, in dBm. Closer to zero is stronger: -80 is excellent, below -100 is weak.') ],
		[ _('SINR'), _('How far the signal stands above interference and noise, in dB. Higher is better; at 0 dB or below the gateway can barely hold the connection.') ],
		[ _('RSRQ'), _('Signal quality: how much of what the gateway receives is its own signal rather than other traffic on the tower. Closer to zero is better.') ],
		[ _('RSSI and bars'), _('The total power received, and the gateway\'s own summary of the signal. Shown, but not judged.') ],
		[ _('Tower change'), _('The gateway moved to another tower or sector. A gateway that stays in one place should rarely do so; frequent changes mean it cannot hold one.') ],
		[ _('Where the grades come from'), _('Neither 3GPP (which writes the 4G and 5G standards) nor T-Mobile publishes what counts as good. The grades are Teltonika\'s published recommendations, which Digi\'s agree with.') ],
		[ _('Outage'), _('No answer from the internet at a check. "Line down" means the gateway still answered; "gateway unreachable" means it did not either.') ]
	] : [
		[ _('Downstream power'), _('How strong the signal from the ISP is when it reaches the modem. Too weak or too strong and the modem makes errors.') ],
		[ _('SNR / MER'), _('How far the signal stands above the noise on the line. Lower means more errors; a sudden drop often means interference or a damaged cable or connector.') ],
		[ _('Upstream power'), _('How loud the modem has to transmit for the ISP to hear it. Close to the maximum means signal is being lost between the modem and the ISP; the modem has no headroom left.') ],
		[ _('Corrected and uncorrectable errors'), _('Blocks of data (codewords) that arrived damaged. Corrected ones were repaired; uncorrectable ones were lost and had to be sent again, which slows the connection.') ],
		[ _('Loss of sync, T3 and T4 time-outs'), _('The modem lost the signal (loss of sync), the ISP did not answer it (T3), or it stopped hearing from the ISP and had to start over (T4). Each is a dropout.') ],
		[ _('Re-registration'), _('The modem signed on to the ISP\'s network again without restarting, usually after a dropout.') ],
		[ _('Outage'), _('No answer from the internet at a check. "Line down" means the modem still answered; "modem unreachable" means it did not either.') ]
	];
	return E('details', { 'class': 'cbi-section' }, [
		E('summary', {}, [ _('What do these mean?') ]),
		E('dl', { 'class': 'mh-explain' }, [].concat.apply([], items.map(function(i) { return [ E('dt', {}, [ i[0] ]), E('dd', {}, [ i[1] ]) ]; })))
	]);
}

/* Restarts (#39): the automatic setting, the last restart, and the
 * Restart button (SURFboards only for now: a gateway restart needs its
 * admin password and is untested). */
var TRIGGER = { manual: _('by hand'), down: _('no connection'), signal: _('bad signal') };
var RESTART_FAILED = {
	unreachable: _('the modem did not answer.'),
	timeout: _('the modem did not answer in time.'),
	login_refused: _('the modem refused the saved password.'),
	no_password: _('no modem password is saved.'),
	restart_unknown_settings: _('the modem\'s settings page answered in a way Modem Health does not know, so nothing was sent.')
};
function reasonText(r) { return RESTART_FAILED[r] || _('the modem answered "%s".').format(r || '?'); }
function restartBox(st, gw, redraw) {
	var R = st.restart || {}, last = R.last;
	var out = [ E('p', { 'class': 'mh-note', 'id': 'mh-restart-state' }, [
		R.auto ? _('Automatic restarts: on, after %d minutes without a connection%s; at most %d an hour and %d a day.')
				.format(R.down_min || 10, R.signal ? _(' or after bad signal') : '', R.max_hour, R.max_day)
			: _('Automatic restarts: off.'),
		last ? E('br') : '',
		last ? (last.result === 'ok' ? _('Last restart by Modem Health: %s (%s).') : _('Last restart by Modem Health failed: %s (%s).'))
			.format(mh.fmtTime(last.ts), last.result === 'ok' ? (TRIGGER[last.trigger] || last.trigger) : (last.reason || '?')) : ''
	]) ];
	if (gw || !st.password_set) return E('div', {}, out);
	out.push(E('button', { 'class': 'cbi-button cbi-button-negative', 'id': 'mh-restart', 'click': function() {
		ui.showModal(_('Restart the modem?'), [
			E('p', {}, [ _('The internet connection will be down for a few minutes while the modem restarts, as with the Restart button on the modem\'s own page. The restart is recorded, and the report will not hold it against the line.') ]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, [ _('Cancel') ]), ' ',
				E('button', { 'class': 'cbi-button cbi-button-negative', 'click': function() {
					return mh.callRestart().then(function(r) {
						ui.hideModal();
						ui.addNotification(null, E('p', {}, [ r && r.ok
							? _('The modem is restarting. It is usually back within five minutes.')
							: _('The modem was not restarted: %s').format(reasonText((r || {}).reason)) ]), r && r.ok ? 'info' : 'warning');
						return mh.callStatus().then(redraw);
					}).catch(function(e) {
						ui.hideModal();
						ui.addNotification(null, E('p', {}, [ _('The modem was not restarted: %s').format(String(e.message || e)) ]), 'warning');
					});
				} }, [ _('Restart the modem') ])
			])
		]);
	} }, [ _('Restart modem…') ]));
	return E('div', {}, out);
}

/* An automatic restart held back by a limit: the line needs the provider. */
function heldBox(st) {
	var h = (st.restart || {}).held;
	if (!h) return '';
	return E('div', { 'class': 'alert-message warning', 'id': 'mh-restart-held' }, [
		_('Modem Health would restart the modem (%s), but automatic restarts are limited to %s and that limit is reached. If restarts keep being needed, the provider has to look at the line.')
			.format(h.detail, h.limit)
	]);
}

return view.extend({
	days: 1,

	load: function() {
		return Promise.all([
			mh.callStatus().catch(function() { return {}; }),
			uci.load('modemhealth').catch(function() {})
		]).then(function(r) { return r[0]; });
	},

	loadPeriod: function(st) {
		var until = st.now || Math.floor(Date.now() / 1000);
		var mine = H.applySettings(function(o) { return uci.get('modemhealth', 'limits', o); });
		return mh.load(until - this.days * 86400, until, st.interval || 5).then(function(D) {
			D.interval = st.interval || 5;
			D.changedLimits = mine.changed;
			return mh.analyse(D, D.interval, mine.limits);
		});
	},

	download: function(D, kind) {
		var name = 'modemhealth-%s-%s.csv'.format(kind, mh.fmtTime(D.until).replace(/[: ]/g, '-'));
		var a = E('a', { 'href': URL.createObjectURL(new Blob([ mh.toCSV(D, kind) ], { type: 'text/csv' })), 'download': name });
		document.body.appendChild(a);
		a.click();
		setTimeout(function() { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
	},

	renderStatus: function(st, D, redraw) {
		var self = this;
		var last = D.readings[D.readings.length - 1];
		var lastV = last ? last.verdict : null;
		var gw = D.gateway || st.modem_type === 'tmobile' || (st.modem || {}).type === 'tmobile';
		var setup = !st.password_set && !gw ? E('div', { 'class': 'alert-message warning' }, [
			_('Modem Health needs your modem\'s password before it can read the modem. '),
			E('a', { 'href': L.url('admin/services/modemhealth/settings') }, [ _('Open Settings') ])
		]) : '';
		var sched = st.enabled
			? (st.next_check ? _('Next check at %s.').format(mh.fmtTime(st.next_check).split(' ')[1]) : (st.synced === false ? _('Waiting for the router\'s clock to be set.') : ''))
			: _('Scheduled checks are off.');
		var gwNow = D.gateway || st.modem_type === 'tmobile' || (st.modem || {}).type === 'tmobile';
		var periodReasons = D.period.reasons.slice(0, 6).map(function(r) { return mh.reasonText(r, D.period.hours, gwNow); });
		var lastReasons = lastV ? mh.groupReasons(lastV.reasons).slice(0, 6).map(function(g) { return mh.groupedText(g); }) : [];
		var modem = st.modem || {};
		return E('div', {}, [
			setup,
			E('div', { 'class': 'cbi-section mh-summary' }, [
				E('div', {}, [
					E('h3', {}, [ _('Now') ]),
					lastV ? badge(lastV.level === 'unknown' ? 'unknown' : lastV.level) : badge('unknown'),
					E('p', {}, [ last ? _('Last check: %s.').format(mh.fmtTime(+last.ts)) : _('No checks yet.'), ' ', sched ]),
					listOrNone(lastReasons, lastV && lastV.level === 'healthy' ? (gw ? _('Every radio within the good range.') : _('All channels within spec.')) : ''),
					E('button', { 'class': 'cbi-button cbi-button-action', 'click': ui.createHandlerFn(this, function() {
						/* The call answers with the status after the check. */
						return mh.callCheck().then(redraw);
					}) }, [ _('Check now') ])
				]),
				E('div', {}, [
					E('h3', {}, [ PERIODS.filter(function(p) { return p[0] === self.days; })[0][1] ]),
					badge(D.period.level === 'unknown' ? 'unknown' : D.period.level),
					E('p', {}, [ _('%d checks, %d failed.').format(D.readings.length, D.readings.filter(function(r) { return r.result !== 'ok'; }).length) ]),
					listOrNone(periodReasons, D.period.level === 'healthy' ? _('No problems found in this period.') : '')
				]),
				E('div', {}, [
					E('h3', {}, [ gw ? _('Gateway') : _('Modem') ]),
					E('p', {}, [ [ modem.model, gw ? _('T-Mobile 5G gateway') : modem.docsis ].filter(Boolean).join(' · ') || _('Not read yet.') ]),
					E('p', { 'class': 'mh-note' }, [ modem.firmware ? _('Firmware %s').format(modem.firmware) : '', E('br'), modem.mac ? _('MAC %s').format(modem.mac) : '' ]),
					restartBox(st, gw, redraw)
				])
			]),
			heldBox(st)
		]);
	},

	render: function(st) {
		var self = this;
		var root = E('div', {}, [ E('style', {}, [ CSS ]), E('h2', {}, [ _('Modem Health') ]), E('div', { 'class': 'spinning' }, [ _('Loading…') ]) ]);
		var draw = function(newStatus) {
			if (newStatus && newStatus.now) st = newStatus;
			return self.loadPeriod(st).then(function(D) {
				var latest = D.readings.filter(function(r) { return r.result === 'ok'; }).pop();
				var lv = latest ? latest.verdict : { channels: [], radios: [] };
				var unreachable = D.gateway ? _('gateway unreachable') : _('modem unreachable');
				var picker = E('select', { 'class': 'cbi-input-select', 'change': function(ev) { self.days = +ev.target.value; draw(); } },
					PERIODS.map(function(p) { return E('option', { 'value': p[0], 'selected': p[0] === self.days ? '' : null }, [ p[1] ]); }));
				var outageItems = D.outages.map(function(o) {
					return _('%s: %s, at least %s%s.').format(mh.fmtTime(o.start), o.kind === 'line_down' ? _('line down') : unreachable,
						mh.fmtDuration(o.minS), o.ongoing ? _(', still down') : (o.maxS != null ? _(', at most %s').format(mh.fmtDuration(o.maxS)) : ''))
						+ (o.byModemHealth ? ' ' + _('After a restart by Modem Health; not held against the line.') : '');
				});
				var restartItems = D.reboots.map(function(r) {
					return (D.gateway ? _('Gateway restarted at %s.') : _('Modem restarted at %s.')).format(mh.fmtTime(+r.boot_ts || +r.ts))
						+ (r.byModemHealth ? ' ' + _('Restarted by Modem Health.') : '');
				})
					.concat(D.restarts.filter(function(x) { return x.result !== 'ok'; }).map(function(x) {
						return _('%s: Modem Health could not restart the modem (%s).').format(mh.fmtTime(x.ts), x.fail_reason || '?');
					}))
					.concat(D.reregistrations.map(function(r) { return _('Re-registered (modem time %s).').format(r.time); }));
				var body = [
					E('style', {}, [ CSS ]),
					E('h2', {}, [ _('Modem Health') ]),
					E('p', {}, [ _('Period: '), picker, ' ',
						E('span', { 'class': 'mh-note' }, [ _('Download as CSV:') ]), ' ' ].concat([
						[ 'readings', _('Checks') ], D.gateway ? [ 'radios', _('Radios') ] : [ 'channels', _('Channels') ], [ 'events', _('Events') ]
					].map(function(k) {
						return E('button', { 'class': 'cbi-button', 'style': 'margin-left:.3em', 'click': function() { self.download(D, k[0]); } }, [ k[1] ]);
					}))),
					self.renderStatus(st, D, draw),
					driveBox(st['export'], draw),
					D.changedLimits.length ? E('div', { 'class': 'alert-message notice' }, [
						_('Judged against limits you changed in Settings: %s. The others are Modem Health\'s sourced defaults.')
							.format(D.changedLimits.map(function(c) { return c.limit.label; }).join('; '))
					]) : '',
					E('div', { 'class': 'cbi-section' }, [ E('h3', {}, [ _('Outages') ]), listOrNone(outageItems, _('No outages in this period.')) ]),
					E('div', { 'class': 'cbi-section' }, [ E('h3', {}, [ _('Restarts and re-registrations') ]), listOrNone(restartItems, _('None in this period.')) ]),
				].concat(D.gateway ? [
					E('div', { 'class': 'cbi-section', 'id': 'mh-radios' }, [
						E('h3', {}, [ _('4G and 5G radios') ]),
						E('p', { 'class': 'mh-note' }, [ latest ? _('At %s. Hover a value for its limit. Bars and RSSI are shown as the gateway reports them, not judged.').format(mh.fmtTime(+latest.ts)) : '' ]),
						radioTable(lv.radios)
					])
				] : [
					E('div', { 'class': 'cbi-section' }, [
						E('h3', {}, [ _('Downstream channels') ]),
						E('p', { 'class': 'mh-note' }, [ latest ? _('At %s. Corrected and uncorrectable: since the previous check. Hover a value for its limit.').format(mh.fmtTime(+latest.ts)) : '' ]),
						channelTable(lv.channels, 'ds')
					]),
					E('div', { 'class': 'cbi-section' }, [ E('h3', {}, [ _('Upstream channels') ]), channelTable(lv.channels, 'us') ])
				]).concat(D.readings.length ? charts(D) : []).concat([
					E('div', { 'class': 'cbi-section' }, [ E('h3', {}, [ D.gateway ? _('Gateway events') : _('Modem events') ]),
						E('p', { 'class': 'mh-note' }, [ D.gateway
							? _('The gateway keeps no event log; these are written by Modem Health when a check finds another tower, another band or a radio gone.')
							: _('From the modem\'s own log, kept by the router after the modem has forgotten them. Routine status reports are not shown.') ]),
						eventsTable(D) ]),
					explanations(D.gateway)
				]);
				root.replaceChildren.apply(root, body);
			}).catch(function(err) {
				root.replaceChildren(E('h2', {}, [ _('Modem Health') ]), E('div', { 'class': 'alert-message error' }, [ _('Could not load the stored data: %s').format(String(err)) ]));
			});
		};
		draw();
		return root;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
