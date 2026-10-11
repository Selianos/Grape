import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {clearJobs, readJobs} from './lib/joblog.js';
import {recursiveUnpack} from './lib/unpack.js';

const SCHEMA_KEY = 'ocr-shortcut';
const BUS_NAME = 'io.github.Selianos.Grape1';
const OBJECT_PATH = '/io/github/Selianos/Grape1';
const GITHUB_URL =
    'https://github.com/Selianos/Grape';

Gio._promisify(Gio.DBusProxy.prototype, 'call');

const busProxy = new Gio.DBusProxy({
    g_connection: Gio.DBus.session,
    g_name: 'org.freedesktop.DBus',
    g_interface_name: 'org.freedesktop.DBus',
    g_object_path: '/org/freedesktop/DBus',
    g_flags: Gio.DBusProxyFlags.NONE,
});

/* -- engine status (unchanged) --------------------------------------------- */

// The engine is "installed" when its session-bus activation file is present.
const SERVICE_FILE = GLib.build_filenamev([
    GLib.get_home_dir(), '.local', 'share', 'dbus-1', 'services',
    `${BUS_NAME}.service`,
]);

async function engineStatus() {
    try {
        const names = await busProxy.call(
            'ListNames',
            new GLib.Variant('()', []),
            Gio.DBusCallFlags.NONE,
            -1,
            null);
        // Gio.DBusProxy.call() wraps the reply in a one-element tuple, so the
        // array of names lands at index 0.
        if (recursiveUnpack(names)[0]?.includes(BUS_NAME)) {
            // The engine is running; ask it what state it is in.
            const proxy = new Gio.DBusProxy({
                g_connection: Gio.DBus.session,
                g_name: BUS_NAME,
                g_interface_name: BUS_NAME,
                g_object_path: OBJECT_PATH,
                g_flags: Gio.DBusProxyFlags.NONE,
            });
            try {
                const reply = await proxy.call(
                    'GetStatus',
                    new GLib.Variant('()', []),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null);
                const [[state]] = recursiveUnpack(reply);
                return state === 'ready' ?
                    _('Ready') :
                    _('Loading models…');
            } catch {
                // The name is owned but the status call failed; don't report
                // a running engine as missing.
                return _('Running');
            }
        }
    } catch {
        // Could not talk to the bus; fall through to the on-disk check.
    }

    // Check the activation file on disk rather than ListActivatableNames, which
    // a long-running bus does not reliably refresh for a file written after it
    // started (that is what made a correct install read as "Not installed").
    if (GLib.file_test(SERVICE_FILE, GLib.FileTest.EXISTS))
        return _('Installed, not running');
    return _('Not installed');
}

/* -- shortcut capture ------------------------------------------------------ */

function showShortcutDialog(settings, window) {
    const status = new Adw.StatusPage({
        icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
        title: _('Press your shortcut'),
        description: _('Esc to cancel · Backspace to clear selection'),
    });
    status.add_css_class('compact');

    const toolbar = new Adw.ToolbarView({content: status});
    toolbar.add_top_bar(new Adw.HeaderBar());

    const dialog = new Adw.Dialog({
        title: _('Set OCR Shortcut'),
        content_width: 460,
        content_height: 360,
        child: toolbar,
    });

    const keys = new Gtk.EventControllerKey({
        propagation_phase: Gtk.PropagationPhase.CAPTURE,
    });
    keys.connect('key-pressed', (_controller, keyval, _keycode, state) => {
        const mods = state & Gtk.accelerator_get_default_mod_mask();

        if (!mods && keyval === Gdk.KEY_Escape) {
            dialog.close();
            return Gdk.EVENT_STOP;
        }
        if (!mods && keyval === Gdk.KEY_BackSpace) {
            settings.set_strv(SCHEMA_KEY, []);
            dialog.close();
            return Gdk.EVENT_STOP;
        }
        // A global shortcut needs at least one modifier; only explain that
        // when the user actually presses a bare key.
        if (!mods) {
            status.description = _('Include Ctrl, Alt or Super · Backspace to clear selection');
            return Gdk.EVENT_STOP;
        }
        // Keep waiting while only modifier keys are held down.
        if (!Gtk.accelerator_valid(keyval, mods))
            return Gdk.EVENT_STOP;

        const accel = Gtk.accelerator_name(Gdk.keyval_to_lower(keyval), mods);
        settings.set_strv(SCHEMA_KEY, [accel]);
        dialog.close();
        return Gdk.EVENT_STOP;
    });
    dialog.add_controller(keys);

    dialog.present(window);
}

/* -- log rows -------------------------------------------------------------- */

function jobToRow(entry) {
    const text = (entry.text ?? '').replace(/\s+/g, ' ').trim() ||
        _('(no text)');
    const status = entry.success ? _('OK') : (entry.error ?? _('Error'));
    const when = entry.time ?? '…';
    const dur = entry.duration_ms ?? 0;

    return new Adw.ActionRow({
        title: text,
        subtitle: `${when} · ${status} · ${dur} ms`,
        title_lines: 1,
        subtitle_lines: 1,
        tooltip_text: text,
        // OCR text can contain & or <, which would break markup.
        use_markup: false,
    });
}

/* -- preferences window ---------------------------------------------------- */

export default class GrapePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const builder = new Gtk.Builder();
        builder.set_translation_domain(this.metadata['gettext-domain'] ?? null);
        builder.add_from_file(this.dir.get_child('prefs.ui').get_path());
        const get = id => builder.get_object(id);

        window.add(get('main_page'));

        // Shortcut
        const shortcutLabel = get('shortcut_label');
        const showShortcut = () => {
            shortcutLabel.accelerator = settings.get_strv(SCHEMA_KEY)[0] ?? '';
        };
        showShortcut();
        const shortcutId =
            settings.connect(`changed::${SCHEMA_KEY}`, showShortcut);
        window.connect('close-request', () => {
            settings.disconnect(shortcutId);
        });
        get('shortcut_row').connect('activated', () =>
            showShortcutDialog(settings, window));

        // Engine
        const statusRow = get('status_row');
        const refreshStatus = () => {
            statusRow.subtitle = _('Checking…');
            engineStatus().then(status => {
                statusRow.subtitle = status;
            });
        };
        get('refresh_button').connect('clicked', refreshStatus);
        get('guide_button').connect('clicked', () =>
            Gio.AppInfo.launch_default_for_uri(GITHUB_URL, null));

        // Log
        const logRow = get('log_row');
        let jobRows = [];
        const reloadLog = () => {
            for (const row of jobRows)
                logRow.remove(row);

            const entries = readJobs();
            jobRows = entries.length > 0 ?
                entries.map(jobToRow) :
                [new Adw.ActionRow({title: _('No jobs yet')})];

            for (const row of jobRows)
                logRow.add_row(row);
        };
        logRow.connect('notify::expanded', () => {
            if (logRow.expanded)
                reloadLog();
        });
        get('clear_log_button').connect('clicked', () => {
            clearJobs();
            reloadLog();
        });

        reloadLog();
        refreshStatus();
    }
}
