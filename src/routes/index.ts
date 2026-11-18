import { Router } from 'express';
import { authRouter } from '../modules/auth/auth.routes';
import { subscriptionRouter } from '../modules/subscription/subscription.routes';
import { userRouter } from '../modules/user/user.routes';
import { tracecraftRouter } from '../modules/tracecraft/tracecraft.routes';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/users', userRouter);
apiRouter.use('/subscription', subscriptionRouter);
apiRouter.use('/tracecraft', tracecraftRouter);
