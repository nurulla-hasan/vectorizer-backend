import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const REALESRGAN_TAG = 'v0.2.5.0';
const REALESRGAN_ARCHIVE_DATE = '20220424';
const DEST_DIR = path.resolve(process.cwd(), 'bin', 'realesrgan');

async function downloadFile(url, destPath) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  await pipeline(response.body, fs.createWriteStream(destPath));
}

function findFileRecursive(dir, filename) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) {
      return full;
    }
    if (entry.isDirectory()) {
      const nested = findFileRecursive(full, filename);
      if (nested) return nested;
    }
  }
  return null;
}

function flattenIfNested(targetDir, exeName) {
  const directExe = path.join(targetDir, exeName);
  if (fs.existsSync(directExe)) return;

  const found = findFileRecursive(targetDir, exeName);
  if (!found) {
    throw new Error(`Extraction succeeded but ${exeName} was not found under ${targetDir}`);
  }

  const nestedRoot = path.dirname(found);
  for (const entry of fs.readdirSync(nestedRoot)) {
    const src = path.join(nestedRoot, entry);
    const dst = path.join(targetDir, entry);
    if (!fs.existsSync(dst)) {
      fs.renameSync(src, dst);
    }
  }
}

async function installRealEsrgan() {
  fs.mkdirSync(DEST_DIR, { recursive: true });

  let archiveName;
  let exeName;
  if (process.platform === 'win32') {
    archiveName = `realesrgan-ncnn-vulkan-${REALESRGAN_ARCHIVE_DATE}-windows.zip`;
    exeName = 'realesrgan-ncnn-vulkan.exe';
  } else if (process.platform === 'linux') {
    archiveName = `realesrgan-ncnn-vulkan-${REALESRGAN_ARCHIVE_DATE}-ubuntu.zip`;
    exeName = 'realesrgan-ncnn-vulkan';
  } else if (process.platform === 'darwin') {
    archiveName = `realesrgan-ncnn-vulkan-${REALESRGAN_ARCHIVE_DATE}-macos.zip`;
    exeName = 'realesrgan-ncnn-vulkan';
  } else {
    throw new Error(
      `Unsupported platform "${process.platform}". Install realesrgan-ncnn-vulkan manually.`,
    );
  }

  const zipUrl = `https://github.com/xinntao/Real-ESRGAN/releases/download/${REALESRGAN_TAG}/${archiveName}`;
  const zipPath = path.join(DEST_DIR, 'realesrgan.zip');

  console.log(`[realesrgan] Downloading ${zipUrl}...`);
  await downloadFile(zipUrl, zipPath);

  if (process.platform === 'win32') {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${DEST_DIR}' -Force`,
      ],
      { stdio: 'inherit' },
    );
  } else {
    execFileSync('unzip', ['-o', zipPath, '-d', DEST_DIR], { stdio: 'inherit' });
  }
  fs.rmSync(zipPath, { force: true });

  flattenIfNested(DEST_DIR, exeName);

  const exePath = path.join(DEST_DIR, exeName);
  const animeParam = findFileRecursive(DEST_DIR, 'realesrgan-x4plus-anime.param');
  const animeBin = findFileRecursive(DEST_DIR, 'realesrgan-x4plus-anime.bin');

  if (!fs.existsSync(exePath)) {
    throw new Error(`Missing executable at ${exePath}`);
  }
  if (!animeParam || !animeBin) {
    throw new Error('Missing realesrgan-x4plus-anime model files (.param / .bin)');
  }
  if (process.platform !== 'win32') {
    fs.chmodSync(exePath, 0o755);
  }

  console.log(`[realesrgan] Installed binary at ${exePath}`);
  console.log(`[realesrgan] Verified anime model at ${path.dirname(animeParam)}`);
}

installRealEsrgan().catch((error) => {
  console.error('[realesrgan] Installation failed:', error);
  process.exit(1);
});
