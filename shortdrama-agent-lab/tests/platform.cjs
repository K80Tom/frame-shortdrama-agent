'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, rm, symlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

/** Shown when a symlink case cannot be created on this Windows process. */
const WINDOWS_SYMLINK_SKIP = 'Windows refused to create a symlink (EPERM or ENOTSUP). '
  + 'Developer Mode or an elevated process is required. Production still rejects symlinks; '
  + 'this assertion stays mandatory on Unix and on Windows when symlink creation succeeds.';

let symlinkProbe;

/**
 * Unix always can. On Windows, probe once: without Developer Mode, symlink()
 * fails with EPERM and the security cases cannot be staged.
 */
function canCreateSymlink() {
  if (process.platform !== 'win32') return Promise.resolve(true);
  if (!symlinkProbe) symlinkProbe = probeSymlink();
  return symlinkProbe;
}

async function probeSymlink() {
  const dir = await mkdtemp(join(tmpdir(), 'ohao-symlink-probe-'));
  try {
    await symlink(join(dir, 'target'), join(dir, 'link'));
    return true;
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'ENOTSUP' || error.code === 'EACCES')) return false;
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Windows does not store Unix permission bits; Node reports 0666 for a file
 * opened with mode 0o600. Keep the assertion on every other platform.
 * Callers still create the file with 0o600/0o700 — this only skips the check.
 */
function assertUnixMode(mode, expected) {
  if (process.platform === 'win32') return;
  assert.equal(mode & 0o777, expected);
}

module.exports = { WINDOWS_SYMLINK_SKIP, canCreateSymlink, assertUnixMode };
