/**
 * Recursively convert a GLib.Variant (or the value returned by
 * GVariant.unpack()) into plain JS values.
 *
 * GVariant.unpack() only descends one level, so a tuple, array or dict element
 * can still be a nested GVariant (e.g. a D-Bus reply of type `(sa{sv})`
 * unpacks to [GVariant('s'), GVariant('a{sv}')]). Recurse until every leaf is a
 * plain string, number, boolean, array or object.
 */
export function recursiveUnpack(v) {
    if (v && typeof v.unpack === 'function') {
        const value = v.unpack();

        // A variant child (type `v`) unpacks into another GVariant; keep going.
        if (value && typeof value.unpack === 'function')
            return recursiveUnpack(value);

        if (Array.isArray(value))
            return value.map(recursiveUnpack);

        if (value && typeof value === 'object') {
            const out = {};
            for (const [key, item] of Object.entries(value))
                out[key] = recursiveUnpack(item);
            return out;
        }

        return value;
    }
    return v;
}
