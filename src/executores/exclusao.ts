import type { PrismaClient } from '@prisma/client';
import type { Armazenamento } from '../clientes';
import type { JobEmCurso } from '../jobs';
import type { Executor } from '../worker';

export class ExecutorExclusao implements Executor {
  constructor(private readonly prisma: PrismaClient, private readonly armazenamento: Armazenamento) {}

  async executar(job: JobEmCurso): Promise<{ excluido: boolean }> {
    const where = { id: job.usuarioId, exclusaoAgendadaPara: { lte: new Date() } };
    const usuario = await this.prisma.usuario.findFirst({ where, select: { id: true } });
    if (!usuario) return { excluido: false };
    await this.armazenamento.apagarPrefixo(`usuarios/${job.usuarioId}/`);
    const excluidos = await this.prisma.usuario.deleteMany({ where });
    return { excluido: excluidos.count > 0 };
  }
}
