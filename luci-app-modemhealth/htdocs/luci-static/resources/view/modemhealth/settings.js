'use strict';
'require view';
'require form';
'require ui';
'require modemhealth.common as mh';

/*
 * Modem Health - Settings (UCI config /etc/config/modemhealth).
 *
 * The modem password is not part of this form: it is kept in
 * /etc/config/modemhealth_auth, which the page never loads, and is saved
 * through the set_password call. The page only learns whether one is set.
 * SPDX-License-Identifier: MIT
 */

var REASONS = {
	no_password: _('No password entered.'),
	login_refused: _('The modem refused the user name or password.'),
	unreachable: _('The modem did not answer at this address. Is it a cable modem in bridge mode, connected to the router\'s WAN port?'),
	timeout: _('Nothing answered at this address in time. Check the modem address, and that the modem is on and connected to the router\'s WAN port.'),
	tls_error: _('Could not set up a secure connection to the modem.'),
	not_a_supported_modem: _('Something answered at this address, but it is not a supported modem (SURFboard S33 or S34).'),
	no_openssl: _('The openssl-util package is missing on the router.')
};

var H = mh.health;
var BOUND_TEXT = { good_min: _('good from'), good_max: _('good up to'), acceptable_min: _('acceptable from'), acceptable_max: _('acceptable up to') };
var SIGNAL = /^(ds_|us_)/;

/* The health limits: one field per bound, empty = the default. */
function limitsSection(m) {
	var s = m.section(form.NamedSection, 'limits', 'limits', _('Health limits'),
		_('What counts as good, acceptable (marginal) and out of spec. Leave a field empty to use Modem Health\'s default, which comes from the DOCSIS specifications and manufacturers\' guidance where they publish one. The dashboard and the report say which limits you changed, and that the default\'s sources no longer back them.'));
	s.anonymous = true;
	s.tab('signal', _('Signal levels'));
	s.tab('events', _('Events'));
	H.limitList().forEach(function(it) {
		var fields = H.limitFields(it.key, it.limit), rechecking = false;
		var unit = it.limit.unit === 'share' ? '%' : it.limit.unit;
		var defText = fields.map(function(f) { return '%s %s'.format(BOUND_TEXT[f.option.slice(it.key.length + 1)], f.value); }).join(', ');
		var sources = it.limit.sources.map(function(k) { return H.SOURCES[k].kind === 'judgement' ? _('Modem Health\'s judgement') : H.SOURCES[k].title; });
		fields.forEach(function(f, i) {
			var o = s.taboption(SIGNAL.test(it.key) ? 'signal' : 'events', form.Value, f.option,
				'%s: %s'.format(it.limit.label, BOUND_TEXT[f.option.slice(it.key.length + 1)]),
				i === fields.length - 1 ? _('Default: %s (%s). Source: %s.').format(defText, unit, sources.join('; ')) : null);
			o.placeholder = String(f.value);
			o.datatype = 'float';
			o.rmempty = true;
			/* The good range must lie within the acceptable range. A change
			 * to one bound re-checks the limit's other bounds. */
			o.validate = function(section_id, value) {
				var b = { good: it.limit.good.slice(), marginal: it.limit.marginal.slice() };
				var sibling = L.bind(function(g) { return this.section.children.filter(function(c) { return c.option === g.option; })[0]; }, this);
				fields.forEach(function(g) {
					var opt = sibling(g), v = H.num(g.option === f.option ? value : (opt ? opt.formvalue(section_id) : null));
					if (v != null) b[g.band][g.end] = v;
				});
				if (!rechecking) {
					rechecking = true;
					window.setTimeout(function() {
						fields.forEach(function(g) {
							var el = g.option !== f.option && sibling(g) ? sibling(g).getUIElement(section_id) : null;
							if (el) el.triggerValidation();
						});
						rechecking = false;
					}, 0);
				}
				var lo = function(x) { return x == null ? -Infinity : x; }, hi = function(x) { return x == null ? Infinity : x; };
				if (lo(b.good[0]) > hi(b.good[1])) return _('The good range is empty: "from" is above "up to".');
				if (lo(b.good[0]) < lo(b.marginal[0]) || hi(b.good[1]) > hi(b.marginal[1])) return _('The good range must lie within the acceptable range.');
				return true;
			};
		});
	});
	return s;
}

function reasonText(r) {
	if (REASONS[r]) return REASONS[r];
	if (/^http_404$/.test(r)) return _('The modem answered "not found": it may not be a supported model (SURFboard S33 or S34).');
	return _('The check failed (%s).').format(r || '?');
}

return view.extend({
	load: function() {
		return mh.callStatus().catch(function() { return {}; });
	},

	render: function(st) {
		var m, s, o, self = this;
		this.status = st;

		m = new form.Map('modemhealth', _('Modem Health – Settings'),
			_('How the router reaches your cable modem, how often it checks it, and how long the history is kept.'));

		s = m.section(form.NamedSection, 'main', 'modemhealth');
		s.anonymous = true;
		s.tab('modem', _('Modem'));
		s.tab('schedule', _('Schedule'));
		s.tab('storage', _('Storage'));
		s.tab('report', _('Report details'));

		o = s.taboption('modem', form.Value, 'host', _('Modem address'),
			_('SURFboard modems answer at 192.168.100.1 through the router\'s WAN port.'));
		o.datatype = 'or(host,hostport)';
		o.default = '192.168.100.1';
		o.placeholder = '192.168.100.1';
		o.rmempty = false;

		o = s.taboption('modem', form.Value, 'username', _('User name'), _('Usually "admin".'));
		o.default = 'admin';
		o.placeholder = 'admin';
		o.rmempty = false;

		/* Not stored in this config: see the header comment. */
		o = s.taboption('modem', form.Value, '_password', _('Password'),
			st.password_set
				? _('A password is saved. Leave empty to keep it, or type a new one. Saved passwords are never shown.')
				: _('The password you use for the modem\'s own web page. Newer SURFboards make you set one the first time you log in; check the label on the modem for the original.'));
		o.password = true;
		o.placeholder = st.password_set ? _('(saved)') : '';
		o.cfgvalue = function() { return ''; };
		o.write = function(section_id, value) { self.newPassword = value; };
		o.remove = function() {};

		o = s.taboption('modem', form.Button, '_test', _('Test connection'),
			_('Logs in to the modem with what is typed above, before you save it.'));
		o.inputtitle = _('Test connection');
		o.inputstyle = 'action';
		o.onclick = function(ev, section_id) {
			var get = function(name) {
				var opt = m.lookupOption(name, section_id);
				return opt ? opt[0].formvalue(section_id) : '';
			};
			var out = document.getElementById('mh-test-result');
			out.textContent = _('Testing…');
			return mh.callTest(get('host') || '192.168.100.1', get('username') || 'admin', get('_password') || '').then(function(r) {
				out.className = r.ok ? 'alert-message success' : 'alert-message warning';
				out.textContent = r.ok
					? _('Connected: %s, firmware %s, %d downstream and %d upstream channels.').format(r.model, r.firmware, r.downstream, r.upstream)
					: reasonText(r.reason);
			}).catch(function(e) {
				out.className = 'alert-message warning';
				out.textContent = _('The test could not run: %s').format(String(e));
			});
		};

		o = s.taboption('modem', form.DummyValue, '_test_result', ' ');
		o.rawhtml = true;
		o.cfgvalue = function() { return '<div id="mh-test-result"></div>'; };

		o = s.taboption('schedule', form.Flag, 'enabled', _('Check the modem on a schedule'));
		o.rmempty = false;
		o.default = '1';

		o = s.taboption('schedule', form.ListValue, 'interval', _('Check every'),
			_('The modem keeps only its last 100 log entries, which can be as little as two hours on a bad line, so check at least every 15 minutes.'));
		[ [ '1', _('1 minute') ], [ '2', _('2 minutes') ], [ '5', _('5 minutes (recommended)') ], [ '10', _('10 minutes') ], [ '15', _('15 minutes') ] ]
			.forEach(function(v) { o.value(v[0], v[1]); });
		o.default = '5';

		o = s.taboption('schedule', form.Value, 'ping_host', _('Internet host to ping'),
			_('Pinged at every check to tell an outage (no answer) from a working line.'));
		o.datatype = 'host';
		o.default = '1.1.1.1';
		o.placeholder = '1.1.1.1';

		o = s.taboption('storage', form.Value, 'history_days', _('Keep history for (days)'),
			_('About 4–8 MB for 90 days at 5-minute checks.'));
		o.datatype = 'and(uinteger,range(1,730))';
		o.default = '90';
		o.placeholder = '90';

		var drives = st.drives || [];
		o = s.taboption('storage', form.Value, 'export_dir', _('Copy to a USB drive (folder)'),
			_('After every check the new rows of the history are added to CSV files in this folder, and once a day the report is saved there as one file that opens in any browser. The router keeps its own copy; while the drive is unplugged the copy is skipped and caught up later. The report file includes the report details. Leave empty to switch this off.') + ' ' +
			(drives.length ? _('Drives found on this router: %s.').format(drives.join(', '))
				: _('No attached drive is found at the moment; plug one in and open this page again.')));
		drives.forEach(function(d) { o.value(d + '/modemhealth'); });
		o.rmempty = true;
		o.validate = function(section_id, value) {
			if (!value) return true;
			if (value === '/') return _('Choose a folder on the drive.');
			return /^\/[A-Za-z0-9._\/-]*$/.test(value) && value.indexOf('..') < 0 && value.length <= 200 ? true
				: _('Enter a full path starting with "/", using only letters, digits, ".", "_", "-" and "/".');
		};

		o = s.taboption('storage', form.Button, '_clear', _('Clear history'),
			_('Deletes every stored reading and event on the router. A copy on a USB drive is kept under a dated name.'));
		o.inputtitle = _('Clear history…');
		o.inputstyle = 'negative';
		o.onclick = function() {
			ui.showModal(_('Clear history?'), [
				E('p', {}, [ _('Every stored reading, channel value and modem event on the router will be deleted. This cannot be undone. Files already copied to a USB drive are kept under a dated name.') ]),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, [ _('Cancel') ]), ' ',
					E('button', { 'class': 'cbi-button cbi-button-negative', 'click': function() {
						return mh.callClear().then(function() {
							ui.hideModal();
							ui.addNotification(null, E('p', {}, [ _('History cleared.') ]), 'info');
						}).catch(function(e) {
							ui.hideModal();
							ui.addNotification(null, E('p', {}, [ _('The history was not cleared: %s').format(String(e.message || e)) ]), 'warning');
						});
					} }, [ _('Clear history') ])
				])
			]);
		};

		/* Printed on the report so that the provider can match it to an
		 * account; one line of text each. */
		[ [ 'isp_name', _('Provider'), _('This and the following details are only used on the report.') ],
		  [ 'subscriber', _('Subscriber name'), _('The name the account is in.') ],
		  [ 'account', _('Account number') ],
		  [ 'service_address', _('Service address') ] ].forEach(function(f) {
			o = s.taboption('report', form.Value, f[0], f[1], f[2]);
			o.datatype = 'maxlength(120)';
			o.rmempty = true;
		});

		limitsSection(m);

		return m.render();
	},

	/* Save the password (if one was typed) through its own call, then the
	 * other settings as usual. */
	handleSave: function(ev) {
		var self = this;
		self.newPassword = null;
		return this.super('handleSave', [ ev ]).then(function() {
			if (!self.newPassword) return;
			return mh.callSetPassword(self.newPassword).then(function(r) {
				if (!r || !r.ok) throw new Error(_('the router did not save it'));
				self.newPassword = null;
				ui.addNotification(null, E('p', {}, [ _('Password saved.') ]), 'info');
			}).catch(function(e) {
				ui.addNotification(null, E('p', {}, [ _('The password was not saved: %s').format(String(e.message || e)) ]), 'warning');
			});
		});
	}
});
