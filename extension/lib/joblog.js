import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_async');

const MAX_ENTRIES = 50;

/** In-memory tail of the log, so each job costs one async write, not a read+write. */
let cachedLines = null;
/** Serialises writes: two jobs must not interleave read-modify-write. */
let writeChain = Promise.resolve();

function logPath() {
    return GLib.build_filenamev([
        GLib.get_user_state_dir(),
        'grape',
        'jobs.jsonl',
    ]);
}

function ensureParentDir(file) {
    const parent = file.get_parent();
    if (parent && !parent.query_exists(null)) {
        parent.make_directory_with_parents(null);
        // The log holds recognised text, which can be anything on screen, so
        // keep the directory itself out of other users' reach. The file mode
        // is tightened again after every write (see appendJob).
        parent.set_attribute_uint32(
            Gio.FILE_ATTRIBUTE_UNIX_MODE, 0o700,
            Gio.FileQueryInfoFlags.NONE, null);
    }
}

async function loadLines(file) {
    if (cachedLines !== null)
        return cachedLines;
    try {
        const [contents] = await file.load_contents_async(null);
        cachedLines = new TextDecoder().decode(contents)
            .split('\n')
            .filter((line) => line.length > 0);
    } catch {
        // Missing or unreadable log: start a fresh one.
        cachedLines = [];
    }
    return cachedLines;
}

/**
 * Append one job record, newest-last, keeping only MAX_ENTRIES. The read happens
 * once per Shell session into an in-memory tail, and the write is serialised, so
 * recognition never blocks the main thread on file I/O (which would be a review
 * rejection at extensions.gnome.org).
 *
 * Returns a promise so callers can await a flush; the extension does not.
 *
 * @param {object} record
 * @param {string} record.time - ISO 8601 timestamp of when the job started.
 * @param {number} record.durationMs - wall-clock time of the Recognize call.
 * @param {boolean} record.success - whether text was copied.
 * @param {string|null} record.error - error message, or null on success.
 * @param {string} record.text - recognised text (empty when none).
 * @param {boolean} [logText] - whether to store the recognised text verbatim.
 *   When false (the default) only its length is stored, since screen OCR can
 *   capture passwords and other secrets.
 */
export function appendJob(record, logText = false) {
    writeChain = writeChain.then(async () => {
        const file = Gio.File.new_for_path(logPath());
        ensureParentDir(file);

        const lines = await loadLines(file);
        const text = record.text ?? '';
        const entry = {
            time: record.time,
            duration_ms: Math.round(record.durationMs),
            success: Boolean(record.success),
            error: record.error ?? null,
        };
        if (logText)
            entry.text = text;
        else
            entry.text_length = text.length;
        lines.push(JSON.stringify(entry));

        if (lines.length > MAX_ENTRIES)
            cachedLines = lines.slice(-MAX_ENTRIES);

        await file.replace_contents_async(
            new TextEncoder().encode(`${cachedLines.join('\n')}\n`),
            null,
            false,
            Gio.FileCreateFlags.NONE,
            null);

        // The log holds recognised text, which can be anything on screen.
        try {
            file.set_attribute_uint32(
                Gio.FILE_ATTRIBUTE_UNIX_MODE, 0o600,
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (err) {
            console.debug(`Grape: could not tighten the log mode: ${err.message}`);
        }
    }).catch((err) => {
        console.warn(`Grape: could not write the job log: ${err.message}`);
    });
    return writeChain;
}

/**
 * Read the job log, newest first, as parsed records. Used by preferences.
 * @returns {object[]}
 */
export function readJobs() {
    const file = Gio.File.new_for_path(logPath());
    if (!file.query_exists(null))
        return [];
    const [ok, contents] = file.load_contents(null);
    if (!ok)
        return [];
    return new TextDecoder().decode(contents)
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .filter((entry) => entry !== null)
        .reverse();
}

/** Empty the job log. Used by the preferences "Clear log" button. */
export function clearJobs() {
    cachedLines = null;
    const file = Gio.File.new_for_path(logPath());
    ensureParentDir(file);
    const stream = file.replace(
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null);
    stream.close(null);
}
