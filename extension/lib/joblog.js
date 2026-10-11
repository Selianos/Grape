import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MAX_ENTRIES = 50;

function logPath() {
    return GLib.build_filenamev([
        GLib.get_user_state_dir(),
        'grape',
        'jobs.jsonl',
    ]);
}

function getParentDir(file) {
    const parent = file.get_parent();
    if (parent && !parent.query_exists(null))
        parent.make_directory_with_parents(null);
}

/**
 * Append one job record to ~/.local/state/grape/jobs.jsonl and keep only the
 * newest MAX_ENTRIES. Called by the extension after each recognition, so the
 * preferences window can show history without journalctl.
 *
 * @param {object} record
 * @param {string} record.time - ISO 8601 timestamp of when the job started.
 * @param {number} record.durationMs - wall-clock time of the Recognize call.
 * @param {boolean} record.success - whether text was copied.
 * @param {string|null} record.error - error message, or null on success.
 * @param {string} record.text - recognised text (empty when none).
 */
export function appendJob(record) {
    const file = Gio.File.new_for_path(logPath());
    getParentDir(file);

    let lines = [];
    if (file.query_exists(null)) {
        const [ok, contents] = file.load_contents(null);
        if (ok) {
            const text = new TextDecoder().decode(contents);
            lines = text.split('\n').filter((line) => line.length > 0);
        }
    }

    lines.push(JSON.stringify({
        time: record.time,
        duration_ms: Math.round(record.durationMs),
        success: Boolean(record.success),
        error: record.error ?? null,
        text: record.text ?? '',
    }));

    if (lines.length > MAX_ENTRIES)
        lines = lines.slice(-MAX_ENTRIES);

    file.replace_contents(
        new TextEncoder().encode(`${lines.join('\n')}\n`),
        null,
        false,
        Gio.FileCreateFlags.NONE,
        null);
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
    getParentDir(file);
    const stream = file.replace(
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null);
    stream.close(null);
}
