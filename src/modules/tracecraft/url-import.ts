import dns from 'node:dns/promises';
import net from 'node:net';
import httpStatus from 'http-status';
import { AppError } from '../../utils/app-error.js';

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;

const isPrivateIp = (ip: string): boolean => {
  if (net.isIPv4(ip)) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const mappedIp = mapped?.[1];
  return mappedIp ? isPrivateIp(mappedIp) : false;
};

const assertPublicHost = async (hostname: string): Promise<void> => {
  const addresses = await dns.lookup(hostname, { all: true }).catch(() => {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Could not resolve the image URL host',
      'URL_UNREACHABLE',
    );
  });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Only public image URLs are allowed',
      'URL_NOT_ALLOWED',
    );
  }
};

const readBodyWithLimit = async (response: Response): Promise<Buffer> => {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new AppError(httpStatus.BAD_REQUEST, 'The image URL returned no body', 'URL_EMPTY');
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_IMPORT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AppError(
          httpStatus.REQUEST_ENTITY_TOO_LARGE,
          'Remote image is larger than 20 MB',
          'URL_TOO_LARGE',
        );
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
};

const fallbackNameFor = (url: URL, mimeType: string): string => {
  const base = url.pathname.split('/').filter(Boolean).pop() ?? '';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
  if (cleaned.includes('.')) return cleaned;
  const extension = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
  return `${cleaned || 'imported-image'}.${extension}`;
};

/** Downloads a remote raster image with SSRF, size, and redirect guards. */
export const fetchImageFromUrl = async (
  rawUrl: string,
): Promise<{ buffer: Buffer; filename: string; mimeType: string }> => {
  let nextUrl = rawUrl.trim();
  if (!/^https?:\/\//i.test(nextUrl)) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Image URL must use http or https', 'URL_INVALID');
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(nextUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new AppError(httpStatus.BAD_REQUEST, 'Image URL must use http or https', 'URL_INVALID');
    }
    await assertPublicHost(parsed.hostname);

    let response: Response;
    try {
      response = await fetch(parsed, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'image/*', 'user-agent': 'TraceCraftBot/1.0' },
      });
    } catch {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Could not fetch the image URL',
        'URL_UNREACHABLE',
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          'Image URL redirect has no target',
          'URL_INVALID',
        );
      }
      nextUrl = new URL(location, parsed).toString();
      continue;
    }

    if (!response.ok) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Image URL responded with ${response.status}`,
        'URL_UNREACHABLE',
      );
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMPORT_BYTES) {
      throw new AppError(
        httpStatus.REQUEST_ENTITY_TOO_LARGE,
        'Remote image is larger than 20 MB',
        'URL_TOO_LARGE',
      );
    }

    const contentTypeHeader = response.headers.get('content-type') ?? '';
    const contentType = (contentTypeHeader.split(';')[0] ?? '').trim().toLowerCase();
    if (!contentType.startsWith('image/')) {
      throw new AppError(httpStatus.BAD_REQUEST, 'URL does not point to an image', 'URL_NOT_IMAGE');
    }

    const buffer = await readBodyWithLimit(response);
    if (buffer.length === 0) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'The image URL returned an empty file',
        'URL_EMPTY',
      );
    }

    return { buffer, filename: fallbackNameFor(parsed, contentType), mimeType: contentType };
  }

  throw new AppError(
    httpStatus.BAD_REQUEST,
    'Too many redirects for the image URL',
    'URL_REDIRECT_LIMIT',
  );
};
