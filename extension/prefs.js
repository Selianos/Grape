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
const INSTALL_URL =
    'https://github.com/selianos/grape/blob/main/docs/INSTALL.md';

Gio._promisify(Gio.DBusProxy.prototype, 'call');

const busProxy = new Gio.DBusProxy({
    g_connection: Gio.DBus.session,
    g_name: 'org.freedesktop.DBus',
    g_interface_name: 'org.freedesktop.DBus',
    g_object_path: '/org/freedesktop/DBus',
    g_flags: Gio.DBusProxyFlags.NONE,
});

function accelLabel(accels) {
    return accels.length > 0 ? accels[0] : _('Not set');
}

/* -- engine status --------------------------------------------------------- */

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

const MODIFIER_KEYS = new Set([
    Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
    Gdk.KEY_Control_L, Gdk.KEY_Control_R,
    Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
    Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
    Gdk.KEY_Super_L, Gdk.KEY_Super_R,
    Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
]);

function showShortcutDialog(settings, window, onChanged) {
    const dialog = new Gtk.Window({
        transient_for: window,
        modal: true,
        title: _('Set OCR shortcut'),
        default_width: 360,
        default_height: 180,
    });

    const hint = new Gtk.Label({
        label: _('Press the key combination you want to use.'),
        wrap: true,
        margin_top: 16,
        margin_bottom: 8,
        margin_start: 16,
        margin_end: 16,
    });

    const clear = new Gtk.Button({label: _('Clear (Backspace)')});
    clear.connect('clicked', () => {
        settings.set_strv(SCHEMA_KEY, []);
        dialog.close();
        onChanged();
    });

    const cancel = new Gtk.Button({label: _('Cancel')});
    cancel.connect('clicked', () => dialog.close());

    const buttons = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
        halign: Gtk.Align.END,
        margin_bottom: 16,
        margin_start: 16,
        margin_end: 16,
    });
    buttons.append(clear);
    buttons.append(cancel);

    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    box.append(hint);
    box.append(buttons);
    dialog.set_child(box);

    const controller = new Gtk.EventControllerKey();
    dialog.add_controller(controller);
    controller.connect('key-pressed', (_controller, keyval, _keycode, state) => {
        if (keyval === Gdk.KEY_Escape) {
            dialog.close();
            return Gdk.EVENT_STOP;
        }
        if (keyval === Gdk.KEY_BackSpace) {
            settings.set_strv(SCHEMA_KEY, []);
            dialog.close();
            onChanged();
            return Gdk.EVENT_STOP;
        }
        if (MODIFIER_KEYS.has(keyval))
            return Gdk.EVENT_PROPAGATE;

        const accel = Gtk.accelerator_name(keyval, state);
        if (accel) {
            settings.set_strv(SCHEMA_KEY, [accel]);
            dialog.close();
            onChanged();
        }
        return Gdk.EVENT_STOP;
    });

    dialog.present();
}

/* -- log dialog ------------------------------------------------------------ */

function formatJob(entry) {
    const when = entry.time ?? '…';
    const dur = entry.duration_ms ?? 0;
    const status = entry.success ? _('ok') : (entry.error ?? _('error'));
    const text = (entry.text ?? '').replace(/\n/g, ' ↵ ');
    return `${when}  [${status}]  ${dur} ms\n    ${text}`;
}

function showLogDialog(window) {
    const textBuffer = new Gtk.TextBuffer();
    const reload = () => {
        const entries = readJobs();
        textBuffer.set_text(
            entries.map(formatJob).join('\n\n') || _('No jobs yet.'));
    };
    reload();

    const textView = new Gtk.TextView({
        buffer: textBuffer,
        editable: false,
        cursor_visible: false,
        wrap_mode: Gtk.WrapMode.WORD_CHAR,
    });
    textView.add_css_class('monospace');

    const scroller = new Gtk.ScrolledWindow();
    scroller.set_child(textView);
    scroller.set_vexpand(true);

    const clear = new Gtk.Button({label: _('Clear log')});
    clear.connect('clicked', () => {
        clearJobs();
        reload();
    });
    const close = new Gtk.Button({label: _('Close')});
    close.connect('clicked', () => dialog.close());

    const buttons = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
        halign: Gtk.Align.END,
        margin_bottom: 16,
        margin_start: 16,
        margin_end: 16,
    });
    buttons.append(clear);
    buttons.append(close);

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
    });
    box.append(scroller);
    box.append(buttons);

    const dialog = new Gtk.Window({
        transient_for: window,
        modal: true,
        title: _('Grape log'),
        default_width: 480,
        default_height: 360,
    });
    dialog.set_child(box);
    dialog.present();
}

/* -- preferences window ---------------------------------------------------- */

export default class GrapePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        // Shortcut
        const shortcutGroup = new Adw.PreferencesGroup({
            title: _('Shortcut'),
        });
        const shortcutRow = new Adw.ActionRow({
            title: _('OCR shortcut'),
            subtitle: accelLabel(settings.get_strv(SCHEMA_KEY)),
            activatable: true,
        });
        shortcutRow.connect('activated', () => {
            showShortcutDialog(settings, window, () => {
                shortcutRow.set_subtitle(
                    accelLabel(settings.get_strv(SCHEMA_KEY)));
            });
        });
        shortcutGroup.add(shortcutRow);
        page.add(shortcutGroup);

        // Engine
        const engineGroup = new Adw.PreferencesGroup({
            title: _('Engine'),
        });
        const statusRow = new Adw.ActionRow({
            title: _('Status'),
            subtitle: _('Checking…'),
        });
        const refresh = new Gtk.Button({label: _('Refresh')});
        const refreshStatus = () => {
            statusRow.set_subtitle(_('Checking…'));
            engineStatus().then((status) => statusRow.set_subtitle(status));
        };
        refresh.connect('clicked', () => refreshStatus());
        statusRow.add_suffix(refresh);
        engineGroup.add(statusRow);

        const guideRow = new Adw.ActionRow({
            title: _('Setup'),
            subtitle: _('Install the engine and models.'),
        });
        const guide = new Gtk.Button({label: _('Install guide')});
        guide.connect('clicked', () =>
            Gio.AppInfo.launch_default_for_uri(INSTALL_URL, null));
        guideRow.add_suffix(guide);
        engineGroup.add(guideRow);
        page.add(engineGroup);

        // Log
        const logGroup = new Adw.PreferencesGroup({
            title: _('Log'),
        });
        const showLogRow = new Adw.ActionRow({
            title: _('Show log'),
            subtitle: _('Last 50 jobs, newest first.'),
            activatable: true,
        });
        showLogRow.connect('activated', () => showLogDialog(window));
        logGroup.add(showLogRow);

        const clearLogRow = new Adw.ActionRow({
            title: _('Clear log'),
            activatable: true,
        });
        clearLogRow.connect('activated', () => clearJobs());
        logGroup.add(clearLogRow);
        page.add(logGroup);

        refreshStatus();
    }
}
