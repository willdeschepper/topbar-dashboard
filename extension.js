// SPDX-License-Identifier: GPL-2.0-or-later
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {Dashboard} from './dashboard.js';

export default class TopbarDashboardExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._dashboard = new Dashboard(this._settings);

        // Botão sem menu próprio: só abre/fecha o dashboard
        this._button = new PanelMenu.Button(0.0, this.metadata.name, true);
        this._button.add_child(new St.Icon({
            icon_name: 'view-grid-symbolic',
            style_class: 'system-status-icon',
        }));
        this._pressId = this._button.connect('button-press-event', () => {
            this._dashboard.toggle();
            return Clutter.EVENT_STOP;
        });
        this._touchId = this._button.connect('touch-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            this._dashboard.toggle();
            return Clutter.EVENT_STOP;
        });

        Main.panel.addToStatusArea(this.uuid, this._button, 0, 'center');
    }

    disable() {
        if (this._pressId)
            this._button.disconnect(this._pressId);
        if (this._touchId)
            this._button.disconnect(this._touchId);
        this._pressId = this._touchId = 0;
        this._button?.destroy();
        this._button = null;
        this._dashboard?.destroy();
        this._dashboard = null;
        this._settings = null;
    }
}
