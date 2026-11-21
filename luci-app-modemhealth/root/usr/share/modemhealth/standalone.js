/*
 * Modem Health
 * Script for the self-contained report file the router saves to an attached
 * drive (modemhealth export). That file carries the history, the settings
 * the report needs and the same modules the Report page uses (MH_MODULES,
 * added by the router); this script stands in for the few LuCI facilities
 * those modules expect and draws the report, so the file works in any
 * browser without the router.
 * SPDX-License-Identifier: MIT
 */
(function() {
	'use strict';

	function $(id) { return document.getElementById(id); }

	function problem(text) {
		var p = document.createElement('p');
		p.id = 'mh-problem';
		p.textContent = text + ' The measurements themselves are in the CSV files next to this one.';
		$('mh-report').textContent = '';
		$('mh-report').appendChild(p);
	}

	/* ---- what the shared modules expect from LuCI ---- */

	window._ = function(s) { return s; };

	/* Same results as LuCI's String.prototype.format for the conversions used. */
	String.prototype.format = function() {
		var args = arguments, i = 0;
		return this.replace(/%(0|\x20)?(-)?(\d+)?(\.\d+)?([%dufs])/g, function(m, pad, left, width, prec, type) {
			if (type === '%')
				return '%';
			if (i >= args.length)
				return m;
			var v = args[i++];
			if (type === 'd' || type === 'u')
				v = Math.floor(+v || 0).toFixed(0);
			else if (type === 'f')
				v = prec ? (+v || 0).toFixed(+prec.substring(1)) : String(+v || 0);
			else
				v = String(v);
			while (width && v.length < +width)
				v = left ? v + ' ' : (pad || ' ') + v;
			return v;
		});
	};

	var baseclass = { extend: function(o) { return o; } };

	/* The history in this file, answering like the router's data call:
	 * the rows of a period, each kind with its header. */
	function stored(id) {
		var lines = $(id).textContent.split('\n').filter(function(l) { return l.length; });
		var rows = lines.slice(1);
		return { head: lines[0] || '', rows: rows, ts: rows.map(function(l) { return +l.slice(0, l.indexOf(',')); }) };
	}
	function between(s, since, until) {
		var lo = 0, hi = s.ts.length, a, b;
		while (lo < hi) { var m = (lo + hi) >> 1; if (s.ts[m] < since) lo = m + 1; else hi = m; }
		a = lo; hi = s.ts.length;
		while (lo < hi) { var k = (lo + hi) >> 1; if (s.ts[k] <= until) lo = k + 1; else hi = k; }
		b = lo;
		return s.head + '\n' + (b > a ? s.rows.slice(a, b).join('\n') + '\n' : '');
	}

	var H, mh, rb, ctx, data;
	try {
		ctx = JSON.parse($('mh-ctx').textContent);
		data = { readings: stored('mh-readings'), channels: stored('mh-channels'), events: stored('mh-events'), channelmap: $('mh-channelmap').textContent,
			/* A gateway's radios (files made before 1.1 have none). */
			radios: $('mh-radios') ? stored('mh-radios') : null,
			/* Restarts Modem Health made (files made before 1.2 have none). */
			restarts: $('mh-restarts') ? stored('mh-restarts') : null,
			/* ISPy's speed tests, when the router had any. */
			speed: $('mh-speedtests') ? stored('mh-speedtests') : null };
		var rpc = { declare: function(o) {
			return function(since, until) {
				if (o.method !== 'data')
					return Promise.reject(new Error('not connected to the router'));
				var d = { readings: between(data.readings, since, until), channels: between(data.channels, since, until),
					events: between(data.events, since, until), channelmap: data.channelmap,
					radios: data.radios ? between(data.radios, since, until) : '',
					restarts: data.restarts ? between(data.restarts, since, until) : '' };
				if (data.speed)
					d.speed = { plan_down: (ctx.speed || {}).plan_down, plan_up: (ctx.speed || {}).plan_up,
						tests: data.speed.head + '\n' + data.speed.rows.filter(function(l, i) { return data.speed.ts[i] >= since && data.speed.ts[i] <= until; }).join('\n') + '\n' };
				return Promise.resolve(d);
			};
		} };
		H = window.MH_MODULES.health(baseclass);
		mh = window.MH_MODULES.common(baseclass, rpc, H);
		rb = window.MH_MODULES.report(baseclass, mh);
	} catch (e) {
		problem('This report file is incomplete and cannot be displayed (' + (e && e.message || e) + ').');
		return;
	}

	var style = document.createElement('style');
	style.textContent = rb.css;
	document.head.insertBefore(style, document.head.querySelector('style'));

	var now = +ctx.exported || Math.floor(Date.now() / 1000);
	var held = Math.max(1, Math.round((now - (+ctx.since || now - 30 * 86400)) / 86400));
	var limits = H.applySettings(function(o) { return (ctx.limits || {})[o]; }).limits;
	var period = $('mh-period'), from = $('mh-from'), to = $('mh-to'), times = $('mh-times'), notes = $('mh-notes');
	var seq = 0;

	rb.PERIODS.forEach(function(p) {
		if (+p[0] > held)
			return; /* this file does not hold that much */
		var o = document.createElement('option');
		o.value = p[0];
		o.textContent = p[0] === 'all' ? 'Everything in this file (%d days)'.format(held) : p[1];
		o.selected = p[0] === '7';
		period.appendChild(o);
	});

	function draw() {
		$('mh-custom').hidden = period.value !== 'custom';
		var w = rb.periodWindow(period.value, now, from.value, to.value, held), my = ++seq;
		$('mh-status').textContent = 'Working…';
		mh.loadDigest(w.from, w.to, +ctx.interval || 5, limits).then(function(G) {
			if (my !== seq)
				return;
			$('mh-report').innerHTML = rb.build(G, {
				modem: ctx.modem, sub: ctx.sub, notes: notes.value, times: times.checked,
				interval: +ctx.interval || 5, ping_host: ctx.ping_host, generated: now, version: ctx.version
			}).body;
			$('mh-status').textContent = '';
		}).catch(function(e) {
			problem('This report could not be drawn (' + (e && e.message || e) + ').');
		});
	}

	[ period, from, to, times, notes ].forEach(function(el) { el.addEventListener('change', draw); });
	$('mh-print').addEventListener('click', function() { window.print(); });

	$('mh-saved').textContent = 'saved by the router on %s, with %d checks of the last %d days'.format(
		new Date(now * 1000).toLocaleString([], { dateStyle: 'long', timeStyle: 'short' }), data.readings.rows.length, held);

	$('mh-bar').hidden = false;
	draw();
})();
