import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import config from '../../config/index';
import { passport } from '../../config/passport';
import { auth } from '../../middlewares/auth';
import { validate } from '../../middlewares/validate';
import { authController } from './auth.controller';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resendOtpSchema,
  resendResetOtpSchema,
  resetPasswordSchema,
  updateMeSchema,
  verifyEmailSchema,
  verifyResetOtpSchema,
} from './auth.validation';

export const authRouter = Router();

const authAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    statusCode: 429,
    message: 'Too many authentication attempts. Please try again in 15 minutes.',
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many authentication attempts. Please try again in 15 minutes.',
    },
  },
});

authRouter.post('/register', authAttemptLimiter, validate(registerSchema), authController.registerUser);

authRouter.post('/verify-email', authAttemptLimiter, validate(verifyEmailSchema), authController.verifyEmail);

authRouter.post('/resend-otp', authAttemptLimiter, validate(resendOtpSchema), authController.resendVerificationOtp);

authRouter.post('/forgot-password', authAttemptLimiter, validate(forgotPasswordSchema), authController.forgotPassword);

authRouter.post('/resend-reset-otp', authAttemptLimiter, validate(resendResetOtpSchema), authController.resendResetOtp);

authRouter.post('/verify-reset-otp', authAttemptLimiter, validate(verifyResetOtpSchema), authController.verifyResetOtp);

authRouter.post('/reset-password', authAttemptLimiter, validate(resetPasswordSchema), authController.resetPassword);

authRouter.post(
  '/login',
  authAttemptLimiter,
  validate(loginSchema),
  authController.loginUserWithPassport,
  authController.loginUser,
);

authRouter.post('/refresh-token', validate(refreshSchema), authController.refreshAuthTokens);

authRouter.post('/logout', authController.logoutUser);
authRouter.get('/me', auth(), authController.getMe);

authRouter.patch('/me', auth(), validate(updateMeSchema), authController.updateMe);

authRouter.post(
  '/change-password',
  auth(),
  validate(changePasswordSchema),
  authController.changePassword,
);

authRouter.get('/google', authController.startGoogleLogin);

authRouter.get(
  '/google/callback',
  authController.verifyGoogleLoginState,
  passport.authenticate('google', {
    failureRedirect: `${config.frontend_url || 'http://localhost:3000'}/auth/login?error=google_auth_failed`,
    session: false,
  }),
  authController.googleLoginCallback,
);
