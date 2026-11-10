import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GioUnix from 'gi://GioUnix';

Gio._promisify(Gio.OutputStream.prototype, 'write_all_async', 'write_all_finish');

/**
 * Hand `text` to wl-copy over stdin.
 *
 * stdin rather than argv, for two reasons. Linux caps a single argv element at
 * 128 KiB, so a large page of text made the spawn fail with E2BIG and nothing
 * was copied at all. And wl-copy forks a daemon that serves the selection, so
 * argv would leave the recognised text readable in /proc/<pid>/cmdline for as
 * long as it is on the clipboard.
 *
 * GLib.spawn_async (rather than Gio.Subprocess) is what detaches that daemon,
 * so the caller keeps a working clipboard after this returns.
 *
 * @param {string} wlCopy path to the wl-copy executable
 * @param {string} text recognised text
 * @param {?Gio.Cancellable} cancellable
 * @returns {Promise<boolean>} true once wl-copy has the whole text
 */
export async function copyWithWlCopy(wlCopy, text, cancellable = null) {
    let pid = 0;
    try {
        let stdinFd;
        [, pid, stdinFd] = GLib.spawn_async_with_pipes(
            null,
            [wlCopy, '-t', 'text/plain'],
            null,
            GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
            null);

        const stream = new GioUnix.OutputStream({fd: stdinFd, close_fd: true});
        try {
            // Async so a long selection cannot block the Shell's main loop; the
            // write completes once wl-copy has drained the pipe.
            await stream.write_all_async(
                new TextEncoder().encode(text),
                GLib.PRIORITY_DEFAULT,
                cancellable);
        } finally {
            // Closing the pipe is what tells wl-copy the text is complete.
            stream.close(null);
        }
        return true;
    } catch (err) {
        console.warn(`Grape: wl-copy could not set the clipboard: ${err.message}`);
        return false;
    } finally {
        if (pid !== 0)
            GLib.spawn_close_pid(pid);
    }
}
