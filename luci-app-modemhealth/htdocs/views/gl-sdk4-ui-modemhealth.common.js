/*
 * Modem Health
 * Page for the GL.iNet admin panel (menu entry /usr/share/oui/menu.d/modemhealth.json).
 * The panel evaluates this file and uses the result as a Vue component, the
 * same way as its own plugin pages. It only provides a frame; Modem Health
 * itself runs inside it (/luci-static/resources/modemhealth/gl.js), so its
 * styles and scripts cannot change how the panel looks or works. The
 * frame's content comes from this page itself (srcdoc), not from a separate
 * address.
 * SPDX-License-Identifier: MIT
 */
module.exports = (function() {
	'use strict';
	var stamp = Date.now();
	var page = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
		'<meta name="viewport" content="width=device-width,initial-scale=1"><title>Modem Health</title></head>' +
		'<body><script src="/luci-static/resources/modemhealth/gl.js?_t=' + stamp + '"></script></body></html>';
	return {
		name: 'modemhealth',
		render: function(h) {
			return h('div', { staticClass: 'modemhealth-gl', style: { width: '100%', paddingBottom: '16px' } }, [
				h('iframe', {
					attrs: { title: 'Modem Health', srcdoc: page },
					style: { display: 'block', width: '100%', height: '720px', border: '0', background: 'transparent' }
				})
			]);
		}
	};
})();
