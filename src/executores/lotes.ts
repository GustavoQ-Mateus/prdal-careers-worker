import { Prisma, PrismaClient } from '@prisma/client';
import type { Ia } from '../clientes';
import type { JobEmCurso } from '../jobs';
import type { Rag } from '../rag';
import type { Executor } from '../worker';
import { SEM_KEYWORDS } from './keywords';

export const ITEM_SEM_REGISTRO = 'o registro deste item foi removido antes do processamento';

abstract class ExecutorItemDeLote implements Executor {
  constructor(protected readonly prisma: PrismaClient) {}

  protected abstract processar(referencia: string, usuarioId: string): Promise<unknown>;

  protected abstract referencia(item: { bancoVagaId: string | null; documentoRagId: string | null; referenciaLegada: string | null }): string | null;

  async executar(job: JobEmCurso): Promise<unknown> {
    const item = await this.prisma.loteItem.findUnique({ where: { id: job.referenciaId }, include: { lote: { select: { id: true, usuarioId: true } } } });
    if (!item) return { ignorado: 'item removido' };
    if (item.status === 'CONCLUIDO' || item.status === 'ERRO') return { status: item.status };
    await this.prisma.loteItem.update({ where: { id: item.id }, data: { status: 'PROCESSANDO', tentativas: job.tentativas } });
    await this.prisma.lote.updateMany({ where: { id: item.loteId, status: 'PENDENTE' }, data: { status: 'PROCESSANDO' } });
    try {
      const referencia = this.referencia(item);
      if (!referencia) throw new Error(ITEM_SEM_REGISTRO);
      const resultado = await this.processar(referencia, item.lote.usuarioId);
      await this.prisma.$transaction([
        this.prisma.loteItem.update({ where: { id: item.id }, data: { status: 'CONCLUIDO', erro: null, tentativas: job.tentativas } }),
        this.prisma.lote.update({ where: { id: item.loteId }, data: { processados: { increment: 1 } } }),
      ]);
      await this.finalizarLote(item.loteId);
      return resultado ?? null;
    } catch (err) {
      await this.prisma.loteItem.update({ where: { id: item.id }, data: { status: 'PENDENTE', erro: (err as Error).message } });
      throw err;
    }
  }

  async aoEsgotar(job: JobEmCurso, erro: string): Promise<void> {
    const item = await this.prisma.loteItem.findUnique({ where: { id: job.referenciaId } });
    if (!item || item.status === 'CONCLUIDO') return;
    await this.prisma.loteItem.update({ where: { id: item.id }, data: { status: 'ERRO', erro, tentativas: job.tentativas } });
    await this.finalizarLote(item.loteId);
  }

  private async finalizarLote(loteId: string): Promise<void> {
    const abertos = await this.prisma.loteItem.count({ where: { loteId, status: { in: ['PENDENTE', 'PROCESSANDO'] } } });
    if (abertos === 0) await this.prisma.lote.updateMany({ where: { id: loteId, status: { not: 'CONCLUIDO' } }, data: { status: 'CONCLUIDO' } });
  }
}

export class ExecutorImportacao extends ExecutorItemDeLote {
  constructor(
    prisma: PrismaClient,
    private readonly ia: Ia,
  ) {
    super(prisma);
  }

  protected referencia(item: { bancoVagaId: string | null; referenciaLegada: string | null }): string | null {
    return item.bancoVagaId ?? item.referenciaLegada;
  }

  protected async processar(bancoVagaId: string, usuarioId: string): Promise<unknown> {
    const doc = await this.prisma.bancoVaga.findUnique({ where: { id: bancoVagaId } });
    if (!doc) throw new Error('postagem nao encontrada no banco de vagas');
    const extracao = await this.ia.keywords(doc.descricao, usuarioId);
    if (extracao.status !== 'VALIDAS') throw new Error(extracao.degradacao ?? SEM_KEYWORDS);
    const { categoria, nivel } = await this.ia.classificar(doc.titulo, doc.descricao);
    await this.prisma.bancoVaga.update({
      where: { id: bancoVagaId },
      data: { keywords: extracao.keywords as unknown as Prisma.InputJsonValue, keywordsStatus: 'VALIDAS', categoria, nivel },
    });
    return { keywords: extracao.keywords.length, categoria, nivel };
  }
}

export class ExecutorReindexacao extends ExecutorItemDeLote {
  constructor(
    prisma: PrismaClient,
    private readonly rag: Pick<Rag, 'indexar'>,
  ) {
    super(prisma);
  }

  protected referencia(item: { documentoRagId: string | null; referenciaLegada: string | null }): string | null {
    return item.documentoRagId ?? item.referenciaLegada;
  }

  protected async processar(documentoId: string): Promise<unknown> {
    const documento = await this.prisma.documentoRag.findUnique({ where: { id: documentoId } });
    if (!documento) throw new Error('documento nao encontrado');
    const chunks = await this.rag.indexar(documento);
    return { chunks };
  }
}
