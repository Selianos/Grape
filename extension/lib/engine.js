import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {recursiveUnpack} from './unpack.js';

// GJS does not return a Promise from DBusProxy.call() automatically; wrap it so
// each call can be awaited. This runs once at module load.
Gio._promisify(Gio.DBusProxy.prototype, 'call');

const BUS_NAME = 'io.github.Selianos.Grape1';
const OBJECT_PATH = '/io/github/Selianos/Grape1';
const ERROR_ROOT = `${BUS_NAME}.Error`;

export const ErrorName = {
    NoText: `${ERROR_ROOT}.NoText`,
    BadImage: `${ERROR_ROOT}.BadImage`,
    ModelMissing: `${ERROR_ROOT}.ModelMissing`,
};

/**
 * Async proxy to the Grape OCR service. The service is started by the session
 * bus on the first call (D-Bus activation), so nothing runs at login and it
 * restarts after the idle timeout. Every method is awaited.
 */
export class Engine {
    constructor() {
        this._proxy = new Gio.DBusProxy({
            g_connection: Gio.DBus.session,
            g_name: BUS_NAME,
            g_interface_name: BUS_NAME,
            g_object_path: OBJECT_PATH,
            g_flags: Gio.DBusProxyFlags.NONE,
        });
    }

    _call(method, params, cancellable = null) {
        return this._proxy.call(
            method,
            params,
            Gio.DBusCallFlags.NONE,
            -1,
            cancellable);
    }

    /** Load the models if they are not loaded yet. Fire-and-forget from the UI. */
    async warmup(cancellable = null) {
        await this._call('Warmup', new GLib.Variant('()', []), cancellable);
    }

    /**
     * OCR one image and return {text, meta}. @meta holds elapsed_ms, line_count
     * and confidence as reported by the engine.
     * @param {string} path - absolute path of the PNG in the user's Pictures directory.
     * @returns {Promise<{text: string, meta: object}>}
     */
    async recognize(path, cancellable = null) {
        const params = new GLib.Variant('(sa{sv})', [path, {}]);
        const reply = await this._call('Recognize', params, cancellable);
        // Gio.DBusProxy.call() wraps the single return value in a one-element
        // tuple, so the (sa{sv}) struct arrives as [[text, meta]].
        const [[text, meta]] = recursiveUnpack(reply);
        return {text, meta};
    }

    /** Return {state, version, models} without loading the engine. */
    async getStatus() {
        const reply = await this._call('GetStatus', new GLib.Variant('()', []));
        const [[state, version, models]] = recursiveUnpack(reply);
        return {state, version, models};
    }

    /**
     * True when a D-Bus error is one of Grape's named errors.
     * @param {object} err
     * @param {string} suffix - 'NoText', 'BadImage' or 'ModelMissing'.
     */
    static isError(err, suffix) {
        return Boolean(err && err.message && err.message.includes(`${ERROR_ROOT}.${suffix}`));
    }

    /**
     * True when the service name is not activatable, i.e. the engine is not
     * installed. The bus surfaces this as a ServiceUnknown/NameHasNoOwner error.
     * @param {object} err
     */
    static isNotInstalled(err) {
        if (!err || !err.message)
            return false;
        return err.message.includes('ServiceUnknown') ||
            err.message.includes('NameHasNoOwner');
    }
}
