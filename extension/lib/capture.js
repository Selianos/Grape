import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// GNOME's screenshot UI exposes three modes; SCREENSHOT is area selection with
// the window/full-screen options still available exact same as the default.
const SCREENSHOT_MODE = 0;

/**
 * Thin wrapper around GNOME's built-in screenshot UI. The rest of the extension
 * only ever calls open(), onTaken() and onClosed(), so a change in the Shell's
 * internals is contained here (see the risks section in docs/ARCHITECTURE.md).
 */
export class Capture {
    constructor() {
        this._ui = Main.screenshotUI;
        this._takenId = 0;
        this._closedId = 0;
    }

    /**
     * Open the area-selection UI. Resolves to true when the UI actually opened:
     * the Shell's open() returns early (emitting no signal at all) if a
     * screencast or another opening coroutine is already in progress, and the
     * caller has to release its guard in that case.
     *
     * @returns {Promise<boolean>}
     */
    async open() {
        await this._ui.open(SCREENSHOT_MODE);
        return Boolean(this._ui.visible);
    }

    /**
     * Call @handler(path) with the PNG path after a region is selected.
     * @param {(path: string) => void} handler
     */
    onTaken(handler) {
        if (this._takenId)
            this._ui.disconnect(this._takenId);
        this._takenId = this._ui.connect('screenshot-taken', (_ui, file) => {
            handler(file.get_path());
        });
    }

    /**
     * Call @handler() when the UI closes, whether a region was taken or not.
     * @param {() => void} handler
     */
    onClosed(handler) {
        if (this._closedId)
            this._ui.disconnect(this._closedId);
        this._closedId = this._ui.connect('closed', handler);
    }

    disconnect() {
        if (this._takenId) {
            this._ui.disconnect(this._takenId);
            this._takenId = 0;
        }
        if (this._closedId) {
            this._ui.disconnect(this._closedId);
            this._closedId = 0;
        }
    }
}
