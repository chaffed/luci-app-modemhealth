/*
 * Modem Health inside the GL.iNet admin panel.
 *
 * The panel's menu entry (/usr/share/oui/menu.d/modemhealth.json) loads
 * /views/gl-sdk4-ui-modemhealth.common.js, which shows this script in a
 * frame of its own, so nothing here can change how the panel itself looks
 * or works. The script runs the same Overview view as LuCI, with a small
 * stand-in for the parts of LuCI it uses, and reaches the router through
 * the panel's own login: window.$request -> RPC object "modemhealth"
 * (/usr/lib/oui-httpd/rpc/modemhealth). Settings has a form of its own here.
 *
 * The modem password is write-only here too: the form sends a typed
 * password to set_password or test and is never given one back.
 *
 * As in LuCI, E() assigns a bare string child with innerHTML. Text from the
 * modem, the stored files or the settings is always passed as an array
 * child.
 * SPDX-License-Identifier: MIT
 */
(function() {
	'use strict';

	var BASE = '/luci-static/resources/';
	var STAMP = Date.now();

	var host = null, frame = null;
	try {
		if (window.parent !== window && typeof window.parent.$request === 'function')
			host = window.parent;
		frame = window.frameElement;
	} catch (e) {}

	/* ---------------------------------------------------- LuCI stand-ins -- */

	window._ = function(s) { return s; };

	function escHTML(s) {
		return String(s).replace(/[&<>"']/g, function(c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}

	/* LuCI's String.prototype.format, for the conversions Modem Health uses. */
	String.prototype.format = function() {
		var args = arguments, i = 0;
		return this.replace(/%(0|\x20)?(-)?(\d+)?(\.\d+)?([%dufsh])/g, function(m, pad, left, width, prec, type) {
			if (type === '%')
				return '%';
			if (i >= args.length)
				return m;
			var v = args[i++];
			if (type === 'd' || type === 'u')
				v = Math.floor(+v || 0).toFixed(0);
			else if (type === 'f')
				v = prec ? (+v || 0).toFixed(+prec.substring(1)) : String(+v || 0);
			else if (type === 'h')
				v = escHTML(v == null ? '' : v);
			else
				v = String(v);
			while (width && v.length < +width)
				v = left ? v + ' ' : (pad || ' ') + v;
			return v;
		});
	};

	function append(node, c) {
		if (c == null)
			return;
		if (Array.isArray(c)) {
			c.forEach(function(x) {
				if (x instanceof Node)
					node.appendChild(x);
				else if (x != null)
					node.appendChild(document.createTextNode(String(x)));
			});
		}
		else if (typeof c === 'function')
			append(node, c(node));
		else if (c instanceof Node)
			node.appendChild(c);
		else
			node.innerHTML = String(c);   /* LuCI semantics: see the note at the top */
	}

	window.E = function(tag, attrs, data) {
		var el = document.createElement(tag);
		if (attrs != null && (typeof attrs !== 'object' || Array.isArray(attrs) || attrs instanceof Node)) {
			data = attrs;
			attrs = null;
		}
		for (var k in attrs || {}) {
			var v = attrs[k];
			if (v == null)
				continue;
			if (typeof v === 'function')
				el.addEventListener(k, v);
			else if (typeof v === 'object')
				el.setAttribute(k, JSON.stringify(v));
			else
				el.setAttribute(k, v);
		}
		append(el, data);
		return el;
	};

	var dom = {
		content: function(node, c) {
			while (node.firstChild)
				node.removeChild(node.firstChild);
			append(node, c);
			return node;
		},
		append: function(node, c) {
			append(node, c);
			return node;
		}
	};

	var ROUTES = {
		'admin/services/modemhealth': 'overview',
		'admin/services/modemhealth/overview': 'overview',
		'admin/services/modemhealth/report': 'report',
		'admin/services/modemhealth/settings': 'settings'
	};

	window.L = {
		env: {},
		bind: function(fn, self) {
			var bound = Array.prototype.slice.call(arguments, 2);
			return function() { return fn.apply(self, bound.concat(Array.prototype.slice.call(arguments))); };
		},
		/* Links between the pages become "#page"; clicks on them are handled
		 * below, since the frame has no address of its own. */
		url: function() {
			return '#' + (ROUTES[Array.prototype.join.call(arguments, '/')] || 'overview');
		},
		resolveDefault: function(p, d) {
			return Promise.resolve(p).catch(function() { return d; });
		}
	};

	/* One call to the router, through the panel's login. */
	function call(method, params, seconds) {
		if (!host)
			return Promise.reject(new Error(_('This page only works inside the GL.iNet admin panel.')));
		return Promise.resolve(host.$request('call', [ 'sid', 'modemhealth', method, params || {} ],
			{ timeout: (seconds || 60) * 1000, isCancel: false, ignoreCoreErrTips: true })).then(function(res) {
			if (res && res.err_code) {
				var refused = new Error(res.err_msg || _('the router refused the request'));
				refused.field = res.field;
				throw refused;
			}
			return res;
		}, function(e) {
			var err = new Error(e && (e.message || e.err_msg || e.type) || String(e));
			err.field = e && e.field;
			throw err;
		});
	}

	/* The views call the rpcd object luci.modemhealth; the panel's module
	 * has the same methods, two under names the panel does not log. */
	var METHODS = { status: 'get_status', data: 'get_data' };
	var SECONDS = { check: 150, test: 150, data: 90, 'export': 320, clear: 150 };

	var rpc = {
		declare: function(o) {
			var names = o.params || [], expect = o.expect;
			return function() {
				var args = arguments, p = {};
				names.forEach(function(n, i) {
					if (args[i] !== undefined)
						p[n] = args[i];
				});
				return call(METHODS[o.method] || o.method, p, SECONDS[o.method]).then(function(res) {
					if (!expect)
						return res;
					var k = Object.keys(expect)[0];
					if (!k)
						return res != null ? res : expect[k];
					return res != null && res[k] != null ? res[k] : expect[k];
				});
			};
		}
	};

	var config = {}, limits = {};
	var uci = {
		load: function() {
			return call('get_config').then(function(r) {
				config = (r && r.config) || {};
				limits = (r && r.limits) || {};
			});
		},
		get: function(conf, section, option) {
			var from = section === 'limits' ? limits : config;
			return from[option] != null ? from[option] : null;
		}
	};

	var modal = null, modalReturn = null, notices = null;

	/* Distance from the top of this frame to the top of the visible part of
	 * the panel, so a dialog opens where the user is looking. */
	function visibleTop() {
		try {
			return Math.max(0, -frame.getBoundingClientRect().top);
		} catch (e) {
			return 0;
		}
	}

	var ui = {
		showModal: function(title, children) {
			ui.hideModal();
			modalReturn = document.activeElement;
			var box = E('div', { 'class': 'mhgl-modal', 'role': 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mhgl-modal-title' }, [
				E('h4', { 'id': 'mhgl-modal-title' }, [ title ]),
				E('div', {}, children)
			]);
			modal = E('div', { 'class': 'mhgl-backdrop', 'keydown': function(ev) {
				if (ev.key === 'Escape')
					ui.hideModal();
			} }, [ box ]);
			document.body.appendChild(modal);
			box.style.top = (visibleTop() + 72) + 'px';
			resize();
			var first = box.querySelector('button');
			if (first)
				first.focus();
			return box;
		},
		hideModal: function() {
			if (modal && modal.parentNode)
				modal.parentNode.removeChild(modal);
			modal = null;
			if (modalReturn && modalReturn.focus && document.contains(modalReturn))
				modalReturn.focus();
			modalReturn = null;
			resize();
		},
		addNotification: function(title, children, type) {
			var n = E('div', { 'class': 'alert-message ' + (type || ''), 'role': 'alert' }, [
				title ? E('strong', {}, [ title ]) : '',
				E('div', {}, children),
				E('button', { 'class': 'cbi-button', 'click': function() { n.parentNode.removeChild(n); resize(); } }, [ _('Dismiss') ])
			]);
			notices.appendChild(n);
			resize();
			return n;
		},
		/* A click handler that keeps its button busy until the work is done. */
		createHandlerFn: function(ctx, fn) {
			var bound = Array.prototype.slice.call(arguments, 2);
			return function(ev) {
				var btn = ev.currentTarget;
				btn.classList.add('spinning');
				btn.disabled = true;
				return Promise.resolve().then(function() {
					return (typeof fn === 'function' ? fn : ctx[fn]).apply(ctx, bound.concat([ ev ]));
				}).catch(function(e) {
					ui.addNotification(null, [ String(e && e.message || e) ], 'error');
				}).then(function() {
					btn.classList.remove('spinning');
					btn.disabled = false;
				});
			};
		}
	};

	var BUILTIN = {
		view: { extend: function(o) { return o; } },
		baseclass: { extend: function(o) { return o; } },
		rpc: rpc, ui: ui, uci: uci, dom: dom
	};

	/* LuCI-style modules ('require x.y as z' lines at the top, a "return"
	 * at the end), loaded from the same files LuCI serves. */
	var modules = {};

	function requireModule(name) {
		if (BUILTIN[name])
			return Promise.resolve(BUILTIN[name]);
		if (!/^(view\.)?modemhealth\.[a-z]+$/.test(name))
			return Promise.reject(new Error(_('%s is not available in the GL.iNet panel').format(name)));
		if (!modules[name]) {
			var path = BASE + name.replace(/\./g, '/') + '.js';
			modules[name] = fetch(path + '?_t=' + STAMP, { credentials: 'same-origin', cache: 'no-store' }).then(function(r) {
				if (!r.ok)
					throw new Error(_('could not load %s (HTTP %d)').format(path, r.status));
				return r.text();
			}).then(function(src) {
				return instantiate(src, path);
			});
			modules[name].catch(function() { delete modules[name]; });
		}
		return modules[name];
	}

	function instantiate(src, path) {
		var lines = src.split('\n'), reqs = [], m;
		for (var i = 0; i < lines.length; i++) {
			var line = lines[i].trim();
			if (line === '' || line === "'use strict';")
				continue;
			m = /^'require\s+([A-Za-z0-9_.]+)(?:\s+as\s+([A-Za-z_$][\w$]*))?'\s*;$/.exec(line);
			if (!m)
				break;
			reqs.push({ name: m[1], as: m[2] || m[1].split('.').pop() });
		}
		return Promise.all(reqs.map(function(r) { return requireModule(r.name); })).then(function(deps) {
			var fn = new Function(reqs.map(function(r) { return r.as; }).join(','), src + '\n//# sourceURL=' + path);
			return fn.apply(window, deps);
		});
	}

	/* ---------------------------------------------------------- theme -- */

	/* The panel's colours are CSS variables on its root element; copying
	 * them makes this page follow its light or dark theme. */
	var THEME = [ '--primary', '--primary-hover', '--primary-background', '--error', '--error-background',
		'--warning', '--warning-background', '--success', '--text-title', '--text-subtitle', '--text-strong',
		'--text-regular', '--text-weak', '--text-hint', '--text-disabled', '--background-card', '--background-title',
		'--background-content', '--background-disabled', '--border', '--divider', '--shadow', '--mask' ];

	function luminance(color) {
		var c = document.createElement('canvas').getContext('2d');
		c.fillStyle = '#fff';
		c.fillStyle = color;
		var hex = c.fillStyle, r, g, b;
		if (/^#[0-9a-f]{6}$/i.test(hex)) {
			r = parseInt(hex.substr(1, 2), 16); g = parseInt(hex.substr(3, 2), 16); b = parseInt(hex.substr(5, 2), 16);
		} else {
			var m = /(\d+),\s*(\d+),\s*(\d+)/.exec(hex) || [ 0, 255, 255, 255 ];
			r = +m[1]; g = +m[2]; b = +m[3];
		}
		return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
	}

	function syncTheme() {
		if (!host)
			return;
		try {
			var cs = host.getComputedStyle(host.document.documentElement), root = document.documentElement.style;
			THEME.forEach(function(v) {
				var x = cs.getPropertyValue(v).trim();
				if (x)
					root.setProperty(v, x);
				else
					root.removeProperty(v);
			});
			var font = host.getComputedStyle(host.document.body).fontFamily;
			if (font)
				root.setProperty('--font', font);
			var card = cs.getPropertyValue('--background-card').trim();
			document.documentElement.setAttribute('data-theme', card && luminance(card) < 0.4 ? 'dark' : 'light');
		} catch (e) {}
	}

	function watchTheme() {
		if (!host || !window.MutationObserver)
			return;
		try {
			var mo = new MutationObserver(function() {
				syncTheme();
				setTimeout(syncTheme, 400);
				setTimeout(syncTheme, 1500);
			});
			mo.observe(host.document.head, { childList: true });
			window.addEventListener('pagehide', function() { mo.disconnect(); });
		} catch (e) {}
	}

	var CSS = [
		':root{--primary:#5272f7;--primary-hover:#425bc6;--primary-background:#eef1fe;--error:#e04c7e;--error-background:#fcedf2;',
		'--warning:#f5a623;--warning-background:#fef6e9;--success:#00c8b5;--text-title:#1f1f3d;--text-subtitle:#555557;--text-strong:#000;',
		'--text-regular:#141427;--text-weak:#333366;--text-hint:#b9b9bd;--text-disabled:#a0a0a3;--background-card:#fff;--background-title:#f2f2f7;',
		'--background-content:#ebebf0;--background-disabled:#ebebf0;--border:#d2d2d6;--divider:#ebebf0;--shadow:#d2d2d6;',
		'--mask:rgba(16,18,35,.24);--font:-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color-scheme:light}',
		/* The panel's own control colour is white in its dark theme too
		 * (its controls are styled separately), so buttons and fields here
		 * use a colour of their own. */
		':root{--mhgl-control:#fff}',
		':root[data-theme=dark]{color-scheme:dark;--mhgl-control:rgba(255,255,255,.06)}',
		'html,body{margin:0;padding:0;background:transparent}',
		'body{font:14px/1.5 var(--font);color:var(--text-regular);overflow:hidden}',
		'#mhgl-app{background:var(--background-card);border-radius:8px;padding:8px 24px 24px;box-sizing:border-box}',
		'.mhgl-nav{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--border);margin:0 0 16px}',
		'.mhgl-nav button{font:inherit;font-weight:600;color:var(--text-weak);background:none;border:0;border-bottom:2px solid transparent;margin:0 0 -1px;padding:10px 14px;min-height:44px;cursor:pointer}',
		'.mhgl-nav button:hover{color:var(--primary)}',
		'.mhgl-nav button[aria-current=page]{color:var(--primary);border-bottom-color:var(--primary)}',
		'h2{font-size:20px;line-height:1.3;color:var(--text-title);margin:4px 0 4px}',
		'h3{font-size:16px;color:var(--text-title);margin:22px 0 8px}',
		'h4{font-size:16px;margin:0 0 10px;color:var(--text-title)}',
		'a{color:var(--primary)}',
		'p{margin:.5em 0}',
		'.cbi-map-descr{color:var(--text-subtitle);margin:0 0 14px;max-width:72em}',
		'.cbi-section{margin:0 0 18px}',
		'details.cbi-section>summary,.mhgl-limits>summary{cursor:pointer;font-weight:600;color:var(--text-title);padding:8px 0}',
		'.cbi-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;min-height:36px;padding:6px 16px;',
		'border:1px solid var(--border);border-radius:6px;background:var(--mhgl-control);color:var(--text-regular);font:inherit;font-weight:500;cursor:pointer;text-decoration:none}',
		'.cbi-button:hover{border-color:var(--primary);color:var(--primary)}',
		'.cbi-button:disabled,.cbi-button[disabled]{opacity:.55;cursor:default}',
		'.cbi-button-action,.cbi-button-action:hover{background:var(--primary);border-color:var(--primary);color:#fff}',
		'.cbi-button-action:hover{background:var(--primary-hover);border-color:var(--primary-hover)}',
		'.cbi-button-negative{color:var(--error)}',
		'.cbi-button-negative:hover{border-color:var(--error);color:var(--error)}',
		':focus-visible{outline:2px solid var(--primary);outline-offset:2px}',
		'input,select,textarea{font:inherit;color:var(--text-regular);background:var(--mhgl-control);border:1px solid var(--border);border-radius:6px;padding:6px 10px;min-height:36px;box-sizing:border-box;max-width:100%}',
		'input:focus,select:focus,textarea:focus{border-color:var(--primary);outline:none}',
		'input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--primary);outline-offset:1px}',
		'textarea{min-height:72px}',
		'.alert-message ul{margin:0 0 .5em 1.2em;padding:0}',
		'input[type=checkbox]{width:18px;height:18px;min-height:0;vertical-align:-3px;accent-color:var(--primary)}',
		'.alert-message{border:1px solid var(--warning);background:var(--warning-background);border-radius:6px;padding:10px 14px;margin:10px 0}',
		'.alert-message.error,.alert-message.danger{border-color:var(--error);background:var(--error-background)}',
		'.alert-message.notice{border-color:var(--primary);background:var(--primary-background)}',
		'.alert-message.success{border-color:var(--success);background:transparent}',
		'.alert-message .cbi-button{margin-top:6px}',
		'table.table{border-collapse:collapse;width:100%;font-size:13px}',
		'.table th,.table td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--divider)}',
		'.table th{white-space:nowrap}',
		'.table .table-titles th{background:var(--background-title);color:var(--text-subtitle);font-weight:600}',
		'.right{text-align:right}',
		'.spinning::before{content:"";display:inline-block;width:12px;height:12px;margin-right:8px;vertical-align:-1px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:mhgl-spin .8s linear infinite}',
		'@keyframes mhgl-spin{to{transform:rotate(360deg)}}',
		'@media (prefers-reduced-motion:reduce){.spinning::before{animation:none}}',
		'.mhgl-backdrop{position:absolute;left:0;right:0;top:0;bottom:0;min-height:100%;background:var(--mask);z-index:50}',
		'.mhgl-modal .right{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}',
		'.mhgl-modal{position:absolute;left:50%;transform:translateX(-50%);width:min(480px,calc(100% - 32px));box-sizing:border-box;background:var(--background-card);border-radius:10px;padding:18px 20px;box-shadow:0 12px 32px rgba(0,0,0,.25)}',
		/* settings */
		'.mhgl-section{margin:0 0 8px}',
		'.mhgl-section h3{margin:20px 0 4px}',
		'.mhgl-row{display:grid;grid-template-columns:minmax(150px,260px) minmax(0,1fr);gap:4px 20px;padding:12px 0;border-bottom:1px solid var(--divider)}',
		'.mhgl-row>label,.mhgl-row>.mhgl-label{font-weight:500;color:var(--text-title);padding-top:7px}',
		'.mhgl-row input[type=text],.mhgl-row input[type=password]{width:28em}',
		'.mhgl-row select{min-width:16em}',
		'.mhgl-bounds{display:flex;flex-wrap:wrap;gap:8px 16px}',
		'.mhgl-bounds label{display:flex;flex-direction:column;font-size:13px;color:var(--text-subtitle)}',
		'.mhgl-bounds input[type=text]{width:8em}',
		'.mhgl-help{color:var(--text-subtitle);font-size:13px;margin:4px 0 0;max-width:60em}',
		'.mhgl-invalid{border-color:var(--error)!important}',
		'.mhgl-field-error{color:var(--error);font-size:13px;margin:4px 0 0;font-weight:500}',
		'.mhgl-actions-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:18px 0 0}',
		'.mhgl-saved{color:var(--text-subtitle)}',
		'@media (max-width:640px){#mhgl-app{padding:8px 14px 18px}.mhgl-row{grid-template-columns:1fr}.mhgl-row>label,.mhgl-row>.mhgl-label{padding-top:0}.mhgl-row input[type=text],.mhgl-row input[type=password],.mhgl-row select{width:100%;min-width:0}}'
	].join('\n');

	/* ------------------------------------------------------- settings -- */

	var DEFAULTS = { modem_type: 'auto', enabled: '1', interval: '5', host: '192.168.100.1', username: 'admin', ping_host: '1.1.1.1', history_days: '90',
		restart_auto: '0', restart_down_min: '10', restart_signal: '0', restart_signal_checks: '3', restart_on_unlocked: '1', restart_on_out_of_spec: '1',
		restart_max_hour: '1', restart_max_day: '3' };

	/* Test connection's answer for a T-Mobile gateway. */
	function gatewayText(r) {
		var radios = (r.radios || []).map(function(x) {
			return _('%s %s: RSRP %s dBm, SINR %s dB').format(x.tech === 'nr' ? '5G' : '4G', x.bands || '?',
				x.rsrp == null ? '?' : x.rsrp, x.sinr == null ? '?' : x.sinr);
		});
		return _('Connected: %s, firmware %s (T-Mobile gateway, %s). %s').format(r.model || '?', r.firmware || '?',
			r.registration || _('registration unknown'), radios.length ? radios.join('; ') + '.' : _('No radio is connected.'));
	}

	var MODEM_TYPES = [ [ 'auto', _('Detect') ], [ 'surfboard', _('SURFboard S33 / S34 cable modem') ], [ 'tmobile', _('T-Mobile 5G Home Internet gateway') ] ];
	var INTERVALS = [ [ '1', _('1 minute') ], [ '2', _('2 minutes') ], [ '5', _('5 minutes (recommended)') ],
		[ '10', _('10 minutes') ], [ '15', _('15 minutes') ] ];

	var REASONS = {
		no_password: _('No password entered.'),
		login_refused: _('The modem refused the user name or password.'),
		unreachable: _('The modem did not answer at this address. Is it a cable modem in bridge mode, connected to the router\'s WAN port?'),
		timeout: _('Nothing answered at this address in time. Check the modem address, and that the modem is on and connected to the router\'s WAN port.'),
		tls_error: _('Could not set up a secure connection to the modem.'),
		not_a_supported_modem: _('Something answered at this address, but it is not a supported modem (SURFboard S33 or S34).'),
		not_a_supported_device: _('Something answered at this address, but not like a T-Mobile 5G gateway. Check the address (usually 192.168.12.1) and the modem type.'),
		bad_reply: _('The modem\'s reply could not be read.'),
		no_openssl: _('The openssl-util package is missing on the router.'),
		invalid_input: _('The address, user name or password contains characters that cannot be used here.'),
		http_404: _('The modem answered "not found": it may not be a supported model (SURFboard S33 or S34).')
	};

	function reasonText(r) {
		return REASONS[r] || _('The check failed (%s).').format(r || '?');
	}

	/* The router counts bytes, so letters such as "é" count twice. */
	function textOk(max) {
		return function(v) {
			var bytes = window.TextEncoder ? new TextEncoder().encode(v).length : v.length;
			return bytes <= max && !/[\x00-\x1f\x7f]/.test(v) ? null : _('Up to %d characters on one line.').format(max);
		};
	}

	function pathOk(v) {
		if (v === '/')
			return _('Choose a folder on the drive.');
		return /^\/[A-Za-z0-9._\/-]*$/.test(v) && v.indexOf('..') < 0 && v.length <= 200 ? null
			: _('Enter a full path starting with "/", using only letters, digits, ".", "_", "-" and "/".');
	}

	function hostOk(port) {
		return function(v) {
			return (port ? /^[A-Za-z0-9.:_\-\[\]]+$/ : /^[A-Za-z0-9.:_-]+$/).test(v) && v.charAt(0) !== '-' && v.length <= 253
				? null : _('Enter a host name or IP address.');
		};
	}

	function sections(st) {
		var drives = st.drives || [];
		return [
			[ _('Modem'), [
				{ key: 'modem_type', type: 'select', label: _('Modem'), options: MODEM_TYPES,
					help: _('"Detect" uses a SURFboard at 192.168.100.1, and a T-Mobile 5G gateway at another address (usually 192.168.12.1). T-Mobile gateway support is new and not yet tested on a real gateway.') },
				{ key: 'host', type: 'text', label: _('Modem address'), check: hostOk(true),
					help: _('SURFboard modems answer at 192.168.100.1 through the router\'s WAN port; T-Mobile 5G gateways at 192.168.12.1 (no password needed).') },
				{ key: 'username', type: 'text', label: _('User name'), check: textOk(64), help: _('Usually "admin".') },
				{ key: 'password', type: 'password', label: _('Password'), check: textOk(128),
					help: st.password_set
						? _('A password is saved. Leave empty to keep it, or type a new one. Saved passwords are never shown.')
						: _('The password you use for the modem\'s own web page. Newer SURFboards make you set one the first time you log in; check the label on the modem for the original.') }
			] ],
			[ _('Schedule'), [
				{ key: 'enabled', type: 'flag', label: _('Check the modem on a schedule') },
				{ key: 'interval', type: 'select', label: _('Check every'), options: INTERVALS,
					help: _('The modem keeps only its last 100 log entries, which can be as little as two hours on a bad line, so check at least every 15 minutes.') },
				{ key: 'ping_host', type: 'text', optional: true, label: _('Internet host to ping'), check: hostOk(false),
					help: _('Pinged at every check to tell an outage (no answer) from a working line.') }
			] ],
			[ _('Storage'), [
				{ key: 'history_days', type: 'int', min: 1, max: 730, optional: true, label: _('Keep history for (days)'),
					help: _('About 4–8 MB for 90 days at 5-minute checks.') },
				{ key: 'export_dir', type: 'text', optional: true, label: _('Copy to a USB drive (folder)'), check: pathOk,
					suggestions: drives.map(function(d) { return d + '/modemhealth'; }),
					help: _('After every check the new rows of the history are added to CSV files in this folder, and once a day the report is saved there as one file that opens in any browser. The router keeps its own copy; while the drive is unplugged the copy is skipped and caught up later. The report file includes the report details. Leave empty to switch this off.') + ' ' +
						(drives.length ? _('Drives found on this router: %s.').format(drives.join(', '))
							: _('No attached drive is found at the moment; plug one in and open this page again.')) }
			] ],
			[ _('Restarts'), [
				{ key: 'restart_auto', type: 'flag', label: _('Restart the modem automatically'),
					help: _('Off unless you switch it on. Modem Health then restarts a SURFboard that answers but has lost its connection, as its own Restart button does. Every restart is recorded, and the report tells them apart from restarts the modem made on its own. A restart cannot fix a fault on the line: if restarts keep being needed, the provider has to look at it.') },
				{ key: 'restart_down_min', type: 'int', min: 1, max: 240, label: _('After no connection for (minutes)'),
					help: _('No connection: no answer from the internet host, the modem not "Operational", or no downstream channel locked, while the modem itself answers.') },
				{ key: 'restart_signal', type: 'flag', label: _('Also restart after bad signal'),
					help: _('Restarts can hide the faults the report is meant to show the provider: use this only if restarts really help your line.') },
				{ key: 'restart_signal_checks', type: 'int', min: 1, max: 100, label: _('After this many bad checks in a row'),
					help: _('A check is bad when it shows any of the signs chosen below.') },
				{ key: 'restart_on_unlocked', type: 'flag', label: _('Sign: a channel not locked') },
				{ key: 'restart_on_out_of_spec', type: 'flag', label: _('Sign: a channel outside the acceptable range'),
					help: _('Downstream power and SNR/MER and upstream power, against the health limits.') },
				{ key: 'restart_on_errors', type: 'int', min: 1, max: 999999999, optional: true, label: _('Sign: at least this many uncorrectable errors in one check'),
					help: _('Across all channels, since the check before. Empty: not a sign.') },
				{ key: 'restart_on_events', type: 'int', min: 1, max: 100, optional: true, label: _('Sign: at least this many disruptive log entries in one check'),
					help: _('T3/T4 time-outs, loss of sync, lost MDD. Empty: not a sign.') },
				{ key: 'restart_max_hour', type: 'int', min: 0, max: 10, label: _('At most this many automatic restarts an hour'),
					help: _('Over a limit Modem Health stops restarting, and the Overview says so. Nothing is counted for 15 minutes after a restart, while the modem comes back.') },
				{ key: 'restart_max_day', type: 'int', min: 0, max: 48, label: _('At most this many automatic restarts a day') }
			] ],
			[ _('Report details'), [
				{ key: 'isp_name', type: 'text', optional: true, label: _('Provider'), check: textOk(120),
					help: _('This and the following details are only used on the report.') },
				{ key: 'subscriber', type: 'text', optional: true, label: _('Subscriber name'), check: textOk(120), help: _('The name the account is in.') },
				{ key: 'account', type: 'text', optional: true, label: _('Account number'), check: textOk(120) },
				{ key: 'service_address', type: 'text', optional: true, label: _('Service address'), check: textOk(120) }
			] ]
		];
	}

	function fieldError(f, v) {
		if (v === '')
			return f.optional || f.type === 'password' ? null : _('Required.');
		if (f.type === 'int' && (!/^\d+$/.test(v) || +v < f.min || +v > f.max))
			return _('Enter a whole number from %d to %d.').format(f.min, f.max);
		if (f.type === 'number' && (!/^-?\d+(\.\d+)?$/.test(v) || v.length > 12))
			return _('Enter a number, for example 48 or -7.5.');
		return f.check ? f.check(v) : null;
	}

	var BOUND_TEXT = { good_min: _('good from'), good_max: _('good up to'), acceptable_min: _('acceptable from'), acceptable_max: _('acceptable up to') };

	function renderSettings() {
		return Promise.all([
			uci.load(),
			call('get_status').catch(function() { return {}; }),
			requireModule('modemhealth.health')
		]).then(function(data) {
			var st = data[1] || {}, H = data[2];
			var rows = {}, seq = 0, status = E('span', { 'class': 'mhgl-saved', 'role': 'status' });
			var val = function(k) { return config[k] != null ? String(config[k]) : (DEFAULTS[k] || ''); };

			var show = function(target, err, id, help) {
				return function(msg) {
					err.hidden = !msg;
					err.textContent = msg || '';
					target.classList.toggle('mhgl-invalid', !!msg);
					if (msg)
						target.setAttribute('aria-invalid', 'true');
					else
						target.removeAttribute('aria-invalid');
					target.setAttribute('aria-describedby', ((msg ? id + '-error ' : '') + (help || '')).trim());
				};
			};

			var control = function(f) {
				var id = 'mhgl-f-' + f.key, help = f.help ? id + '-help' : null, el, extra = null;
				var a = { 'id': id, 'name': f.key, 'aria-describedby': help };
				if (f.type === 'flag') {
					a.type = 'checkbox';
					el = E('input', a);
					el.checked = val(f.key) === '1';
				}
				else if (f.type === 'select') {
					var opts = f.options, cur = val(f.key);
					if (!opts.some(function(o) { return o[0] === cur; }))
						opts = opts.concat([ [ cur, cur ] ]);
					el = E('select', a, opts.map(function(o) { return E('option', { 'value': o[0] }, [ o[1] ]); }));
					el.value = cur;
				}
				else if (f.type === 'password') {
					/* Never filled in from the router: it does not send one. */
					a.type = 'password';
					a.autocomplete = 'new-password';
					a.placeholder = st.password_set ? _('(saved)') : '';
					el = E('input', a);
				}
				else {
					a.type = 'text';
					a.autocomplete = 'off';
					if (f.type === 'int')
						a.inputmode = 'numeric';
					if (f.suggestions && f.suggestions.length) {
						a.list = id + '-list';
						extra = E('datalist', { 'id': a.list }, f.suggestions.map(function(v) { return E('option', { 'value': v }); }));
					}
					el = E('input', a);
					el.value = val(f.key);
					if (f.type === 'int')
						el.style.width = '10em';
				}
				var err = E('p', { 'class': 'mhgl-field-error', 'id': id + '-error', 'hidden': '' });
				var row = E('div', { 'class': 'mhgl-row' }, [
					E('label', { 'for': id }, [ f.label ]),
					E('div', {}, [ el, extra, err, f.help ? E('p', { 'class': 'mhgl-help', 'id': help }, [ f.help ]) : '' ])
				]);
				rows[f.key] = {
					f: f, row: row, input: el,
					value: function() {
						if (f.type === 'flag')
							return el.checked ? '1' : '0';
						return f.type === 'password' ? el.value : el.value.trim();
					},
					show: show(el, err, id, help)
				};
				return row;
			};

			/* One row per health limit, a field for each bound it has. */
			var limitRows = [];
			var limitRow = function(it) {
				var fields = H.limitFields(it.key, it.limit), id = 'mhgl-l-' + it.key;
				var unit = it.limit.unit === 'share' ? '%' : it.limit.unit;
				var sources = it.limit.sources.map(function(k) {
					return H.SOURCES[k].kind === 'judgement' ? _('Modem Health\'s judgement') : H.SOURCES[k].title;
				});
				var inputs = fields.map(function(f) {
					var bound = BOUND_TEXT[f.option.slice(it.key.length + 1)];
					var input = E('input', { 'type': 'text', 'name': f.option, 'id': 'mhgl-f-' + f.option, 'inputmode': 'decimal',
						'autocomplete': 'off', 'placeholder': String(f.value), 'aria-label': '%s: %s'.format(it.limit.label, bound) });
					input.value = limits[f.option] != null ? String(limits[f.option]) : '';
					return { f: f, input: input, label: E('label', {}, [ bound, input ]) };
				});
				var err = E('p', { 'class': 'mhgl-field-error', 'id': id + '-error', 'hidden': '' });
				var lr = {
					key: it.key, inputs: inputs,
					/* A number in every filled field, and the good range within
					 * the acceptable range (as LuCI's Settings checks). */
					check: function() {
						var b = { good: it.limit.good.slice(), marginal: it.limit.marginal.slice() }, msg = null, bad = null;
						inputs.forEach(function(x) {
							var v = x.input.value.trim(), m = v === '' ? null : fieldError({ type: 'number' }, v);
							if (m && !msg) { msg = m; bad = x; }
							if (v !== '' && !m)
								b[x.f.band][x.f.end] = +v / x.f.scale;
						});
						var lo = function(n) { return n == null ? -Infinity : n; }, hi = function(n) { return n == null ? Infinity : n; };
						if (!msg && lo(b.good[0]) > hi(b.good[1]))
							msg = _('The good range is empty: "from" is above "up to".');
						if (!msg && (lo(b.good[0]) < lo(b.marginal[0]) || hi(b.good[1]) > hi(b.marginal[1])))
							msg = _('The good range must lie within the acceptable range.');
						err.hidden = !msg;
						err.textContent = msg || '';
						inputs.forEach(function(x) { x.input.classList.toggle('mhgl-invalid', !!msg && (!bad || bad === x)); });
						return msg ? (bad || inputs[0]).input : null;
					}
				};
				limitRows.push(lr);
				return E('div', { 'class': 'mhgl-row' }, [
					E('div', { 'class': 'mhgl-label' }, [ it.limit.label ]),
					E('div', {}, [
						E('div', { 'class': 'mhgl-bounds' }, inputs.map(function(x) { return x.label; })),
						err,
						E('p', { 'class': 'mhgl-help' }, [ _('Default: %s (%s). Source: %s.').format(
							fields.map(function(f) { return '%s %s'.format(BOUND_TEXT[f.option.slice(it.key.length + 1)], f.value); }).join(', '),
							unit, sources.join('; ')) ])
					])
				]);
			};
			var limitGroup = function(title, items) {
				var changed = items.filter(function(it) {
					return H.limitFields(it.key, it.limit).some(function(f) { return limits[f.option] != null; });
				}).length;
				var d = E('details', { 'class': 'mhgl-limits' }, [
					E('summary', {}, [ changed ? _('%s (%d changed)').format(title, changed) : title ])
				].concat(items.map(limitRow)));
				if (changed)
					d.open = true;
				d.addEventListener('toggle', resize);
				return d;
			};

			var testOut = E('div', { 'id': 'mhgl-test-result', 'role': 'status' });
			var testBtn = E('button', { 'type': 'button', 'class': 'cbi-button', 'click': ui.createHandlerFn(null, function() {
				testOut.className = '';
				testOut.textContent = _('Testing…');
				return call('test', { host: rows.host.value(), username: rows.username.value(), password: rows.password.value() }, 150).then(function(r) {
					testOut.className = r.ok ? 'alert-message success' : 'alert-message';
					testOut.textContent = r.ok
						? (r.type === 'tmobile' ? gatewayText(r) : _('Connected: %s, firmware %s, %d downstream and %d upstream channels.').format(r.model, r.firmware, r.downstream, r.upstream))
						: reasonText(r.reason);
				}).catch(function(e) {
					testOut.className = 'alert-message';
					testOut.textContent = _('The test could not run: %s').format(e.message);
				}).then(resize);
			}) }, [ _('Test connection') ]);

			var clearBtn = E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-negative', 'click': function() {
				ui.showModal(_('Clear history?'), [
					E('p', {}, [ _('Every stored reading, channel value and modem event on the router will be deleted. This cannot be undone. Files already copied to a USB drive are kept under a dated name.') ]),
					E('div', { 'class': 'right' }, [
						E('button', { 'type': 'button', 'class': 'cbi-button', 'click': ui.hideModal }, [ _('Cancel') ]),
						E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-negative', 'click': function() {
							return call('clear', {}, 150).then(function() {
								ui.hideModal();
								status.textContent = _('History cleared.');
							}).catch(function(e) {
								ui.hideModal();
								status.textContent = _('The history was not cleared: %s').format(e.message);
							});
						} }, [ _('Clear history') ])
					])
				]);
			} }, [ _('Clear history…') ]);

			var all = H.limitList();
			var form = E('form', { 'novalidate': '' }, sections(st).map(function(s, i) {
				var kids = [ E('h3', {}, [ s[0] ]) ].concat(s[1].map(control));
				if (s[1].some(function(f) { return f.key === 'export_dir'; }))
					kids.push(E('div', { 'class': 'mhgl-row' }, [
						E('div', { 'class': 'mhgl-label' }, [ _('Clear history') ]),
						E('div', {}, [ clearBtn, E('p', { 'class': 'mhgl-help' }, [ _('Deletes every stored reading and event on the router. A copy on a USB drive is kept under a dated name.') ]) ])
					]));
				if (i === 0)
					kids.push(E('div', { 'class': 'mhgl-row' }, [
						E('div', { 'class': 'mhgl-label' }, [ _('Test connection') ]),
						E('div', {}, [ testBtn, E('p', { 'class': 'mhgl-help' }, [ _('Logs in to the modem with what is typed above, before you save it.') ]), testOut ])
					]));
				return E('div', { 'class': 'mhgl-section' }, kids);
			}).concat([
				E('div', { 'class': 'mhgl-section' }, [
					E('h3', {}, [ _('Health limits') ]),
					E('p', { 'class': 'cbi-map-descr' }, [ _('What counts as good, acceptable (marginal) and out of spec. Leave a field empty to use Modem Health\'s default, which comes from the DOCSIS specifications and manufacturers\' guidance where they publish one. The dashboard and the report say which limits you changed, and that the default\'s sources no longer back them.') ]),
					limitGroup(_('Signal levels'), all.filter(function(it) { return /^(ds_|us_|lte_|nr_)/.test(it.key); })),
					limitGroup(_('Events'), all.filter(function(it) { return !/^(ds_|us_|lte_|nr_)/.test(it.key); }))
				])
			]));

			var saveBtn = E('button', { 'type': 'submit', 'class': 'cbi-button cbi-button-action' }, [ _('Save') ]);
			form.appendChild(E('div', { 'class': 'mhgl-actions-row' }, [ saveBtn, status ]));

			form.addEventListener('submit', function(ev) {
				ev.preventDefault();
				var values = {}, first = null, password = '';
				Object.keys(rows).forEach(function(k) {
					var r = rows[k], v = r.value(), msg = fieldError(r.f, v);
					r.show(msg);
					if (msg && !first)
						first = r.input;
					if (k === 'password')
						password = v;
					else
						values[k] = v;
				});
				limitRows.forEach(function(lr) {
					var bad = lr.check();
					if (bad && !first) {
						first = bad;
						bad.closest('details').open = true;
					}
					lr.inputs.forEach(function(x) { values[x.f.option] = x.input.value.trim(); });
				});
				if (first) {
					status.textContent = _('Please correct the highlighted setting.');
					first.focus();
					resize();
					return;
				}
				var my = ++seq;
				saveBtn.disabled = true;
				status.textContent = _('Saving…');
				call('set_config', { values: values }).then(function() {
					return password ? call('set_password', { password: password }) : null;
				}).then(function() {
					return Promise.all([ uci.load(), call('get_status').catch(function() { return st; }) ]);
				}).then(function(r) {
					if (my !== seq)
						return;
					st = r[1] || st;
					if (password) {
						rows.password.input.value = '';
						rows.password.input.placeholder = _('(saved)');
					}
					status.textContent = password
						? _('Saved, with the new password. The scheduler picks up the change within a minute.')
						: _('Saved. The scheduler picks up the change within a minute.');
				}).catch(function(e) {
					var r = e.field && rows[e.field];
					if (r) {
						r.show(_('The router did not accept this value (%s).').format(e.message));
						r.input.focus();
					}
					status.textContent = _('Not saved: %s').format(e.message);
				}).then(function() {
					saveBtn.disabled = false;
					resize();
				});
			});

			return E('div', {}, [
				E('h2', {}, [ _('Modem Health – Settings') ]),
				E('p', { 'class': 'cbi-map-descr' }, [ _('How the router reaches your cable modem, how often it checks it, and how long the history is kept.') ]),
				form
			]);
		});
	}

	/* ------------------------------------------------------------ page -- */

	var PAGES = [ [ 'overview', _('Overview') ], [ 'report', _('Report') ], [ 'settings', _('Settings') ] ];
	var app, nav, view, navSeq = 0;

	function resize() {
		if (!frame || !app)
			return;
		var h = app.offsetHeight;
		if (modal && modal.firstChild)
			h = Math.max(h, modal.firstChild.offsetTop + modal.firstChild.offsetHeight + 24);
		frame.style.height = Math.ceil(h) + 'px';
	}

	function runView(name) {
		return requireModule('view.modemhealth.' + name).then(function(View) {
			var v = Object.create(View);
			return Promise.resolve(v.load ? v.load() : null).then(function(d) { return v.render(d); });
		});
	}

	function show(page) {
		if (!PAGES.some(function(p) { return p[0] === page; }))
			page = 'overview';
		var my = ++navSeq;
		ui.hideModal();
		dom.content(notices, '');
		try { window.sessionStorage.setItem('modemhealth.gl.page', page); } catch (e) {}
		Array.prototype.forEach.call(nav.children, function(b) {
			if (b.getAttribute('data-page') === page)
				b.setAttribute('aria-current', 'page');
			else
				b.removeAttribute('aria-current');
		});
		dom.content(view, E('p', { 'class': 'spinning' }, [ _('Loading…') ]));
		if (visibleTop() > 0)
			try { frame.scrollIntoView({ block: 'start' }); } catch (e) {}
		return (page === 'settings' ? renderSettings() : runView(page)).then(function(node) {
			if (my === navSeq)
				dom.content(view, node);
		}).catch(function(e) {
			if (my === navSeq)
				dom.content(view, E('div', { 'class': 'alert-message error', 'role': 'alert' }, [
					_('Modem Health could not load this page: %s').format(e && e.message || e)
				]));
		}).then(resize);
	}

	function start() {
		document.head.appendChild(E('style', {}, [ CSS ]));
		syncTheme();
		watchTheme();

		nav = E('nav', { 'class': 'mhgl-nav', 'aria-label': _('Modem Health pages') }, PAGES.map(function(p) {
			return E('button', { 'type': 'button', 'data-page': p[0], 'click': function() { show(p[0]); } }, [ p[1] ]);
		}));
		notices = E('div');
		view = E('div', { 'id': 'mhgl-view' });
		app = E('div', { 'id': 'mhgl-app' }, [ nav, notices, view ]);
		document.body.appendChild(app);

		/* Links between the pages (L.url) are "#page". */
		document.addEventListener('click', function(ev) {
			var a = ev.target && ev.target.closest ? ev.target.closest('a[href^="#"]') : null;
			if (a) {
				ev.preventDefault();
				show(a.getAttribute('href').slice(1));
			}
		});

		if (window.ResizeObserver)
			new ResizeObserver(resize).observe(app);
		else
			setInterval(resize, 1000);

		if (!host) {
			dom.content(view, E('div', { 'class': 'alert-message error', 'role': 'alert' }, [
				_('This page only works inside the GL.iNet admin panel: open Applications → Modem Health there.')
			]));
			resize();
			return;
		}
		var first = null;
		try { first = window.sessionStorage.getItem('modemhealth.gl.page'); } catch (e) {}
		show(first || 'overview');
	}

	start();
})();
