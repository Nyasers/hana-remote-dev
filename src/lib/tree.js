/**
 * Recursive remote directory walk over an SFTP client (from ssh-client's
 * sftp() wrapper). Used by hrd_grep / hrd_find — sftp-based, OS-agnostic,
 * mirrors the local grep/find implementation (fs walk + JS matching).
 */

const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_MAX_DEPTH = 32;

/**
 * Walk a remote directory tree.
 *
 * @param {object} client - sftp client from ssh-client.sftp()
 * @param {string} root - remote root path
 * @param {object} [opts]
 * @param {(fullPath: string, isDirectory: boolean) => boolean|Promise<boolean>} [opts.onFile]
 *   called per entry; return false to stop the whole walk early
 * @param {(err: Error, dir: string) => void} [opts.onError] - per-dir errors (e.g. permission)
 * @param {number} [opts.maxEntries=2000] - hard cap on visited entries
 * @param {number} [opts.maxDepth=32] - recursion depth cap
 * @returns {Promise<{ count: number, skipped: boolean }>} skipped=true when a cap stopped the walk
 */
export async function walkDir(client, root, opts = {}) {
  const { onFile = () => true, onError = () => {}, maxEntries = DEFAULT_MAX_ENTRIES, maxDepth = DEFAULT_MAX_DEPTH } = opts;
  let count = 0;
  let skipped = false;
  let stop = false;

  async function rec(dir, depth) {
    if (stop || depth > maxDepth) return;
    let entries;
    try {
      entries = await client.readdir(dir);
    } catch (err) {
      onError(err, dir);
      return;
    }
    for (const e of entries) {
      if (stop) return;
      if (count >= maxEntries) {
        skipped = true;
        stop = true;
        return;
      }
      const full = dir === "/" ? `/${e.filename}` : `${dir}/${e.filename}`;
      count++;
      if (e.isDirectory) {
        await rec(full, depth + 1);
      } else {
        const cont = await onFile(full, false);
        if (cont === false) {
          skipped = true;
          stop = true;
          return;
        }
      }
    }
  }

  // The root itself counts as visited; directories under it are recursed.
  count++;
  const cont = await onFile(root, true);
  if (cont === false) return { count, skipped: false };
  await rec(root, 0);
  return { count, skipped };
}

/** Convert a glob (with * ** ?) to a RegExp matching a full path. */
export function globToRegExp(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(out + "$");
}
