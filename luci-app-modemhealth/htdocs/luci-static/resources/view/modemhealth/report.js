'use strict';
'require view';
'require uci';
'require dom';
'require modemhealth.common as mh';
'require modemhealth.report as rb';

/*
 * Modem Health - Report: a printable record of the line's health for the
 * provider's support or a technician. The document itself is built by
 * modemhealth/report.js and shown here as it is (in a frame): what is on
 * the screen is what prints and what the download holds.
 * SPDX-License-Identifier: MIT
 */

var H = mh.health;

function download(name, type, text) {
	var a = E('a', { 'href': URL.createObjectURL(new Blob([ text ], { type: type })), 'download': name });
	document.body.appendChild(a);
	a.click();
	setTimeout(function() { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

return view.extend({
	period: '7',
	html: '',
	seq: 0,

	load: function() {
		return Promise.all([
			mh.callStatus().catch(function() { return {}; }),
			uci.load('modemhealth').catch(function() {})
		]).then(function(r) { return r[0]; });
	},

	/* "Now" on the router's clock, which stamps the readings. */
	routerNow: function() {
		return Math.floor(Date.now() / 1000 + this.skew);
	},

	render: function(st) {
		var self = this;
		this.st = st || {};
		this.skew = this.st.now ? this.st.now - Date.now() / 1000 : 0;
		var opt = function(k) { return uci.get('modemhealth', 'main', k) || ''; };
		this.sub = { isp: opt('isp_name'), subscriber: opt('subscriber'), account: opt('account'), address: opt('service_address') };
		this.historyDays = +opt('history_days') || 90;
		this.pingHost = opt('ping_host') || '1.1.1.1';
		this.limits = H.applySettings(function(o) { return uci.get('modemhealth', 'limits', o); }).limits;

		var changed = function() { self.refresh(); };
		this.periodSel = E('select', { 'class': 'cbi-input-select', 'aria-label': _('Period'), 'change': function(ev) {
			self.period = ev.target.value;
			self.customBox.style.display = self.period === 'custom' ? '' : 'none';
			self.refresh();
		} }, rb.PERIODS.map(function(p) { return E('option', { 'value': p[0], 'selected': p[0] === self.period ? '' : null }, [ p[1] ]); }));
		this.fromInput = E('input', { 'type': 'date', 'class': 'cbi-input-text', 'change': changed, 'aria-label': _('From date') });
		this.toInput = E('input', { 'type': 'date', 'class': 'cbi-input-text', 'change': changed, 'aria-label': _('To date') });
		this.customBox = E('span', { 'style': 'display:none' }, [ ' ', this.fromInput, ' – ', this.toInput ]);
		this.timesBox = E('input', { 'type': 'checkbox', 'id': 'mh-report-times', 'checked': '', 'change': changed });
		this.notes = E('textarea', { 'class': 'cbi-input-textarea', 'rows': 3, 'style': 'width:100%', 'id': 'mh-report-notes',
			'placeholder': _('Optional: anything you want the reader to know, in your own words, such as when you first reported the problem and any ticket numbers. It is printed as "Subscriber\'s statement".'),
			'change': changed });
		this.msg = E('div', { 'role': 'status', 'id': 'mh-report-status' });
		this.frame = E('iframe', { 'title': _('Report'), 'id': 'mh-report-frame',
			'style': 'width:100%;min-height:640px;border:1px solid rgba(127,127,127,.4);border-radius:6px;background:#fff' });
		this.frame.addEventListener('load', function() {
			try { self.frame.style.height = (self.frame.contentDocument.documentElement.scrollHeight + 24) + 'px'; } catch (e) {}
		});

		var hints = rb.hints({ sub: this.sub, modem: this.st.modem });
		var root = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, [ _('Modem Health – Report') ]),
			E('div', { 'class': 'cbi-map-descr' }, [ _('A printable record of what the modem reported, for your provider\'s support or a technician: findings, every outage and event with its time, the signal against its limits, and how it was measured. Let checks run for at least three days before relying on it.') ]),
			hints.length ? E('div', { 'class': 'alert-message warning' }, [
				E('ul', { 'style': 'margin:0 0 .5em 1.2em' }, hints.map(function(h) { return E('li', {}, [ h ]); })),
				E('a', { 'class': 'cbi-button', 'href': L.url('admin/services/modemhealth/settings') }, [ _('Open Settings') ])
			]) : '',
			E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:.6em 1em;align-items:center;margin:.75em 0' }, [
				E('label', {}, [ _('Period') + ' ', this.periodSel ]),
				this.customBox,
				E('label', { 'for': 'mh-report-times' }, [ this.timesBox, ' ' + _('List every event with its time') ])
			]),
			this.notes,
			E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:.5em;margin:.75em 0' }, [
				E('button', { 'class': 'cbi-button cbi-button-action', 'click': function() { self.handlePrint(); } }, [ _('Print / save as PDF') ]),
				E('button', { 'class': 'cbi-button', 'click': function() { self.handleDownload(); } }, [ _('Download report (HTML)') ])
			]),
			this.msg,
			this.frame
		]);
		this.refresh();
		return root;
	},

	refresh: function() {
		var self = this, my = ++this.seq, now = this.routerNow();
		var w = rb.periodWindow(this.period, now, this.fromInput.value, this.toInput.value, this.historyDays);
		var interval = this.st.interval || 5;
		dom.content(this.msg, E('em', { 'class': 'spinning' }, [ _('Loading the history…') ]));
		return mh.loadDigest(w.from, w.to, interval, this.limits, function(done, of) {
			if (my === self.seq && of > 1)
				dom.content(self.msg, E('em', { 'class': 'spinning' }, [ _('Loading the history: part %d of %d…').format(done, of) ]));
		}).then(function(G) {
			if (my !== self.seq)
				return; /* a newer request has been made since */
			self.html = rb.build(G, {
				modem: self.st.modem, sub: self.sub, notes: self.notes.value, times: self.timesBox.checked,
				interval: interval, ping_host: self.pingHost, generated: now, version: self.st.version
			}).page();
			self.frame.srcdoc = self.html;
			dom.content(self.msg, '');
		}).catch(function(e) {
			if (my === self.seq)
				dom.content(self.msg, E('div', { 'class': 'alert-message error' }, [ _('Could not load the history: %s').format(e && e.message || e) ]));
		});
	},

	handlePrint: function() {
		var w = this.frame.contentWindow;
		if (w) { w.focus(); w.print(); }
	},

	handleDownload: function() {
		download('cable-line-health-report-%s.html'.format(new Date(this.routerNow() * 1000).toISOString().slice(0, 10)), 'text/html', this.html);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
