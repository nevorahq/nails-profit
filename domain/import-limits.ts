/**
 * A file large enough to matter is a file the owner should be splitting. The
 * cap exists so that a mis-selected 200 MB export cannot be read into memory,
 * parsed three times and stored in a row.
 *
 * Here rather than beside the routes so the browser can hold a phone's
 * contacts file to it before reading the whole thing into a list.
 */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
