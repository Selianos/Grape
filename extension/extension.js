import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {
    Extension,
    gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Capture} from './lib/capture.js';
import {Engine} from './lib/engine.js';
import {appendJob} from './lib/joblog.js';

const SCHEMA_KEY = 'ocr-shortcut';
const INSTALL_URL =
    'https://github.com/selianos/grape/blob/main/docs/INSTALL.md';

export default class GrapeExtension extends Extension {
    _capture = null;
    _engine = null;
    _settings = null;
    _busy = false;
    _armed = false;
    _taken = false;

    enable() {
        this._capture = new Capture();
        this._engine = new Engine();
        this._settings = this.getSettings();

        this._capture.onTaken((path) => this._onScreenshotTaken(path));
        this._capture.onClosed(() => this._onCaptureClosed());

        this._settings.connectObject(
            'changed::ocr-shortcut',
            () => this._registerShortcut(),
            this);

        this._registerShortcut();

        if (this._settings.get_strv(SCHEMA_KEY).length === 0)
            this._notifyFirstRun();
    }

    disable() {
        Main.wm.removeKeybinding(SCHEMA_KEY);
        this._capture?.disconnect();
        this._settings?.disconnectObject(this);
        this._settings = null;
        this._engine = null;
        this._capture = null;
        this._busy = false;
        this._armed = false;
        this._taken = false;
    }

    // -- keybinding ---------------------------------------------------------

    _registerShortcut() {
        Main.wm.removeKeybinding(SCHEMA_KEY);
        Main.wm.addKeybinding(
            SCHEMA_KEY,
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._onShortcut());
    }

    // -- flow ---------------------------------------------------------------

    _onShortcut() {
        if (this._busy)
            return;
        this._busy = true;
        this._armed = true;
        this._taken = false;
        // Fire the engine's cold start without waiting: the model load overlaps
        // the user's region selection. Errors surface at Recognize.
        this._engine.warmup().catch(() => {});
        this._capture.open();
    }

    _onScreenshotTaken(path) {
        // Main.screenshotUI is a shared singleton: any screenshot taken
        // through it fires this signal, not just ones we opened (the
        // system's own screenshot shortcut, other extensions, etc). Only
        // react when our own shortcut armed a capture.
        if (!this._armed)
            return;
        this._armed = false;
        this._taken = true;
        this._recognize(path);
    }

    _onCaptureClosed() {
        // No region was selected: release the guard so the next press works.
        if (!this._taken)
            this._busy = false;
        this._armed = false;
        this._taken = false;
    }

    async _recognize(path) {
        const startUs = GLib.get_monotonic_time();
        let record;
        try {
            const {text} = await this._engine.recognize(path);
            this._copyToClipboard(text);
            this._notify(_('Text copied'));
            record = {success: true, error: null, text};
        } catch (err) {
            record = {success: false, error: err.message, text: ''};
            if (Engine.isError(err, 'NoText')) {
                this._notify(
                    _('No text found'),
                    _('Nothing was recognised in the selection.'));
            } else if (Engine.isError(err, 'ModelMissing') ||
                       Engine.isNotInstalled(err)) {
                this._notifyMissing();
            } else {
                this._notify(_('Failed to copy'), err.message);
            }
        } finally {
            appendJob({
                time: new Date().toISOString(),
                durationMs: (GLib.get_monotonic_time() - startUs) / 1000,
                ...record,
            });
            this._busy = false;
        }
    }

    // -- clipboard ------------------------------------------------------------

    _copyToClipboard(text) {
        const clipboard = St.Clipboard.get_default();
        clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        // GNOME's screenshot UI already put the captured image on the
        // clipboard a moment ago, from this same process. Clipboard managers
        // that watch Mutter's selection owner-changed signal (e.g. Vicinae)
        // can miss this immediate follow-up write, so re-assert once that
        // first change has settled, as long as nothing else grabbed the
        // clipboard in the meantime.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            clipboard.get_text(St.ClipboardType.CLIPBOARD, (_cb, current) => {
                if (current === text)
                    clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    // -- notifications ------------------------------------------------------

    _notify(title, body = '') {
        const source = MessageTray.getSystemSource();
        const notification = new MessageTray.Notification({
            source,
            title,
            body,
            isTransient: true,
        });
        source.addNotification(notification);
        return notification;
    }

    _notifyFirstRun() {
        const notification = this._notify(
            _('Set a shortcut to start'),
            _('Grape grabs text after you pick a region.'));
        notification.addAction(
            _('Open preferences'),
            () => this.openPreferences());
    }

    _notifyMissing() {
        const notification = this._notify(
            _('Failed to copy'),
            _('The engine is not installed.'));
        notification.addAction(
            _('Open install guide'),
            () => Gio.AppInfo.launch_default_for_uri(INSTALL_URL, null));
    }
}
