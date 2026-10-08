// SPDX-License-Identifier: GPL-2.0-or-later
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {getSysInfo} from './services.js';

const V = Clutter.Orientation.VERTICAL;
const H = Clutter.Orientation.HORIZONTAL;
const CENTER = Clutter.ActorAlign.CENTER;
const START = Clutter.ActorAlign.START;
const END = Clutter.ActorAlign.END;

// Nomes de dias e meses vêm do idioma do sistema
function weekdayNames() {
    const monday = GLib.DateTime.new_local(2024, 1, 1, 12, 0, 0); // 01/01/2024 foi segunda
    return [...Array(7)].map((_x, i) => monday.add_days(i).format('%a'));
}

const capitalize = t => (t ? t[0].toUpperCase() + t.slice(1) : t);

function monthTitle(year, month) {
    const dt = GLib.DateTime.new_local(year, month + 1, 1, 12, 0, 0);
    return capitalize(dt.format('%OB %Y') ?? dt.format('%B %Y'));
}

function shortDate(d) {
    return GLib.DateTime.new_local(d.getFullYear(), d.getMonth() + 1, d.getDate(), 12, 0, 0).format('%e %b').trim();
}

function box(style, orientation = H, props = {}) {
    return new St.BoxLayout({style_class: style, orientation, ...props});
}

function label(text, style, props = {}) {
    const l = new St.Label({text, style_class: style, ...props});
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

// Conecta num serviço e desconecta sozinho quando o widget morre
function bind(actor, emitter, signal, fn) {
    const id = emitter.connect(signal, fn);
    actor.connect('destroy', () => emitter.disconnect(id));
}

/* ---------------------------------------------------------------- Clima */

export class WeatherTile {
    constructor(weather) {
        this._weather = weather;
        this.actor = box('wdt-tile wdt-weather', H, {width: 230});
        this._icon = new St.Icon({
            icon_name: 'weather-clear-symbolic', style_class: 'wdt-weather-icon', y_align: CENTER,
        });
        const col = box('wdt-weather-text', V, {x_expand: true, y_align: CENTER});
        this._temp = label('--°C', 'wdt-weather-temp', {x_align: CENTER});
        this._desc = label(_('Loading weather'), 'wdt-muted', {x_align: CENTER});
        col.add_child(this._temp);
        col.add_child(this._desc);
        this.actor.add_child(this._icon);
        this.actor.add_child(col);
        bind(this.actor, weather, 'changed', () => this.refresh());
        this.refresh();
    }

    refresh() {
        const d = this._weather.data;
        if (!this._weather.configured) {
            this._icon.icon_name = 'mark-location-symbolic';
            this._temp.text = '--°C';
            this._desc.text = _('Set a city in preferences');
            return;
        }
        if (!d) {
            this._desc.text = _('Loading weather');
            return;
        }
        this._icon.icon_name = d.icon;
        this._temp.text = `${d.temp}°C`;
        this._desc.text = d.label;
    }
}

/* ------------------------------------------------------ Info do sistema */

export class SysInfoTile {
    constructor() {
        this.actor = box('wdt-tile wdt-sysinfo', H, {x_expand: true});

        this._avatar = new St.Widget({
            style_class: 'wdt-avatar', y_align: CENTER, layout_manager: new Clutter.BinLayout(),
        });
        this._avatarIcon = new St.Icon({
            icon_name: 'avatar-default-symbolic', icon_size: 36,
            x_align: CENTER, y_align: CENTER, x_expand: true, y_expand: true,
        });
        this._avatar.add_child(this._avatarIcon);

        const col = box('wdt-info-col', V, {x_expand: true, y_align: CENTER});
        this._rows = {};
        for (const [key, icon] of [
            ['os', 'computer-symbolic'],
            ['shell', 'video-display-symbolic'],
            ['uptime', 'preferences-system-time-symbolic'],
        ]) {
            const row = box('wdt-info-row', H);
            row.add_child(new St.Icon({icon_name: icon, style_class: 'wdt-info-icon', y_align: CENTER}));
            const l = label('', 'wdt-info-text', {y_align: CENTER});
            row.add_child(l);
            col.add_child(row);
            this._rows[key] = l;
        }

        this.actor.add_child(this._avatar);
        this.actor.add_child(col);
        this.actor.connect('destroy', () => (this._destroyed = true));
        this.refresh();
    }

    async refresh() {
        const info = await getSysInfo();
        if (this._destroyed)
            return;
        this._rows.os.text = info.os;
        this._rows.shell.text = info.shell;
        this._rows.uptime.text = info.uptime;
        if (info.avatar) {
            this._avatar.style = `background-image: url("${info.avatar}");`;
            this._avatarIcon.hide();
        }
    }
}

/* ---------------------------------------------------------------- Relógio */

export class ClockTile {
    constructor() {
        this.actor = box('wdt-tile wdt-clock', V, {width: 96});
        const inner = box('wdt-clock-inner', V, {y_expand: true, y_align: CENTER, x_align: CENTER});
        this._hour = label('', 'wdt-clock-num', {x_align: CENTER});
        const dots = label('•••', 'wdt-clock-dots', {x_align: CENTER});
        this._min = label('', 'wdt-clock-num', {x_align: CENTER});
        this._date = label('', 'wdt-clock-date', {x_align: CENTER});
        [this._hour, dots, this._min, this._date].forEach(a => inner.add_child(a));
        this.actor.add_child(inner);
        this.refresh();
    }

    refresh() {
        const now = GLib.DateTime.new_now_local();
        this._hour.text = now.format('%H');
        this._min.text = now.format('%M');
        this._date.text = `${weekdayNames()[now.get_day_of_week() - 1]}, ${now.get_day_of_month()}`;
    }
}

/* ------------------------------------------------------------ Calendário */

const sameDay = (a, b) => a.toDateString() === b.toDateString();
const pad = n => String(n).padStart(2, '0');
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayRange = d => {
    const begin = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const end = new Date(begin);
    end.setDate(end.getDate() + 1);
    return [begin, end];
};

// Visual próprio, eventos da mesma fonte do calendário do GNOME
export class CalendarTile {
    constructor(eventSource) {
        this._source = eventSource;
        this._today = null;

        this.actor = box('wdt-tile wdt-calendar', V, {x_expand: true});

        const header = box('wdt-cal-header', H, {x_expand: true});
        const nav = (icon, delta) => {
            const b = new St.Button({
                style_class: 'wdt-cal-nav', can_focus: true,
                child: new St.Icon({icon_name: icon, icon_size: 14}),
            });
            b.connect('clicked', () => this._shiftMonth(delta));
            return b;
        };
        this._title = label('', 'wdt-cal-title', {x_expand: true, x_align: CENTER, y_align: CENTER});
        header.add_child(nav('go-previous-symbolic', -1));
        header.add_child(this._title);
        header.add_child(nav('go-next-symbolic', 1));

        this._layout = new Clutter.GridLayout({column_homogeneous: true, row_homogeneous: true});
        this._grid = new St.Widget({layout_manager: this._layout, x_expand: true, y_expand: true});
        this._eventLine = box('wdt-cal-event', H, {x_expand: true});

        [header, this._grid, this._eventLine].forEach(a => this.actor.add_child(a));

        bind(this.actor, eventSource, 'changed', () => this._render());
        this.refresh();
    }

    refresh() {
        const now = new Date();
        if (this._today !== now.toDateString()) {
            this._today = now.toDateString();
            this._selected = now;
            this._month = new Date(now.getFullYear(), now.getMonth(), 1);
        }
        this._render();
    }

    _shiftMonth(delta) {
        this._month = new Date(this._month.getFullYear(), this._month.getMonth() + delta, 1);
        this._render();
    }

    _select(d) {
        this._selected = d;
        if (d.getMonth() !== this._month.getMonth())
            this._month = new Date(d.getFullYear(), d.getMonth(), 1);
        this._render();
    }

    _hasEvents(d) {
        try {
            if (this._source.hasEvents)
                return this._source.hasEvents(d);
            return this._source.getEvents(...dayRange(d)).length > 0;
        } catch {
            return false;
        }
    }

    _render() {
        const m = this._month;
        this._title.text = monthTitle(m.getFullYear(), m.getMonth());

        // 6 semanas começando na segunda
        const start = new Date(m.getFullYear(), m.getMonth(), 1 - ((m.getDay() + 6) % 7));
        const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 42);
        try {
            this._source.requestRange(start, end);
        } catch {}

        this._grid.destroy_all_children();
        weekdayNames().forEach((d, i) => {
            this._layout.attach(label(d, 'wdt-cal-head', {x_align: CENTER, y_align: CENTER}), i, 0, 1, 1);
        });

        const today = new Date();
        for (let i = 0; i < 42; i++) {
            const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
            const classes = ['wdt-cal-day'];
            if (d.getMonth() !== m.getMonth())
                classes.push('other');
            if (sameDay(d, today))
                classes.push('today');
            else if (sameDay(d, this._selected))
                classes.push('selected');

            // Número em cima, espaço fixo da bolinha embaixo (sempre presente, para não desalinhar)
            const inner = new St.BoxLayout({
                style_class: 'wdt-cal-inner', orientation: V, width: 28, height: 28,
            });
            inner.add_child(new St.Label({
                text: String(d.getDate()), x_align: CENTER, y_align: CENTER, y_expand: true,
            }));
            inner.add_child(new St.Widget({
                style_class: this._hasEvents(d) ? 'wdt-cal-dot' : 'wdt-cal-dot-slot', x_align: CENTER,
            }));

            const cell = new St.Button({
                style_class: classes.join(' '), child: inner,
                x_align: CENTER, y_align: CENTER, can_focus: true,
            });
            cell.connect('clicked', () => this._select(d));
            this._layout.attach(cell, i % 7, 1 + Math.floor(i / 7), 1, 1);
        }
        this._renderEvents();
    }

    _renderEvents() {
        this._eventLine.destroy_all_children();
        const d = this._selected;
        const isToday = sameDay(d, new Date());

        let events = [];
        try {
            events = this._source.getEvents(...dayRange(d));
        } catch (e) {
            console.error(e);
        }

        if (!events.length) {
            const text = isToday
                ? _('No events today')
                // TRANSLATORS: %s is a short date such as "28 Sep"
                : _('No events on %s').format(shortDate(d));
            this._eventLine.add_child(label(text, 'wdt-muted wdt-cal-event-empty'));
            return;
        }

        const ev = events[0];
        const time = ev.allDay ? _('All day') : hm(ev.date);
        const date = isToday ? '' : `${shortDate(d)} `;
        this._eventLine.add_child(new St.Widget({style_class: 'wdt-event-mark'}));
        this._eventLine.add_child(label(`${date}${time}`, 'wdt-cal-event-time', {y_align: CENTER}));
        this._eventLine.add_child(label(ev.summary || _('Untitled'), 'wdt-cal-event-summary', {x_expand: true, y_align: CENTER}));
        if (events.length > 1)
            this._eventLine.add_child(label(`+${events.length - 1}`, 'wdt-cal-event-more', {y_align: CENTER}));
    }
}

/* ------------------------------------------------ Barras de recursos */

const BAR_H = 165;
const BAR_W = 10;
const BAR_MIN = 6;

export class ResourcesTile {
    constructor(res) {
        this._res = res;
        this.actor = box('wdt-tile wdt-resources', V, {width: 116});
        this._power = label('— W', 'wdt-power', {x_align: CENTER});
        this._powerRow = box('wdt-power-row', H, {x_align: CENTER});
        this._powerRow.add_child(new St.Icon({icon_name: 'battery-level-100-charged-symbolic', style_class: 'wdt-power-icon', y_align: CENTER}));
        this._powerRow.add_child(this._power);
        this.actor.add_child(this._powerRow);
        const bars = box('wdt-bars', H, {x_expand: true, y_expand: true});
        this.actor.add_child(bars);
        this._fills = {};
        for (const [key, name] of [['cpu', 'CPU'], ['mem', 'RAM'], ['disk', 'SSD']]) {
            const col = box('wdt-bar-col', V, {x_expand: true, y_align: CENTER});
            // Sem layout manager: posição e tamanho do preenchimento são explícitos
            const track = new St.Widget({
                style_class: 'wdt-bar-track', width: BAR_W, height: BAR_H, x_align: CENTER,
            });
            const fill = new St.Widget({
                style_class: `wdt-bar-fill ${key}`,
                width: BAR_W, height: BAR_MIN, x: 0, y: BAR_H - BAR_MIN,
            });
            track.add_child(fill);
            col.add_child(track);
            col.add_child(label(name, 'wdt-bar-label', {x_align: CENTER}));
            bars.add_child(col);
            this._fills[key] = fill;
        }
        bind(this.actor, res, 'changed', () => this.refresh());
        this.refresh();
    }

    refresh() {
        const d = this._res.data;
        if (!d)
            return;
        this._powerRow.visible = this._res.showPower && d.watts !== null;
        if (d.watts !== null)
            this._power.text = `${Math.round(d.watts)} W`;
        for (const [key, fill] of Object.entries(this._fills)) {
            const h = Math.max(BAR_MIN, Math.round(d[key] * BAR_H));
            fill.ease({
                height: h,
                y: BAR_H - h,
                duration: 500,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }
}

/* ---------------------------------------------------------------- Mídia */

export class MediaTile {
    constructor(mpris, {large = false} = {}) {
        this._mpris = mpris;
        this._artUrl = null;
        const artSize = large ? 200 : 110;
        const align = large ? START : CENTER;

        const props = large ? {x_expand: true, y_expand: true} : {width: 200, y_expand: true};
        this.actor = box(`wdt-tile wdt-media${large ? ' large' : ''}`, V, props);
        this.actor.connect('destroy', () => (this._destroyed = true));

        const inner = box('wdt-media-inner', large ? H : V, {x_expand: true, y_expand: true, y_align: CENTER});

        this._art = new St.Widget({
            style_class: 'wdt-media-art', width: artSize, height: artSize,
            x_align: CENTER, y_align: CENTER, layout_manager: new Clutter.BinLayout(),
        });
        this._artIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic', icon_size: large ? 64 : 40,
            style_class: 'wdt-media-art-icon',
            x_align: CENTER, y_align: CENTER, x_expand: true, y_expand: true,
        });
        this._art.add_child(this._artIcon);

        const info = box('wdt-media-info', V, {x_expand: true, y_align: CENTER});
        this._title = label(_('Nothing playing'), 'wdt-media-title', {x_align: align});
        this._artist = label(_('Open a music player'), 'wdt-muted', {x_align: align});
        this._album = label('', 'wdt-media-album', {x_align: align});

        const controls = box('wdt-media-controls', H, {x_align: align});
        const iconSize = large ? 22 : 16;
        const btn = (icon, cb, extra = '') => {
            const b = new St.Button({
                style_class: `wdt-media-btn ${extra}`, can_focus: true,
                child: new St.Icon({icon_name: icon, icon_size: iconSize}),
            });
            b.connect('clicked', cb);
            return b;
        };
        this._play = btn('media-playback-start-symbolic', () => mpris.playPause(), 'main');
        controls.add_child(btn('media-skip-backward-symbolic', () => mpris.previous()));
        controls.add_child(this._play);
        controls.add_child(btn('media-skip-forward-symbolic', () => mpris.next()));

        [this._title, this._artist, this._album, controls].forEach(a => info.add_child(a));
        inner.add_child(this._art);
        inner.add_child(info);
        this.actor.add_child(inner);

        bind(this.actor, mpris, 'changed', () => this.refresh());
        this.refresh();
    }

    refresh() {
        const s = this._mpris.state;
        if (!s) {
            this._title.text = _('Nothing playing');
            this._artist.text = _('Open a music player');
            this._album.text = '';
            this._play.child.icon_name = 'media-playback-start-symbolic';
            this._setArt('');
            return;
        }
        this._title.text = s.title || _('Untitled');
        this._artist.text = s.artist;
        this._album.text = s.album;
        this._play.child.icon_name = s.playing
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._setArt(s.artUrl);
    }

    async _setArt(url) {
        if (url === this._artUrl)
            return;
        this._artUrl = url;
        const uri = await this._mpris.resolveArt(url);
        if (this._destroyed || url !== this._artUrl)
            return;
        if (uri) {
            this._art.style = `background-image: url("${uri}");`;
            this._artIcon.hide();
        } else {
            this._art.style = null;
            this._artIcon.show();
        }
    }
}

/* ------------------------------------------------------------ Desempenho */

const TRACK_W = 460;

export class PerformancePage {
    constructor(res) {
        this._res = res;
        this.actor = box('wdt-perf', V, {x_expand: true, y_expand: true});
        this._rows = {};
        for (const [key, name] of [
            ['cpu', _('Processor')], ['power', _('Power')], ['mem', _('Memory')], ['swap', _('Swap')], ['disk', _('Disk /')],
        ]) {
            const row = box('wdt-tile wdt-perf-row', H, {x_expand: true, y_expand: true});
            const track = new St.Widget({
                style_class: 'wdt-hbar-track', width: TRACK_W, height: 12, y_align: CENTER,
            });
            const fill = new St.Widget({
                style_class: `wdt-hbar-fill ${key}`, width: 8, height: 12, x: 0, y: 0,
            });
            track.add_child(fill);
            const pct = label('--%', 'wdt-perf-pct', {y_align: CENTER, width: 56});
            const detail = label('', 'wdt-muted', {y_align: CENTER, x_expand: true, x_align: END});
            row.add_child(label(name, 'wdt-perf-name', {y_align: CENTER, width: 110}));
            row.add_child(track);
            row.add_child(pct);
            row.add_child(detail);
            this.actor.add_child(row);
            this._rows[key] = {row, fill, pct, detail};
        }
        bind(this.actor, res, 'changed', () => this.refresh());
        this.refresh();
    }

    refresh() {
        const d = this._res.data;
        if (!d)
            return;
        const size = n => GLib.format_size(n);
        const details = {
            cpu: ngettext('%d core', '%d cores', d.cores).format(d.cores),
            // TRANSLATORS: "4.1 GB of 32 GB"
            mem: _('%s of %s').format(size(d.memUsed), size(d.memTotal)),
            swap: d.swapTotal ? _('%s of %s').format(size(d.swapUsed), size(d.swapTotal)) : _('No swap'),
            disk: _('%s of %s').format(size(d.diskUsed), size(d.diskTotal)),
            power: d.watts === null ? _('Sensor not readable') : _('Processor package'),
        };
        this._rows.power.row.visible = this._res.showPower;
        for (const [key, row] of Object.entries(this._rows)) {
            row.fill.ease({
                width: Math.max(8, Math.round(d[key] * TRACK_W)),
                duration: 500,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            if (key === 'power')
                row.pct.text = d.watts === null ? '—' : `${Math.round(d.watts)} W`;
            else
                row.pct.text = `${Math.round(d[key] * 100)}%`;
            row.detail.text = details[key];
        }
    }
}

/* ------------------------------------------------------------ Workspaces */

export class WorkspacesPage {
    constructor(onActivate) {
        this._onActivate = onActivate;
        this._layout = new Clutter.GridLayout({
            column_homogeneous: true, column_spacing: 10, row_spacing: 10,
        });
        this.actor = new St.Widget({layout_manager: this._layout, x_expand: true, y_expand: true});
    }

    refresh() {
        this.actor.destroy_all_children();
        const wm = global.workspace_manager;
        const active = wm.get_active_workspace_index();
        const tracker = Shell.WindowTracker.get_default();

        for (let i = 0; i < wm.n_workspaces; i++) {
            const ws = wm.get_workspace_by_index(i);
            const windows = ws.list_windows().filter(w => !w.skip_taskbar);

            const content = box('wdt-ws-content', V, {x_expand: true});
            const header = box('wdt-ws-header', H, {x_expand: true});
            header.add_child(label(_('Workspace %d').format(i + 1), 'wdt-ws-name', {x_expand: true}));
            const count = windows.length;
            header.add_child(label(ngettext('%d window', '%d windows', count).format(count), 'wdt-muted'));
            content.add_child(header);

            const icons = box('wdt-ws-icons', H);
            const seen = new Set();
            for (const w of windows) {
                const app = tracker.get_window_app(w);
                if (!app || seen.has(app) || seen.size >= 8)
                    continue;
                seen.add(app);
                icons.add_child(app.create_icon_texture(28));
            }
            if (!seen.size)
                icons.add_child(label(_('Empty'), 'wdt-muted'));
            content.add_child(icons);

            const button = new St.Button({
                style_class: `wdt-tile wdt-ws${i === active ? ' active' : ''}`,
                child: content, x_expand: true, can_focus: true,
            });
            button.connect('clicked', () => {
                ws.activate(global.get_current_time());
                this._onActivate();
            });
            this._layout.attach(button, i % 4, Math.floor(i / 4), 1, 1);
        }
    }
}
