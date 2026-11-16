import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const VTRACER_VERSION = '0.6.4';
const BIN_DIR = path.resolve(process.cwd(), 'bin');

async function downloadFile(url, destPath) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  await pipeline(response.body, fs.createWriteStream(destPath));
}

async function installVtracer() {
  fs.mkdirSync(BIN_DIR, { recursive: true });

  if (process.platform === 'win32') {
    const zipUrl = `https://github.com/visioncortex/vtracer/releases/download/${VTRACER_VERSION}/vtracer-x86_64-pc-windows-msvc.zip`;
    const zipPath = path.join(BIN_DIR, 'vtracer.zip');
    const exePath = path.join(BIN_DIR, 'vtracer.exe');

    console.log(`[vtracer] Downloading ${zipUrl}...`);
    await downloadFile(zipUrl, zipPath);

    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${BIN_DIR}' -Force`,
      ],
      { stdio: 'inherit' },
    );
    fs.rmSync(zipPath, { force: true });

    if (!fs.existsSync(exePath)) {
      throw new Error(`Extraction succeeded but ${exePath} was not found`);
    }
    console.log(`[vtracer] Installed successfully at ${exePath}`);
    return;
  }

  if (process.platform === 'linux') {
    const tarUrl = `https://github.com/visioncortex/vtracer/releases/download/${VTRACER_VERSION}/vtracer-x86_64-unknown-linux-musl.tar.gz`;
    const tarPath = path.join(BIN_DIR, 'vtracer.tar.gz');
    const binPath = path.join(BIN_DIR, 'vtracer');

    console.log(`[vtracer] Downloading ${tarUrl}...`);
    await downloadFile(tarUrl, tarPath);

    execFileSync('tar', ['-xzf', tarPath, '-C', BIN_DIR], { stdio: 'inherit' });
    fs.rmSync(tarPath, { force: true });

    if (!fs.existsSync(binPath)) {
      throw new Error(`Extraction succeeded but ${binPath} was not found`);
    }
    fs.chmodSync(binPath, 0o755);
    console.log(`[vtracer] Installed successfully at ${binPath}`);
    return;
  }

  throw new Error(
    `Unsupported platform "${process.platform}". Install vtracer manually or set VTRACER_PATH.`,
  );
}

installVtracer().catch((error) => {
  console.error('[vtracer] Installation failed:', error);
  process.exit(1);
});
