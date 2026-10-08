// SPDX-License-Identifier: GPL-2.0-or-later
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {
    ExtensionPreferences, gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const GEOCODING = 'https://geocoding-api.open-meteo.com/v1/search';
const POWERCAP = '/sys/class/powercap';
const UDEV_RULE = '/etc/udev/rules.d/99-rapl-energy.rules';

function readText(path) {
    const [, bytes] = GLib.file_get_contents(path);
    return new TextDecoder().decode(bytes);
}

// Procura o sensor de energia do processador e diz se dá para ler sem root
function probeSensor() {
    try {
        const en = Gio.File.new_for_path(POWERCAP)
            .enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null))) {
            const dir = `${POWERCAP}/${info.get_name()}`;
            try {
                if (readText(`${dir}/name`).trim() !== 'package-0')
                    continue;
            } catch {
                continue;
            }
            const file = `${dir}/energy_uj`;
            const readable = Gio.File.new_for_path(file)
                .query_info('access::can-read', Gio.FileQueryInfoFlags.NONE, null)
                .get_attribute_boolean('access::can-read');
            return {file, readable};
        }
    } catch {}
    return null;
}

export default class TopbarDashboardPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const session = new Soup.Session({timeout: 10});
        window.connect('close-request', () => session.abort());

        const page = new Adw.PreferencesPage();
        window.add(page);
        this._buildWeather(page, settings, session);
        this._buildPower(page, settings, window);
    }

    /* ------------------------------------------------------------- Clima */

    _buildWeather(page, settings, session) {
        const weather = new Adw.PreferencesGroup({
            title: _('Weather'),
            description: _('Data from Open-Meteo. Your coordinates are only sent after you pick a city.'),
        });
        page.add(weather);

        const current = new Adw.ActionRow({title: _('Current city')});
        const clear = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: _('Remove city and turn weather off'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        clear.connect('clicked', () => settings.set_string('weather-city', ''));
        current.add_suffix(clear);
        weather.add(current);

        const showCurrent = () => {
            const city = settings.get_string('weather-city');
            current.subtitle = city || _('None (weather off)');
            clear.visible = city !== '';
        };
        settings.connect('changed::weather-city', showCurrent);
        showCurrent();

        const search = new Adw.EntryRow({title: _('Search city'), show_apply_button: true});
        weather.add(search);

        const results = new Adw.PreferencesGroup();
        page.add(results);
        let rows = [];

        const clearResults = () => {
            rows.forEach(r => results.remove(r));
            rows = [];
        };
        const showMessage = text => {
            clearResults();
            const row = new Adw.ActionRow({title: text});
            results.add(row);
            rows.push(row);
        };

        const runSearch = async () => {
            const name = search.text.trim();
            if (name.length < 2)
                return;
            showMessage(_('Searching…'));
            try {
                const lang = GLib.get_language_names()[0].split(/[_.@]/)[0] || 'en';
                const url = `${GEOCODING}?name=${encodeURIComponent(name)}&count=8&language=${lang}&format=json`;
                const msg = Soup.Message.new('GET', url);
                const bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
                if (msg.get_status() !== Soup.Status.OK)
                    throw new Error(`HTTP ${msg.get_status()}`);
                const list = JSON.parse(new TextDecoder().decode(bytes.get_data())).results ?? [];
                if (!list.length) {
                    showMessage(_('No city found'));
                    return;
                }
                clearResults();
                for (const place of list) {
                    const detail = [place.admin1, place.country].filter(Boolean).join(', ');
                    const row = new Adw.ActionRow({title: place.name, subtitle: detail, activatable: true});
                    row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
                    row.connect('activated', () => {
                        settings.set_double('weather-latitude', place.latitude);
                        settings.set_double('weather-longitude', place.longitude);
                        settings.set_string('weather-city', detail ? `${place.name}, ${detail}` : place.name);
                        search.text = '';
                        clearResults();
                    });
                    results.add(row);
                    rows.push(row);
                }
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    showMessage(_('Search failed: %s').format(e.message));
            }
        };
        search.connect('apply', () => runSearch());
        search.connect('entry-activated', () => runSearch());
    }

    /* ----------------------------------------------------------- Consumo */

    _buildPower(page, settings, window) {
        const group = new Adw.PreferencesGroup({
            title: _('Processor power'),
            description: _('Shows how many watts the processor is drawing, read from its energy sensor (RAPL).'),
        });
        page.add(group);

        const toggle = new Adw.SwitchRow({title: _('Show power draw')});
        settings.bind('show-power', toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(toggle);

        // Estado do sensor
        const status = new Adw.ActionRow({title: _('Sensor')});
        const recheck = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: _('Check again'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        status.add_suffix(recheck);
        group.add(status);

        const max = new Adw.SpinRow({
            title: _('Maximum power (W)'),
            subtitle: _('Full scale of the power bar on the Performance tab. Use your processor limit: PPT on AMD, Maximum Turbo Power on Intel.'),
            adjustment: new Gtk.Adjustment({lower: 5, upper: 500, step_increment: 1, page_increment: 10}),
        });
        settings.bind('cpu-power-max', max, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('show-power', max, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(max);

        // Como liberar o sensor
        const howto = new Adw.PreferencesGroup({
            title: _('Allow reading the sensor'),
            description: _('By default only root can read the energy sensor. Run these commands in a terminal, then press the refresh button above.\n\nThe kernel restricts this sensor because, in theory, very fine energy readings can leak information about other programs (the Platypus attack). On a personal computer this is usually an accepted risk.'),
        });
        page.add(howto);

        const copyRow = (title, subtitle) => {
            const row = new Adw.ActionRow({title, subtitle, subtitle_selectable: true});
            const copy = new Gtk.Button({
                icon_name: 'edit-copy-symbolic',
                tooltip_text: _('Copy command'),
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            copy.connect('clicked', () => {
                row.get_clipboard().set(row.subtitle);
                window.add_toast(new Adw.Toast({title: _('Command copied'), timeout: 2}));
            });
            row.add_suffix(copy);
            howto.add(row);
            return row;
        };
        const now = copyRow(_('Allow now (until reboot)'), '');
        const always = copyRow(_('Keep allowed after reboot'), '');

        const refresh = () => {
            const sensor = probeSensor();
            const file = sensor?.file ?? `${POWERCAP}/intel-rapl:0/energy_uj`;
            now.subtitle = `sudo chmod 0444 ${file}`;
            always.subtitle = `echo 'SUBSYSTEM=="powercap", ACTION=="add", RUN+="/bin/chmod 0444 /sys%p/energy_uj"' | sudo tee ${UDEV_RULE}`;

            const ruleInstalled = GLib.file_test(UDEV_RULE, GLib.FileTest.EXISTS);
            now.visible = !sensor?.readable;
            always.visible = !ruleInstalled;
            howto.visible = !!sensor && (now.visible || always.visible);

            if (!sensor)
                status.subtitle = _('Not available on this computer');
            else if (!sensor.readable)
                status.subtitle = _('Found, but needs permission (see below)');
            else if (!ruleInstalled)
                status.subtitle = _('Ready until the next reboot (see below to keep it)');
            else
                status.subtitle = _('Ready');
        };
        recheck.connect('clicked', refresh);
        refresh();
    }
}
