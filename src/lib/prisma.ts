import { PrismaClient } from '@prisma/client';

const createClient = () => new PrismaClient();

declare global {
  // eslint-disable-next-line no-var
  var prisma: undefined | ReturnType<typeof createClient>;
}

const prisma = globalThis.prisma ?? createClient();

export default prisma;

// В dev Next.js перезагружает модули на каждое изменение — без синглтона
// пул соединений Postgres исчерпается за десяток горячих перезагрузок.
if (process.env.NODE_ENV !== 'production') globalThis.prisma = prisma;
