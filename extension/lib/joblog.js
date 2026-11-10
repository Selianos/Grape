import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_async');
Gio._promisify(Gio.File.prototype, 'make_directory_async');
Gio._promisify(Gio.File.prototype, 'set_attributes_async');

const MAX_ENTRIES = 50;

/** Serialises writes: two jobs must not interleave read-modify-write. */
let writeChain = Promise.resolve();

function logPath() {
    return GLib.build_filenamev([
        GLib.get_user_state_dir(),
        'grape',
        'jobs.jsonl',
    ]);
}

/** Create @dir and any missing parents, without blocking the Shell. */
async function makeDirectories(dir) {
    try {
        await dir.make_directory_async(GLib.PRIORITY_DEFAULT, null);
    } catch (err) {
        if (err.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            return;
        if (!err.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            throw err;
        await makeDirectories(dir.get_parent());
        await dir.make_directory_async(GLib.PRIORITY_DEFAULT, null);
    }
}

/**
 * The log holds recognised text, which can be anything on screen, so both the
 * directory and the file are kept private. Applied on every append rather than
 * only at creation: installs from before this was added already have a 0755
 * directory and a 0644 file, and would keep them forever.
 */
async function makePrivate(file, mode) {
    const info = new Gio.FileInfo();
    info.set_attribute_uint32(Gio.FILE_ATTRIBUTE_UNIX_MODE, mode);
    try {
        await file.set_attributes_async(
            info, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
    } catch (err) {
        console.debug(`Grape: could not tighten ${file.get_path()}: ${err.message}`);
    }
}

/**
 * Read the log's current lines. Read on every append rather than cached: the
 * preferences process clears the file, and a copy cached in the Shell would
 * write the cleared entries straight back on the next job.
 */
async function loadLines(file) {
    try {
        const [contents] = await file.load_contents_async(null);
        return new TextDecoder().decode(contents)
            .split('\n')
            .filter((line) => line.length > 0);
    } catch {
        // Missing or unreadable log: start a fresh one.
        return [];
    }
}

/**
 * Append one job record, newest-last, keeping only MAX_ENTRIES. Both the read
 * and the write are async and serialised, so recognition never blocks the main
 * thread on file I/O (which would be a review rejection at extensions.gnome.org).
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
        const dir = file.get_parent();
        await makeDirectories(dir);
        await makePrivate(dir, 0o700);

        let lines = await loadLines(file);
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
            lines = lines.slice(-MAX_ENTRIES);

        await file.replace_contents_async(
            new TextEncoder().encode(`${lines.join('\n')}\n`),
            null,
            false,
            Gio.FileCreateFlags.PRIVATE,
            null);

        await makePrivate(file, 0o600);
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
    const file = Gio.File.new_for_path(logPath());
    if (!file.query_exists(null))
        return;
    // Runs in the preferences process, so synchronous I/O is fine here.
    // PRIVATE keeps the emptied file 0600 like the one it replaces.
    const stream = file.replace(
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE,
        null);
    stream.close(null);
}
