import httpStatus from 'http-status';
import config from '../../config/index.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app-error.js';
import { catchAsync } from '../../utils/catch-async.js';
import { sendResponse } from '../../utils/send-response.js';

const vectorizeImage = catchAsync(async (req, res) => {
  const file = req.file;
  if (!file) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Please upload a raster image file.',
      'IMAGE_REQUIRED',
    );
  }

  // Enforce plan credits if authenticated user is on FREE plan
  let isUnlimited = false;
  let currentCredits: number | null = null;

  if (req.user?.id) {
    const dbUser = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, plan: true, credits: true, role: true },
    });

    if (!dbUser) {
      throw new AppError(httpStatus.UNAUTHORIZED, 'User not found');
    }

    isUnlimited = dbUser.plan === 'PRO' || dbUser.role === 'ADMIN';
    currentCredits = dbUser.credits;

    if (!isUnlimited && dbUser.credits <= 0) {
      throw new AppError(
        httpStatus.FORBIDDEN,
        'You have used all 5 free credits. Upgrade to Pro for unlimited vector exports.',
        'OUT_OF_CREDITS',
      );
    }
  }

  const modeRaw = String(req.body?.mode || 'auto').toLowerCase();
  const mode = ['auto', 'binary', 'color'].includes(modeRaw) ? modeRaw : 'auto';
  const includeBg = String(req.body?.includeBg ?? 'true') !== 'false';

  const form = new FormData();
  const blob = new Blob([new Uint8Array(file.buffer)], { type: file.mimetype });
  form.append('file', blob, file.originalname || 'input.png');
  form.append('mode', mode);
  form.append('include_bg', includeBg ? 'true' : 'false');

  let engineRes: Response;
  try {
    engineRes = await fetch(`${config.vectorizer_engine_url.replace(/\/$/, '')}/vectorize`, {
      method: 'POST',
      body: form,
    });
  } catch {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Vectorization engine is unreachable. Please ensure the engine service is running on port 8000.',
      'ENGINE_UNAVAILABLE',
    );
  }

  if (!engineRes.ok) {
    const errText = await engineRes.text().catch(() => '');
    throw new AppError(
      httpStatus.BAD_GATEWAY,
      `Vectorization engine error (${engineRes.status}): ${errText || 'Unknown error'}`,
      'ENGINE_ERROR',
    );
  }

  const data = (await engineRes.json()) as {
    svg: string;
    stats: Record<string, unknown>;
  };

  // Deduct 1 credit for FREE plan user after successful conversion
  let remainingCredits = currentCredits;
  if (req.user?.id && !isUnlimited) {
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { credits: { decrement: 1 } },
      select: { credits: true },
    });
    remainingCredits = updated.credits;
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Image vectorized successfully',
    data: {
      ...data,
      quota: {
        unlimited: isUnlimited,
        remainingCredits,
      },
    },
  });
});

export const vectorizeController = {
  vectorizeImage,
};
