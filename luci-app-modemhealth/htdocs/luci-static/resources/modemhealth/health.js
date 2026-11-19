'use strict';
'require baseclass';

/*
 * Modem Health - health rules.
 *
 * Turns stored readings, channels and modem events into verdicts:
 * good / marginal / bad for each channel value, and healthy / degraded /
 * failing for a reading and for a period, with the reasons ranked.
 *
 * Used by the dashboard, the report and the standalone report file, and
 * tested under node, so it uses nothing from LuCI but baseclass.
 *
 * Every limit names its sources (SOURCES below) so the report can cite
 * them. Limits marked judgement: true are Modem Health's own, and the
 * report says so.
 *
 * SPDX-License-Identifier: MIT
 */

var GOOD = 'good', MARGINAL = 'marginal', BAD = 'bad', UNKNOWN = 'unknown';
var HEALTHY = 'healthy', DEGRADED = 'degraded', FAILING = 'failing';
var RANK = { good: 0, unknown: 0, healthy: 0, marginal: 1, degraded: 1, bad: 2, failing: 2 };

/* Where each limit comes from. kind: spec (a DOCSIS requirement), vendor
 * (a manufacturer's published guidance) or judgement (Modem Health's own
 * choice, stated as such in the report). */
var SOURCES = {
	docsis30_phy: {
		kind: 'spec',
		title: 'CableLabs, DOCSIS 3.0 Physical Layer Specification, CM-SP-PHYv3.0-I09-101008 (2010)',
		url: 'https://account.cablelabs.com/server/alfresco/887e1bcb-0bf0-40d1-aaae-65f254078670'
	},
	docsis31_phy: {
		kind: 'spec',
		title: 'CableLabs, DOCSIS 3.1 Physical Layer Specification, CM-SP-PHYv3.1 (I08, 2015)',
		url: 'https://apps.cablelabs.com/specification/CM-SP-PHYv3.1'
	},
	arris_levels: {
		kind: 'vendor',
		title: 'ARRIS SURFboard support, "SB8200: Cable Signal Levels" (article 000024250)',
		url: 'https://arris.my.salesforce-sites.com/consumers/kA5Qi0000003RtHKAU'
	},
	netgear_levels: {
		kind: 'vendor',
		title: 'NETGEAR Knowledge Base 24311, "What are the recommended cable modem signal levels?"',
		url: 'https://kb.netgear.com/24311/What-are-the-recommended-cable-modem-signal-levels'
	},
	cisco_t3_t4: {
		kind: 'vendor',
		title: 'Cisco, "Troubleshooting uBR Cable Modems Not Coming Online" (document 16510)',
		url: 'https://www.cisco.com/c/en/us/support/docs/broadband-cable/cable-modems/16510-troubleshooting-cm-online.html'
	},
	judgement: {
		kind: 'judgement',
		judgement: true,
		title: 'Modem Health\'s own threshold',
		note: 'No published standard sets this threshold; it is Modem Health\'s choice and can be changed in Settings.'
	}
};

/* Limits. good and marginal are [low, high] (null = no bound); a value
 * outside marginal is bad. Rates are per day; shares are fractions of the
 * readings in the period. */
var LIMITS = {
	lock: {
		label: 'Every channel locked',
		sources: [ 'judgement' ]
	},
	ds_power: {
		label: 'Downstream power (SC-QAM)', unit: 'dBmV',
		good: [ -7, 7 ], marginal: [ -15, 15 ],
		note: 'DOCSIS requires a modem to work from -15 to +15 dBmV; NETGEAR recommends -7 to +7.',
		sources: [ 'docsis30_phy', 'arris_levels', 'netgear_levels' ]
	},
	ds_snr: {
		label: 'Downstream SNR (SC-QAM, 256-QAM)', unit: 'dB',
		good: [ 33, null ], marginal: [ 30, null ],
		note: 'DOCSIS sets 30 dB as the minimum at which a modem must still decode 256-QAM; below that errors are expected. Within 3 dB of it is marginal (Modem Health\'s margin).',
		sources: [ 'docsis30_phy', 'arris_levels', 'judgement' ]
	},
	ds_snr_low_power: {
		label: 'Downstream SNR (SC-QAM, 256-QAM, power below -6 dBmV)', unit: 'dB', below_power: -6,
		good: [ 36, null ], marginal: [ 33, null ],
		note: 'Below -6 dBmV the DOCSIS minimum rises to 33 dB.',
		sources: [ 'docsis30_phy', 'arris_levels', 'judgement' ]
	},
	ds_power_ofdm: {
		label: 'Downstream power (OFDM)', unit: 'dBmV',
		good: [ -7, 7 ], marginal: [ -15, 15 ],
		note: 'DOCSIS 3.1 requires -15 to +15 dBmV per 6 MHz. The -7 to +7 band is the SC-QAM recommendation applied to OFDM.',
		sources: [ 'docsis31_phy', 'netgear_levels', 'judgement' ]
	},
	ds_mer_ofdm: {
		label: 'Downstream MER (OFDM)', unit: 'dB',
		good: [ 41, null ], marginal: [ 34, null ],
		note: 'DOCSIS 3.1 needs 41 dB for 4096-QAM and 34 dB for 1024-QAM. Below 41 dB the ISP may have to use a slower OFDM profile; below 34 dB even 1024-QAM fails.',
		sources: [ 'docsis31_phy' ]
	},
	us_power_by_channels: {
		/* DOCSIS 3.0 maximum per channel at 64-QAM, by the number of bonded
		 * SC-QAM channels: 57, 54, 51, 51 dBmV. Lower bound: the spec's
		 * minimum at 5.12 Msym/s. */
		1: { label: 'Upstream power (SC-QAM, 1 channel)', unit: 'dBmV', good: [ 38, 48 ], marginal: [ 23, 57 ],
			note: 'DOCSIS allows up to 57 dBmV with one 64-QAM channel; NETGEAR recommends 38-48.',
			sources: [ 'docsis30_phy', 'arris_levels', 'netgear_levels' ] },
		2: { label: 'Upstream power (SC-QAM, 2 channels)', unit: 'dBmV', good: [ 38, 48 ], marginal: [ 23, 54 ],
			note: 'DOCSIS allows up to 54 dBmV per channel with two 64-QAM channels; NETGEAR recommends 38-48.',
			sources: [ 'docsis30_phy', 'arris_levels', 'netgear_levels' ] },
		3: { label: 'Upstream power (SC-QAM, 3 channels)', unit: 'dBmV', good: [ 38, 48 ], marginal: [ 23, 51 ],
			note: 'DOCSIS allows up to 51 dBmV per channel with three or four 64-QAM channels; NETGEAR recommends 38-48. Close to the maximum, the modem has little headroom left.',
			sources: [ 'docsis30_phy', 'arris_levels', 'netgear_levels' ] },
		4: { label: 'Upstream power (SC-QAM, 4 channels)', unit: 'dBmV', good: [ 38, 48 ], marginal: [ 23, 51 ],
			note: 'DOCSIS allows up to 51 dBmV per channel with three or four 64-QAM channels; NETGEAR recommends 38-48. Close to the maximum, the modem has little headroom left.',
			sources: [ 'docsis30_phy', 'arris_levels', 'netgear_levels' ] }
	},
	us_power_ofdma: {
		label: 'Upstream power (OFDMA)', unit: 'dBmV',
		good: [ null, 48 ], marginal: [ null, 65 ],
		note: 'DOCSIS 3.1 modems can transmit 65 dBmV in total; the per-channel limit depends on bandwidth, so above 48 dBmV is marked marginal by Modem Health\'s judgement.',
		sources: [ 'docsis31_phy', 'judgement' ]
	},
	outages_per_day: {
		label: 'Outages (no internet)', unit: 'per day',
		good: [ null, 0 ], marginal: [ null, 0 ],
		sources: [ 'judgement' ]
	},
	t4_per_day: {
		label: 'T4 time-outs', unit: 'per day',
		good: [ null, 0 ], marginal: [ null, 0 ],
		note: 'After a T4 time-out the modem goes offline and searches for the signal again: every one is a dropout.',
		sources: [ 'cisco_t3_t4', 'judgement' ]
	},
	t3_per_day: {
		label: 'T3 time-outs', unit: 'per day',
		good: [ null, 1 ], marginal: [ null, 5 ],
		note: 'A T3 time-out means the ISP did not answer the modem\'s ranging request. An occasional one is common; repeated ones point to an upstream (return path) problem.',
		sources: [ 'cisco_t3_t4', 'judgement' ]
	},
	sync_loss_per_day: {
		label: 'Losses of downstream sync', unit: 'per day',
		good: [ null, 0 ], marginal: [ null, 2 ],
		note: 'Each loss of sync means the modem lost the downstream signal.',
		sources: [ 'judgement' ]
	},
	reboots_per_day: {
		label: 'Modem restarts', unit: 'per day',
		good: [ null, 0 ], marginal: [ null, 1 ],
		sources: [ 'judgement' ]
	},
	share_readings_failing: {
		label: 'Readings with a value out of spec', unit: 'share',
		good: [ null, 0 ], marginal: [ null, 0.05 ],
		sources: [ 'judgement' ]
	},
	share_readings_degraded: {
		label: 'Readings with a marginal value', unit: 'share',
		good: [ null, 0.05 ], marginal: [ null, 1 ],
		sources: [ 'judgement' ]
	}
};

/* ------------------------------------------------------------- helpers -- */

function num(v) {
	if (v == null || v === '') return null;
	var n = +v;
	return isFinite(n) ? n : null;
}

function worse(a, b) { return RANK[b] > RANK[a] ? b : a; }

/* Where a value falls in a limit: { good: [lo, hi], marginal: [lo, hi] }.
 * Either end may be null (no bound). Outside marginal is bad. */
function within(v, r) {
	return r && (r[0] == null || v >= r[0]) && (r[1] == null || v <= r[1]);
}

function band(v, limit) {
	if (v == null || !limit) return UNKNOWN;
	if (within(v, limit.good)) return GOOD;
	if (within(v, limit.marginal)) return MARGINAL;
	return BAD;
}

function isOfdm(ch) { return /OFDM/i.test(ch.modulation || ''); }

/* ------------------------------------------------------------ channels -- */

/* Which limits apply to a channel. Upstream SC-QAM transmit power limits
 * depend on how many SC-QAM channels the modem is bonding. */
function limitsFor(ch, usScqamCount, limits) {
	limits = limits || LIMITS;
	if (ch.dir === 'ds') {
		if (isOfdm(ch))
			return { power: limits.ds_power_ofdm, snr: limits.ds_mer_ofdm };
		var p = num(ch.power_dbmv), low = limits.ds_snr_low_power;
		return { power: limits.ds_power, snr: low && p != null && p < low.below_power ? low : limits.ds_snr };
	}
	if (isOfdm(ch))
		return { power: limits.us_power_ofdma };
	var byCount = limits.us_power_by_channels || {};
	var n = Math.max(1, Math.min(usScqamCount || 1, 4));
	return { power: byCount[n] || limits.us_power };
}

/* channelVerdict(ch, usScqamCount, limits)
 * ch: one row of channels.csv (dir, lock, modulation, power_dbmv, snr_db)
 * -> { level, checks: [ { metric, value, level, limit } ] } */
function channelVerdict(ch, usScqamCount, limits) {
	var L = limitsFor(ch, usScqamCount, limits), checks = [], level = GOOD;
	var locked = !ch.lock || /^locked$/i.test(ch.lock);
	if (!locked) {
		checks.push({ metric: 'lock', value: ch.lock, level: BAD, limit: (limits || LIMITS).lock });
		level = BAD;
	}
	var p = num(ch.power_dbmv);
	if (p != null && L.power) {
		var lp = band(p, L.power);
		checks.push({ metric: 'power', value: p, level: lp, limit: L.power });
		level = worse(level, lp);
	}
	var s = num(ch.snr_db);
	if (s != null && L.snr) {
		var ls = band(s, L.snr);
		checks.push({ metric: 'snr', value: s, level: ls, limit: L.snr });
		level = worse(level, ls);
	}
	return { level: level, checks: checks };
}

/* ------------------------------------------------------------- reading -- */

function countScqamUp(channels) {
	return channels.filter(function(c) { return c.dir === 'us' && !isOfdm(c); }).length;
}

/* readingVerdict(reading, channels, limits)
 * reading: one row of readings.csv; channels: its rows of channels.csv
 * -> { level: healthy|degraded|failing|unknown, reasons: [ ... ], channels: [ ... ] } */
function readingVerdict(reading, channels, limits) {
	if (!reading || reading.result !== 'ok')
		return { level: UNKNOWN, reasons: [ { kind: 'failed_reading', detail: reading ? reading.reason : '' } ], channels: [] };
	var usN = countScqamUp(channels), reasons = [], level = HEALTHY;
	var verdicts = channels.map(function(ch) {
		var v = channelVerdict(ch, usN, limits);
		v.channel = ch;
		v.checks.forEach(function(c) {
			if (c.level === GOOD || c.level === UNKNOWN) return;
			reasons.push({ kind: ch.dir + '_' + c.metric, level: c.level, channel: ch, value: c.value, limit: c.limit });
		});
		return v;
	});
	reasons.forEach(function(r) { level = worse(level, r.level === BAD ? FAILING : DEGRADED); });
	if (reading.connectivity && !/^operational$/i.test(reading.connectivity)) {
		reasons.push({ kind: 'not_operational', level: BAD, detail: reading.connectivity });
		level = FAILING;
	}
	if (channels.length && !channels.some(function(c) { return c.dir === 'ds'; })) {
		reasons.push({ kind: 'no_downstream', level: BAD });
		level = FAILING;
	}
	reasons.sort(function(a, b) { return RANK[b.level] - RANK[a.level]; });
	return { level: level, reasons: reasons, channels: verdicts };
}

/* -------------------------------------------------------------- events -- */

/* What a modem event log message means. Order matters: first match wins. */
var EVENT_KINDS = [
	{ kind: 'login', re: /WebGUI login/i },
	{ kind: 't4', re: /T4 time[- ]?out/i },
	{ kind: 't3', re: /T3 time[- ]?out/i },
	{ kind: 't2', re: /T2 time[- ]?out/i },
	{ kind: 't6', re: /T6 time[- ]?out/i },
	{ kind: 'sync_loss', re: /Loss of Sync|SYNC Timing Synchronization failure/i },
	{ kind: 'mdd_loss', re: /Lost MDD Timeout/i },
	{ kind: 'ranging', re: /RNG-RSP|REG-RSP|Ranging Request Retries exhausted/i },
	{ kind: 'reboot', re: /Cold Start|Warm Start|reboot/i },
	{ kind: 'status_report', re: /CM-STATUS message sent/i },
	{ kind: 'config', re: /Diplexer|MIMO Event|TLV-|config file/i }
];

/* Kinds that mean the connection was disrupted. */
var DISRUPTIVE = { t4: 1, t3: 1, t2: 1, t6: 1, sync_loss: 1, mdd_loss: 1 };

function classifyEvent(message) {
	for (var i = 0; i < EVENT_KINDS.length; i++)
		if (EVENT_KINDS[i].re.test(message || '')) return EVENT_KINDS[i].kind;
	return 'other';
}

/* Turns the modem's log text (entries split by "}-{", fields by "^") into
 * events: { time: 'MM/DD/YYYY HH:MM:SS', level, message, kind }. */
function parseModemLog(text) {
	return String(text || '').split('}-{').map(function(e) {
		var f = e.split('^');
		return { time: f[1] || '', level: f[3] || '', message: f[4] || '', kind: classifyEvent(f[4]) };
	}).filter(function(e) { return e.time; });
}

/* -------------------------------------------------------------- period -- */

/* periodVerdict(input, limits)
 * input: {
 *   hours:     length of the period in hours,
 *   readings:  [ { ts, level } ]  (level from readingVerdict),
 *   events:    [ { kind } ]       (from the stored event log),
 *   reboots:   number, outages: [ { start, end } ]
 * }
 * Uncorrectable error counts are reported, not judged: no published
 * standard gives a field threshold, and the S33/S34 does not report the
 * total number of codewords needed for an error rate.
 * -> { level, reasons: [ { kind, level, count, perDay, limit } ], counts } */
function periodVerdict(input, limits) {
	var L = limits || LIMITS, hours = Math.max(input.hours || 0, 1 / 60), days = hours / 24;
	var reasons = [], counts = { readings: 0, failing: 0, degraded: 0, unknown: 0 };
	(input.readings || []).forEach(function(r) {
		counts.readings++;
		if (r.level === FAILING) counts.failing++;
		else if (r.level === DEGRADED) counts.degraded++;
		else if (r.level === UNKNOWN) counts.unknown++;
	});
	var byKind = {};
	(input.events || []).forEach(function(e) { byKind[e.kind] = (byKind[e.kind] || 0) + 1; });
	counts.events = byKind;
	counts.reboots = input.reboots || 0;
	counts.outages = (input.outages || []).length;

	function rate(kind, count, limit) {
		if (!count || !limit) return;
		var perDay = count / days, level = band(perDay, limit);
		if (level === GOOD) return;
		reasons.push({ kind: kind, level: level, count: count, perDay: perDay, limit: limit });
	}
	rate('outage', counts.outages, L.outages_per_day);
	rate('t4', byKind.t4, L.t4_per_day);
	rate('t3', byKind.t3, L.t3_per_day);
	rate('sync_loss', byKind.sync_loss, L.sync_loss_per_day);
	rate('reboot', counts.reboots, L.reboots_per_day);

	var judged = counts.readings - counts.unknown;
	if (judged > 0) {
		var share = function(n, limit, kind) {
			if (!n || !limit) return;
			var level = band(n / judged, limit);
			if (level !== GOOD) reasons.push({ kind: kind, level: level, count: n, share: n / judged, limit: limit });
		};
		share(counts.failing, L.share_readings_failing, 'readings_out_of_spec');
		share(counts.degraded, L.share_readings_degraded, 'readings_marginal');
	}

	var level = HEALTHY;
	reasons.forEach(function(r) { level = worse(level, r.level === BAD ? FAILING : DEGRADED); });
	reasons.sort(function(a, b) { return RANK[b.level] - RANK[a.level] || (b.perDay || b.share || 0) - (a.perDay || a.share || 0); });
	if (!judged && !reasons.length) level = UNKNOWN;
	return { level: level, reasons: reasons, counts: counts };
}

return baseclass.extend({
	GOOD: GOOD, MARGINAL: MARGINAL, BAD: BAD, UNKNOWN: UNKNOWN,
	HEALTHY: HEALTHY, DEGRADED: DEGRADED, FAILING: FAILING,
	SOURCES: SOURCES, LIMITS: LIMITS, DISRUPTIVE: DISRUPTIVE,
	num: num, band: band, limitsFor: limitsFor,
	channelVerdict: channelVerdict, readingVerdict: readingVerdict,
	classifyEvent: classifyEvent, parseModemLog: parseModemLog,
	periodVerdict: periodVerdict
});
