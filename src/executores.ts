import type { PrismaClient } from '@prisma/client';
import type { Executores } from './worker';

export interface Dependencias {
  prisma: PrismaClient;
}

export function montarExecutores(_dependencias: Dependencias): Executores {
  return {};
}
