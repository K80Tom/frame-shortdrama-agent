import { spawnSync } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.error('Desktop bridge currently supports macOS only.');
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, 'outputs/private/desktop-helper/OHAO Desktop Bridge.app');
const executable = path.join(bundle, 'Contents/MacOS/OHAODesktopBridge');
await mkdir(path.dirname(executable), { recursive: true, mode: 0o700 });
await copyFile(path.join(root, 'desktop-helper/Info.plist'), path.join(bundle, 'Contents/Info.plist'));
const compilation = spawnSync('/usr/bin/xcrun', ['swiftc', '-O', '-swift-version', '5',
  '-module-cache-path', path.join(root, 'outputs/private/desktop-helper/module-cache'),
  '-framework', 'AppKit', '-framework', 'ApplicationServices',
  path.join(root, 'desktop-helper/guards.swift'), path.join(root, 'desktop-helper/main.swift'), '-o', executable], { stdio: 'inherit' });
if (compilation.error || compilation.status !== 0) process.exit(compilation.status || 1);
// The bundle ID is fixed, but ad-hoc designated requirements depend on cdhash.
// A rebuild can require the user to remove/re-add this same app's Accessibility
// entry. This does not grant permissions, notarize, or install a certificate.
const signed = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'local.ohao.doubao-asset-bridge', bundle], { stdio: 'inherit' });
if (signed.error || signed.status !== 0) process.exit(signed.status || 1);
console.log('Built local OHAO Desktop Bridge. No desktop action or model request was performed.');
