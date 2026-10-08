// SPDX-License-Identifier: GPL-2.0-or-later
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';
import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    CARD_WIDTH, PAGE_HEIGHT, EAR_RADIUS, BG_RGB,
    GLASS_FROM_BMS, GLASS_BLUR, GLASS_TINT,
} from './config.js';
import {WeatherService, ResourcesService, MprisService} from './services.js';
import * as W from './widgets.js';

const V = Clutter.Orientation.VERTICAL;
const CENTER = Clutter.ActorAlign.CENTER;

// Traduzidos na hora de montar as abas (o idioma só é carregado depois do import)
const N_ = t => t;
const TABS = [
    {name: N_('Dashboard'), icon: 'view-grid-symbolic'},
    {name: N_('Media'), icon: 'audio-x-generic-symbolic'},
    {name: N_('Performance'), icon: 'utilities-system-monitor-symbolic'},
    {name: N_('Workspaces'), icon: 'focus-windows-symbolic'},
];
const PAD_X = 16; // precisa bater com o padding lateral de .wdt-card
const INDICATOR_W = 56;

const BMS_UUID = 'blur-my-shell@aunetx';
const BMS_PANEL_SCHEMA = 'org.gnome.shell.extensions.blur-my-shell.panel';
const BMS_GENERAL_SCHEMA = 'org.gnome.shell.extensions.blur-my-shell';
const EXTENSION_ENABLED = 1; // ExtensionState.ENABLED (antigo ACTIVE)

// Canto côncavo que liga a lateral do painel à borda de baixo da barra
function makeEar(side, getColor) {
    const R = EAR_RADIUS;
    const ear = new St.DrawingArea({width: R, height: R, reactive: true});
    ear.connect('repaint', area => {
        const cr = area.get_context();
        const [r, g, b, alpha] = getColor();
        cr.setSourceRGBA(r, g, b, alpha);
        cr.moveTo(0, 0);
        cr.lineTo(R, 0);
        if (side === 'left') {
            cr.lineTo(R, R);
            cr.arcNegative(0, R, R, 0, -Math.PI / 2);
        } else {
            cr.arcNegative(R, R, R, 3 * Math.PI / 2, Math.PI);
        }
        cr.closePath();
        cr.fill();
        cr.$dispose();
    });
    return ear;
}

// Desfoca o que está atrás do ator (janelas, wallpaper)
function makeBlurLayer() {
    const layer = new St.Widget({visible: false});
    layer._blur = new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND});
    layer.add_effect(layer._blur);
    return layer;
}

function applyBlur(effect, radius, brightness) {
    effect.brightness = brightness;
    // GNOME 46+ usa "radius" (= 2 × sigma); versões antigas usavam "sigma"
    if ('radius' in effect)
        effect.radius = radius * 2;
    else
        effect.sigma = radius;
}

const toUnit = v => (v > 1 ? v / 255 : v);

export class Dashboard {
    constructor(settings) {
        this._settings = settings;
        this._open = false;
        this._tick = 0;
        this._grab = null;
        this._refreshables = [];
        this._ticking = [];

        this._weather = new WeatherService();
        this._res = new ResourcesService();
        this._applySettings();
        this._settingsId = settings.connect('changed', () => this._applySettings());
        this._mpris = new MprisService();
        this._eventSource = new Calendar.DBusEventSource();

        this._glass = false;
        this._bmsPanel = null;
        this._bmsGeneral = null;
        this._bmsIds = [];
        this._earColor = [...BG_RGB, 1];

        this._build();
        this._overviewId = Main.overview.connect('showing', () => this.close());

        // Acompanha o Blur my Shell: ligou, desligou ou mudou o blur da barra
        this._extStateId = Main.extensionManager.connect('extension-state-changed', (_m, ext) => {
            if (ext.uuid === BMS_UUID)
                this._updateMode();
        });
        this._updateMode();
    }

    _applySettings() {
        const st = this._settings;
        const city = st.get_string('weather-city');
        this._weather.setLocation(
            st.get_double('weather-latitude'), st.get_double('weather-longitude'), city !== '');
        this._res.powerMax = Math.max(1, st.get_int('cpu-power-max'));
        this._res.showPower = st.get_boolean('show-power');
        if (this._open)
            this._refreshAll();
    }

    /* ---------------------------------------------- Modo sólido / vidro */

    _bmsPanelBlur() {
        const ext = Main.extensionManager.lookup(BMS_UUID);
        if (!ext || ext.state !== EXTENSION_ENABLED) {
            this._dropBmsSettings();
            return false;
        }
        if (!this._bmsPanel)
            this._loadBmsSettings(ext);
        return this._bmsPanel ? this._bmsPanel.get_boolean('blur') : true;
    }

    _loadBmsSettings(ext) {
        try {
            const dir = ext.dir.get_child('schemas');
            const source = dir.query_exists(null)
                ? Gio.SettingsSchemaSource.new_from_directory(
                    dir.get_path(), Gio.SettingsSchemaSource.get_default(), false)
                : Gio.SettingsSchemaSource.get_default();
            const open = id => {
                const schema = source?.lookup(id, true);
                return schema ? new Gio.Settings({settings_schema: schema}) : null;
            };
            this._bmsPanel = open(BMS_PANEL_SCHEMA);
            this._bmsGeneral = open(BMS_GENERAL_SCHEMA);
            this._bmsIds = [
                [this._bmsPanel, this._bmsPanel?.connect('changed', () => this._updateMode())],
                [this._bmsGeneral, this._bmsGeneral?.connect('changed', () => this._updateMode())],
            ];
        } catch (e) {
            console.warn(`[topbar-dashboard] configurações do Blur my Shell: ${e.message}`);
        }
    }

    _dropBmsSettings() {
        for (const [settings, id] of this._bmsIds ?? []) {
            if (settings && id)
                settings.disconnect(id);
        }
        this._bmsIds = [];
        this._bmsPanel = null;
        this._bmsGeneral = null;
    }

    // Lê raio e brilho do blur que o Blur my Shell usa na barra
    _readBmsLook() {
        const look = {...GLASS_BLUR, tint: GLASS_TINT};
        if (!GLASS_FROM_BMS)
            return look;

        const panel = this._bmsPanel;
        const general = this._bmsGeneral;
        const has = (settings, key) => settings?.settings_schema.has_key(key);
        let source = 'padrão de config.js';
        try {
            if (has(panel, 'pipeline') && has(general, 'pipelines')) {
                // Blur my Shell 60+: efeitos organizados em pipelines
                const id = panel.get_string('pipeline');
                const effects = general.get_value('pipelines').recursiveUnpack()?.[id]?.effects ?? [];
                for (const fx of effects) {
                    const p = fx?.params ?? {};
                    if (!/blur/i.test(fx?.type ?? ''))
                        continue;
                    if (typeof p.radius === 'number')
                        look.radius = p.radius;
                    if (typeof p.brightness === 'number')
                        look.brightness = p.brightness;
                    source = `Blur my Shell (pipeline ${id})`;
                }
            } else if (has(panel, 'sigma')) {
                // Versões antigas: sigma e brilho direto no schema
                const src = has(panel, 'customize') && !panel.get_boolean('customize') ? general : panel;
                if (has(src, 'sigma'))
                    look.radius = src.get_int('sigma');
                if (has(src, 'brightness'))
                    look.brightness = src.get_double('brightness');
                source = 'Blur my Shell';
            }
        } catch (e) {
            console.warn(`[topbar-dashboard] leitura do blur: ${e.message}`);
        }
        return look;
    }

    _updateMode() {
        this._glass = this._bmsPanelBlur();
        if (this._glass) {
            const look = this._readBmsLook();
            // O blur em si fica com brilho 1. O escurecimento vira uma camada preta
            // por cima (brilho 0.6 = preto com 40%), somada à GLASS_TINT. Assim o
            // formato do painel (cantos e curvas) é dado pela cor, não pelo retângulo do blur.
            this._blurLayers.forEach(l => applyBlur(l._blur, look.radius, 1));
            const dark = 1 - Math.min(1, Math.max(0, look.brightness));
            const [tr, tg, tb, ta] = look.tint ?? [0, 0, 0, 0];
            const alpha = 1 - (1 - dark) * (1 - ta);
            const k = alpha > 0 ? ta / alpha : 0;
            const [r, g, b] = [tr * k, tg * k, tb * k];
            this._earColor = [r, g, b, alpha];
            this._card.style = `background-color: rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha.toFixed(3)});`;
            Main.panel.remove_style_class_name('wdt-panel');
            this._card.add_style_class_name('glass');
        } else {
            this._earColor = [...BG_RGB, 1];
            this._card.style = null;
            Main.panel.add_style_class_name('wdt-panel');
            this._card.remove_style_class_name('glass');
        }
        this._blurLayers.forEach(l => (l.visible = this._glass));
        this._ears.forEach(e => e.queue_repaint());
    }

    // Área desfocada: o painel inteiro e os dois quadrados das curvas.
    // O que sobra fora do formato fica só levemente borrado (brilho 1), sem escurecer.
    _layoutBlur(height) {
        const R = EAR_RADIUS;
        const [card, earL, earR] = this._blurLayers;
        card.set_position(R, 0);
        card.set_size(CARD_WIDTH, height);
        earL.set_position(0, 0);
        earL.set_size(R, R);
        earR.set_position(R + CARD_WIDTH, 0);
        earR.set_size(R, R);
    }

    _build() {
        // Camada de tela cheia: captura clique fora e Esc
        this._overlay = new St.Widget({reactive: true, can_focus: true, visible: false});
        this._overlay.connect('button-press-event', (_a, event) => this._onPress(event));
        this._overlay.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this.close();
            return Clutter.EVENT_STOP;
        });

        // root recorta; slider desliza de baixo da barra
        this._root = new St.Widget({clip_to_allocation: true});
        this._slider = new St.Widget();
        this._root.add_child(this._slider);
        this._overlay.add_child(this._root);

        this._card = new St.BoxLayout({
            style_class: 'wdt-card', orientation: V, width: CARD_WIDTH, reactive: true,
        });
        const earColor = () => this._earColor;
        const left = makeEar('left', earColor);
        const right = makeEar('right', earColor);
        this._ears = [left, right];
        left.set_position(0, 0);
        this._card.set_position(EAR_RADIUS, 0);
        right.set_position(EAR_RADIUS + CARD_WIDTH, 0);

        this._blurLayers = [makeBlurLayer(), makeBlurLayer(), makeBlurLayer()];
        [...this._blurLayers, left, this._card, right].forEach(a => this._slider.add_child(a));

        this._card.add_child(this._buildTabs());
        this._stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(), height: PAGE_HEIGHT, x_expand: true,
        });
        this._card.add_child(this._stack);

        this._pages = [
            this._buildDashboardPage(),
            this._buildMediaPage(),
            this._buildPerformancePage(),
            this._buildWorkspacesPage(),
        ];
        this._pages.forEach(p => this._stack.add_child(p));
        this._select(0, false);

        // Fica abaixo da barra, para parecer que sai de dentro dela
        Main.layoutManager.addChrome(this._overlay);
        Main.layoutManager.uiGroup.set_child_below_sibling(this._overlay, Main.layoutManager.panelBox);
    }

    _buildTabs() {
        const wrap = new St.BoxLayout({style_class: 'wdt-tabs', orientation: V, x_expand: true});
        const row = new St.BoxLayout({x_expand: true});
        row.layout_manager.homogeneous = true;

        this._tabButtons = TABS.map((tab, i) => {
            const content = new St.BoxLayout({style_class: 'wdt-tab-content', orientation: V, x_align: CENTER});
            content.add_child(new St.Icon({icon_name: tab.icon, style_class: 'wdt-tab-icon', x_align: CENTER}));
            content.add_child(new St.Label({text: _(tab.name), style_class: 'wdt-tab-label', x_align: CENTER}));
            const button = new St.Button({style_class: 'wdt-tab', child: content, x_expand: true, can_focus: true});
            button.connect('clicked', () => this._select(i));
            row.add_child(button);
            return button;
        });

        const track = new St.Widget({style_class: 'wdt-tab-track', x_expand: true});
        this._indicator = new St.Widget({style_class: 'wdt-tab-indicator', width: INDICATOR_W});
        track.add_child(this._indicator);

        wrap.add_child(row);
        wrap.add_child(track);
        wrap.add_child(new St.Widget({style_class: 'wdt-separator', x_expand: true}));
        return wrap;
    }

    _buildDashboardPage() {
        const weather = new W.WeatherTile(this._weather);
        const sys = new W.SysInfoTile();
        const clock = new W.ClockTile();
        const calendar = new W.CalendarTile(this._eventSource);
        const res = new W.ResourcesTile(this._res);
        const media = new W.MediaTile(this._mpris);

        const row1 = new St.BoxLayout({style_class: 'wdt-row'});
        row1.add_child(weather.actor);
        row1.add_child(sys.actor);

        const row2 = new St.BoxLayout({style_class: 'wdt-row', y_expand: true});
        row2.add_child(clock.actor);
        row2.add_child(calendar.actor);
        row2.add_child(res.actor);

        const left = new St.BoxLayout({style_class: 'wdt-col', orientation: V, x_expand: true});
        left.add_child(row1);
        left.add_child(row2);

        const page = new St.BoxLayout({style_class: 'wdt-page', x_expand: true, y_expand: true});
        page.add_child(left);
        page.add_child(media.actor);

        this._refreshables.push(weather, sys, clock, calendar, res, media);
        this._ticking.push(sys, clock);
        return page;
    }

    _buildMediaPage() {
        const media = new W.MediaTile(this._mpris, {large: true});
        this._refreshables.push(media);
        return media.actor;
    }

    _buildPerformancePage() {
        const perf = new W.PerformancePage(this._res);
        this._refreshables.push(perf);
        return perf.actor;
    }

    _buildWorkspacesPage() {
        const ws = new W.WorkspacesPage(() => this.close());
        this._refreshables.push(ws);
        return ws.actor;
    }

    _select(index, animate = true) {
        this._current = index;
        this._tabButtons.forEach((b, i) => {
            if (i === index)
                b.add_style_class_name('active');
            else
                b.remove_style_class_name('active');
        });

        const tabW = (CARD_WIDTH - 2 * PAD_X) / TABS.length;
        const x = Math.round(index * tabW + (tabW - INDICATOR_W) / 2);
        if (animate)
            this._indicator.ease({translation_x: x, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        else
            this._indicator.translation_x = x;

        this._pages.forEach((p, i) => (p.visible = i === index));
        const page = this._pages[index];
        if (animate) {
            page.opacity = 0;
            page.ease({opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        if (this._open)
            this._refreshAll();
    }

    _refreshAll(list = this._refreshables) {
        for (const w of list) {
            try {
                w.refresh();
            } catch (e) {
                console.error(e);
            }
        }
    }

    _onPress(event) {
        const target = global.stage.get_event_actor(event);
        if (target && this._slider.contains(target))
            return Clutter.EVENT_PROPAGATE;
        this.close();
        return Clutter.EVENT_STOP;
    }

    toggle() {
        if (this._open)
            this.close();
        else
            this.open();
    }

    open() {
        if (this._open)
            return;
        this._open = true;

        const mon = Main.layoutManager.primaryMonitor;
        this._overlay.set_position(mon.x, mon.y);
        this._overlay.set_size(mon.width, mon.height);
        this._root.set_position(
            Math.round((mon.width - CARD_WIDTH - 2 * EAR_RADIUS) / 2),
            Main.layoutManager.panelBox.height);

        this._res.start();
        this._refreshAll();
        this._tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            this._refreshAll(this._ticking);
            return GLib.SOURCE_CONTINUE;
        });

        this._overlay.show();
        const [, height] = this._slider.get_preferred_height(-1);
        this._layoutBlur(height);
        this._slider.remove_all_transitions();
        this._slider.translation_y = -height;
        this._slider.ease({
            translation_y: 0,
            duration: 350,
            mode: Clutter.AnimationMode.EASE_OUT_EXPO,
        });

        this._grab = Main.pushModal(this._overlay, {actionMode: Shell.ActionMode.POPUP});
        global.stage.set_key_focus(this._overlay);
    }

    close() {
        if (!this._open)
            return;
        this._open = false;

        if (this._tick)
            GLib.source_remove(this._tick);
        this._tick = 0;
        this._res.stop();

        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }

        const [, height] = this._slider.get_preferred_height(-1);
        this._slider.ease({
            translation_y: -height,
            duration: 220,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (!this._open)
                    this._overlay.hide();
            },
        });
    }

    destroy() {
        this.close();
        Main.overview.disconnect(this._overviewId);
        this._settings.disconnect(this._settingsId);
        Main.extensionManager.disconnect(this._extStateId);
        this._dropBmsSettings();
        Main.panel.remove_style_class_name('wdt-panel');
        Main.layoutManager.removeChrome(this._overlay);
        this._overlay.destroy();
        this._weather.destroy();
        this._res.destroy();
        this._mpris.destroy();
        this._eventSource.destroy();
    }
}
