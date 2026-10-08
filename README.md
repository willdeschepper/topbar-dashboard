# Topbar Dashboard

A GNOME Shell extension: a dashboard that slides out of the top bar, joined to it with curved corners. Weather, system info, a calendar with your GNOME events, CPU/RAM/disk usage, processor power draw, a media player (MPRIS) and a workspace switcher. Inspired by the Caelestia shell. Switches to a glass look automatically when Blur my Shell blurs the top bar.

Supports GNOME 50. Available in English and Brazilian Portuguese (follows the system language).

## Weather

Open the preferences and search for your city. Weather comes from [Open-Meteo](https://open-meteo.com). Nothing is sent until you pick a city.

## Processor power (optional)

Off by default. Turn on **Show power draw** in the preferences.

The value comes from the processor energy sensor (RAPL), which only root can read by default. The preferences window shows whether the sensor is available and the commands below with the right path for your computer.

Allow it now (lasts until reboot):

```bash
sudo chmod 0444 /sys/class/powercap/intel-rapl:0/energy_uj
```

Keep it allowed after reboot:

```bash
echo 'SUBSYSTEM=="powercap", ACTION=="add", RUN+="/bin/chmod 0444 /sys%p/energy_uj"' | sudo tee /etc/udev/rules.d/99-rapl-energy.rules
```

The `intel-rapl` name is also used on AMD processors. Virtual machines and some processors don't have this sensor; in that case leave the option off.

Why it is restricted: in theory, very fine energy readings can leak information about other programs (the Platypus attack). On a personal computer this is usually an accepted risk.

**Maximum power** only sets the full scale of the power bar on the Performance tab. Use your processor limit: PPT on AMD (about 1.35 × TDP, e.g. 88 W for a 65 W chip), Maximum Turbo Power on Intel.

## Development

```bash
./dev.sh      # installs and opens a nested GNOME Shell that restarts on every save (needs entr)
./install.sh  # installs into ~/.local/share/gnome-shell/extensions
./build.sh    # builds the zip for extensions.gnome.org
```

Translations live in `po/`. To add a language, copy `po/pt_BR.po`, translate it and add the language code to `po/LINGUAS`.

## License

GPL-2.0-or-later
