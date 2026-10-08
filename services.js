// SPDX-License-Identifier: GPL-2.0-or-later
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

const decoder = new TextDecoder();

// Leitura assíncrona: o shell não pode travar esperando o disco
async function readText(path) {
    const [bytes] = await Gio.File.new_for_path(path).load_contents_async(null);
    return decoder.decode(bytes);
}

const clamp = v => Math.min(1, Math.max(0, v));

/* ---------------------------------------------------------------- Clima */

function weatherInfo(code, isDay) {
    if (code === 0)
        return {label: _('Clear'), icon: isDay ? 'weather-clear-symbolic' : 'weather-clear-night-symbolic'};
    if (code <= 2)
        return {label: _('Partly cloudy'), icon: isDay ? 'weather-few-clouds-symbolic' : 'weather-few-clouds-night-symbolic'};
    if (code === 3)
        return {label: _('Cloudy'), icon: 'weather-overcast-symbolic'};
    if (code === 45 || code === 48)
        return {label: _('Fog'), icon: 'weather-fog-symbolic'};
    if (code >= 51 && code <= 57)
        return {label: _('Drizzle'), icon: 'weather-showers-scattered-symbolic'};
    if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82))
        return {label: _('Rain'), icon: 'weather-showers-symbolic'};
    if ((code >= 71 && code <= 77) || code === 85 || code === 86)
        return {label: _('Snow'), icon: 'weather-snow-symbolic'};
    if (code >= 95)
        return {label: _('Thunderstorm'), icon: 'weather-storm-symbolic'};
    return {label: '—', icon: 'weather-severe-alert-symbolic'};
}

export class WeatherService extends Signals.EventEmitter {
    constructor() {
        super();
        this.data = null;
        this.configured = false;
        this._url = null;
        this._session = new Soup.Session({timeout: 10});
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 900, () => {
            this._fetch();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Sem cidade configurada, nenhuma requisição é feita
    setLocation(lat, lon, configured) {
        this.configured = configured;
        this.data = null;
        this._url = configured
            ? 'https://api.open-meteo.com/v1/forecast' +
              `?latitude=${lat}&longitude=${lon}` +
              '&current=temperature_2m,weather_code,is_day&timezone=auto'
            : null;
        this.emit('changed');
        this._fetch();
    }

    async _fetch() {
        const url = this._url;
        if (!url)
            return;
        try {
            const msg = Soup.Message.new('GET', url);
            const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
            if (msg.get_status() !== Soup.Status.OK || url !== this._url)
                return;
            const {current} = JSON.parse(decoder.decode(bytes.get_data()));
            this.data = {
                temp: Math.round(current.temperature_2m),
                ...weatherInfo(current.weather_code, current.is_day),
            };
            this.emit('changed');
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`[topbar-dashboard] clima: ${e.message}`);
        }
    }

    destroy() {
        GLib.source_remove(this._timer);
        this._session.abort();
    }
}

/* ----------------------------------------------------------- Recursos */

// Sensor de energia do processador (RAPL). No AMD o kernel também usa o nome intel-rapl.
async function findRaplPackage() {
    const base = '/sys/class/powercap';
    try {
        const en = await Gio.File.new_for_path(base).enumerate_children_async(
            'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
        let infos;
        while ((infos = await en.next_files_async(16, GLib.PRIORITY_DEFAULT, null)).length) {
            for (const info of infos) {
                const path = `${base}/${info.get_name()}`;
                try {
                    if ((await readText(`${path}/name`)).trim() === 'package-0')
                        return path;
                } catch {}
            }
        }
    } catch {}
    return null;
}

export class ResourcesService extends Signals.EventEmitter {
    constructor() {
        super();
        this.data = null;
        this._prev = null;
        this._timer = 0;
        this._power = null;
        this._energyPrev = null;
        this.powerMax = 88;
        this.showPower = false;
        this._rapl = null;
        this._raplMax = 0;
        this._polling = false;
        this._initRapl();
        this._poll();
    }

    async _initRapl() {
        const rapl = await findRaplPackage();
        if (!rapl || this._destroyed)
            return;
        try {
            this._raplMax = Number((await readText(`${rapl}/max_energy_range_uj`)).trim());
        } catch {}
        this._rapl = rapl;
    }

    start() {
        if (this._timer)
            return;
        this._energyPrev = null;
        this._poll();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }

    // Watts = variação de energia (µJ) / variação de tempo (µs)
    async _readPower() {
        if (!this.showPower || !this._rapl) {
            this._power = null;
            this._energyPrev = null;
            return;
        }
        try {
            const e = Number((await readText(`${this._rapl}/energy_uj`)).trim());
            const t = GLib.get_monotonic_time();
            if (this._energyPrev) {
                let de = e - this._energyPrev.e;
                if (de < 0)
                    de += this._raplMax;
                const dt = t - this._energyPrev.t;
                if (dt > 0)
                    this._power = de / dt;
            }
            this._energyPrev = {e, t};
        } catch {
            // Sem permissão de leitura: o consumo simplesmente não aparece
            this._rapl = null;
        }
    }

    async _poll() {
        // Evita leituras sobrepostas se o disco demorar mais que o intervalo
        if (this._polling)
            return;
        this._polling = true;
        try {
            await this._readPower();
            // CPU: diferença entre duas leituras de /proc/stat
            const stat = (await readText('/proc/stat')).split('\n');
            const n = stat[0].trim().split(/\s+/).slice(1).map(Number);
            const idle = n[3] + (n[4] ?? 0);
            const total = n.slice(0, 8).reduce((a, b) => a + b, 0);
            let cpu = 0;
            if (this._prev) {
                const dt = total - this._prev.total;
                cpu = dt > 0 ? 1 - (idle - this._prev.idle) / dt : 0;
            }
            this._prev = {total, idle};
            const cores = stat.filter(l => /^cpu\d+/.test(l)).length;

            // Memória (kB → bytes)
            const mem = {};
            for (const line of (await readText('/proc/meminfo')).split('\n')) {
                const m = line.match(/^(\w+):\s+(\d+)/);
                if (m)
                    mem[m[1]] = Number(m[2]) * 1024;
            }
            const memUsed = mem.MemTotal - mem.MemAvailable;
            const swapUsed = mem.SwapTotal - mem.SwapFree;

            // Disco da raiz
            const fs = Gio.File.new_for_path('/')
                .query_filesystem_info('filesystem::size,filesystem::free', null);
            const diskTotal = fs.get_attribute_uint64('filesystem::size');
            const diskUsed = diskTotal - fs.get_attribute_uint64('filesystem::free');

            this.data = {
                cpu: clamp(cpu), cores,
                mem: clamp(memUsed / mem.MemTotal), memUsed, memTotal: mem.MemTotal,
                swap: mem.SwapTotal ? clamp(swapUsed / mem.SwapTotal) : 0,
                swapUsed, swapTotal: mem.SwapTotal,
                disk: diskTotal ? clamp(diskUsed / diskTotal) : 0, diskUsed, diskTotal,
                watts: this._power,
                power: this._power === null ? 0 : clamp(this._power / this.powerMax),
            };
            if (!this._destroyed)
                this.emit('changed');
        } catch (e) {
            console.error(e);
        } finally {
            this._polling = false;
        }
    }

    destroy() {
        this._destroyed = true;
        this.stop();
    }
}

/* ------------------------------------------------------ Info do sistema */

let sysStatic = null;

function canRead(path) {
    try {
        return Gio.File.new_for_path(path)
            .query_info('access::can-read', Gio.FileQueryInfoFlags.NONE, null)
            .get_attribute_boolean('access::can-read');
    } catch {
        return false;
    }
}

function formatUptime(s) {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const parts = [];
    if (d)
        parts.push(`${d} d`);
    if (h)
        parts.push(`${h} h`);
    parts.push(`${m} min`);
    // TRANSLATORS: %s is a duration such as "2 d 5 h 30 min"
    return _('up %s').format(parts.join(' '));
}

export async function getSysInfo() {
    if (!sysStatic) {
        let os = 'Linux';
        try {
            const m = (await readText('/etc/os-release')).match(/^PRETTY_NAME="?([^"\n]+)"?/m);
            if (m)
                os = m[1];
        } catch {}

        let avatar = null;
        const candidates = [
            GLib.build_filenamev([GLib.get_home_dir(), '.face']),
            `/var/lib/AccountsService/icons/${GLib.get_user_name()}`,
        ];
        for (const p of candidates) {
            if (canRead(p)) {
                avatar = GLib.filename_to_uri(p, null);
                break;
            }
        }
        sysStatic = {os, shell: `GNOME ${Config.PACKAGE_VERSION}`, avatar};
    }

    let uptime = '';
    try {
        uptime = formatUptime(Math.floor(parseFloat(await readText('/proc/uptime'))));
    } catch {}
    return {...sysStatic, uptime};
}

/* ---------------------------------------------------------------- MPRIS */

const PlayerIface = `<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
  </interface>
</node>`;
const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PlayerIface);
const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';

function makePlayer(name) {
    return new Promise((resolve, reject) => {
        // eslint-disable-next-line no-new
        new PlayerProxy(Gio.DBus.session, name, '/org/mpris/MediaPlayer2',
            (proxy, error) => (error ? reject(error) : resolve(proxy)));
    });
}

const unpack = v => (v instanceof GLib.Variant ? v.deepUnpack() : v);

export class MprisService extends Signals.EventEmitter {
    constructor() {
        super();
        this._players = new Map();
        this._session = new Soup.Session({timeout: 10});
        this._subId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _sig, params) => {
                const [name] = params.deepUnpack();
                if (name.startsWith(MPRIS_PREFIX))
                    this._scan();
            });
        this._scan();
    }

    async _scan() {
        try {
            const reply = await Gio.DBus.session.call(
                'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                'ListNames', null, new GLib.VariantType('(as)'),
                Gio.DBusCallFlags.NONE, -1, null);
            if (this._destroyed)
                return;
            const names = reply.deepUnpack()[0].filter(n => n.startsWith(MPRIS_PREFIX));

            for (const [name, proxy] of this._players) {
                if (!names.includes(name)) {
                    proxy.disconnect(proxy._wdtId);
                    this._players.delete(name);
                }
            }

            for (const name of names) {
                if (this._players.has(name))
                    continue;
                try {
                    const proxy = await makePlayer(name);
                    if (this._destroyed || this._players.has(name))
                        continue;
                    proxy._wdtId = proxy.connect('g-properties-changed', () => this.emit('changed'));
                    this._players.set(name, proxy);
                } catch (e) {
                    console.warn(`[topbar-dashboard] player ${name}: ${e.message}`);
                }
            }
            this.emit('changed');
        } catch (e) {
            console.error(e);
        }
    }

    get player() {
        const list = [...this._players.values()];
        return list.find(p => p.PlaybackStatus === 'Playing') ?? list[0] ?? null;
    }

    get state() {
        const p = this.player;
        if (!p)
            return null;
        const meta = p.Metadata ?? {};
        const get = k => unpack(meta[k]);
        const artist = get('xesam:artist');
        return {
            title: get('xesam:title') ?? '',
            artist: Array.isArray(artist) ? artist.join(', ') : (artist ?? ''),
            album: get('xesam:album') ?? '',
            artUrl: get('mpris:artUrl') ?? '',
            playing: p.PlaybackStatus === 'Playing',
        };
    }

    _call(method) {
        this.player?.[`${method}Remote`](() => {});
    }

    playPause() {
        this._call('PlayPause');
    }

    next() {
        this._call('Next');
    }

    previous() {
        this._call('Previous');
    }

    // Capas em http(s) são baixadas para o cache; file:// é usado direto
    async resolveArt(url) {
        if (!url)
            return null;
        if (url.startsWith('file://'))
            return url;
        if (!/^https?:\/\//.test(url))
            return null;

        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'topbar-dashboard']);
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, url, -1);
        const path = GLib.build_filenamev([dir, hash]);
        const uri = GLib.filename_to_uri(path, null);
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return uri;

        try {
            const msg = Soup.Message.new('GET', url);
            if (!msg)
                return null;
            const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
            if (msg.get_status() !== Soup.Status.OK)
                return null;
            GLib.mkdir_with_parents(dir, 0o755);
            GLib.file_set_contents(path, bytes.get_data());
            return uri;
        } catch {
            return null;
        }
    }

    destroy() {
        this._destroyed = true;
        Gio.DBus.session.signal_unsubscribe(this._subId);
        for (const proxy of this._players.values())
            proxy.disconnect(proxy._wdtId);
        this._players.clear();
        this._session.abort();
    }
}
