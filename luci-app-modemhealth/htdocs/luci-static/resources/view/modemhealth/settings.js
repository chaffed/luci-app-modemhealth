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
	timeout: _('The modem did not answer in time.'),
	tls_error: _('Could not set up a secure connection to the modem.'),
	not_a_supported_modem: _('Something answered at this address, but it is not a supported modem (SURFboard S33 or S34).'),
	no_openssl: _('The openssl-util package is missing on the router.')
};

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
