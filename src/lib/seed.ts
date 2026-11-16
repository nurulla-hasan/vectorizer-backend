import bcrypt from 'bcryptjs';
import config from '../config/index';
import { prisma } from './prisma';

const DEFAULT_PASSWORD = config.admin_password || '11111111';

export const seed = async (): Promise<void> => {
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 12);

  const adminEmail = config.admin_email || 'admin@example.com';
  const existingAdmin = await prisma.user.findUnique({
    where: { email: adminEmail },
  });

  if (!existingAdmin) {
    await prisma.user.create({
      data: {
        name: config.admin_name || 'System Admin',
        email: adminEmail,
        password: passwordHash,
        role: 'ADMIN',
        emailVerified: true,
        status: 'ACTIVE',
      },
    });
    console.log(`[Seed] Admin created successfully: ${adminEmail}`);
  } else {
    console.log(`[Seed] Admin already exists: ${adminEmail}`);
  }
};

export const seedAdmin = seed;
