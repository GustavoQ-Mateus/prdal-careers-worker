import { Prisma, PrismaClient } from '@prisma/client';
import type { Ia } from '../clientes';
import type { JobEmCurso } from '../jobs';
import type { Executor } from '../worker';

export const SEM_KEYWORDS = 'a extracao de keywords nao retornou termos validos';

export class ExecutorKeywords implements Executor {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ia: Ia,
  ) {}

  async executar(job: JobEmCurso): Promise<unknown> {
    const vaga = await this.prisma.vaga.findUnique({ where: { id: job.referenciaId }, select: { id: true, usuarioId: true, descricao: true } });
    if (!vaga) return { ignorado: 'oportunidade removida' };
    await this.prisma.vaga.update({ where: { id: vaga.id }, data: { keywordsExtracao: 'EXTRAINDO' } });
    try {
      const extracao = await this.ia.keywords(vaga.descricao, vaga.usuarioId);
      if (extracao.status !== 'VALIDAS') throw new Error(extracao.degradacao ?? SEM_KEYWORDS);
      const { count } = await this.prisma.vaga.updateMany({
        where: { id: vaga.id, descricao: vaga.descricao },
        data: {
          keywords: extracao.keywords as unknown as Prisma.InputJsonValue,
          keywordsStatus: 'VALIDAS',
          keywordsExtracao: 'PRONTAS',
          keywordsErro: null,
        },
      });
      return count ? { keywords: extracao.keywords.length } : { descartado: 'a descricao mudou durante a extracao' };
    } catch (err) {
      await this.prisma.vaga.updateMany({ where: { id: vaga.id, keywordsExtracao: 'EXTRAINDO' }, data: { keywordsExtracao: 'PENDENTE' } });
      throw err;
    }
  }

  async aoEsgotar(job: JobEmCurso, erro: string): Promise<void> {
    await this.prisma.vaga.updateMany({
      where: { id: job.referenciaId, keywordsExtracao: { not: 'PRONTAS' } },
      data: { keywordsExtracao: 'ERRO', keywordsErro: erro },
    });
  }
}
