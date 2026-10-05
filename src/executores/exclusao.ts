import type { PrismaClient } from '@prisma/client';
import type { Armazenamento } from '../clientes';
import type { JobEmCurso } from '../jobs';
import { Agendador, nomeAgendamento } from '../lembretes';
import type { Executor } from '../worker';

export class ExecutorExclusao implements Executor {
  constructor(private readonly prisma: PrismaClient, private readonly armazenamento: Armazenamento, private readonly agendador: Agendador | null = null) {}

  async executar(job: JobEmCurso): Promise<{ excluido: boolean }> {
    const where = { id: job.usuarioId, exclusaoAgendadaPara: { lte: new Date() } };
    const usuario = await this.prisma.usuario.findFirst({ where, select: { id: true } });
    if (!usuario) return { excluido: false };
    if (this.agendador) {
      const acoes = await this.prisma.acaoOportunidade.findMany({ where: { usuarioId: job.usuarioId, lembrarEm: { not: null } }, select: { id: true } });
      for (const acao of acoes) await this.agendador.apagar(nomeAgendamento(acao.id));
    }
    await this.armazenamento.apagarPrefixo(`usuarios/${job.usuarioId}/`);
    const excluidos = await this.prisma.usuario.deleteMany({ where });
    return { excluido: excluidos.count > 0 };
  }
}
