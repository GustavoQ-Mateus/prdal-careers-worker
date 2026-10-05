import type { PrismaClient } from '@prisma/client';
import type { Armazenamento } from '../clientes';
import { chaveDoCurriculo, ehChave, montarPacote, TIPOS_ARQUIVO } from '../dominio';
import type { JobEmCurso } from '../jobs';
import type { Executor } from '../worker';

export class ExecutorPacote implements Executor {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly armazenamento: Armazenamento,
  ) {}

  async executar(job: JobEmCurso): Promise<unknown> {
    const curriculo = await this.prisma.curriculo.findUnique({
      where: { id: job.referenciaId },
      include: { vaga: { select: { usuarioId: true, titulo: true, empresa: true } } },
    });
    if (!curriculo) return { ignorado: 'curriculo removido' };
    const docx = ehChave(curriculo.docxPath) ? await this.armazenamento.ler(curriculo.docxPath) : null;
    const pdf = ehChave(curriculo.pdfPath) ? await this.armazenamento.ler(curriculo.pdfPath) : null;
    const pacote = await montarPacote(
      { rotulo: curriculo.rotulo, markdown: curriculo.markdown, titulo: curriculo.vaga.titulo, empresa: curriculo.vaga.empresa },
      docx,
      pdf,
    );
    const chave = await this.armazenamento.gravar(chaveDoCurriculo(curriculo.vaga.usuarioId, curriculo.id, 'zip'), pacote, TIPOS_ARQUIVO.zip);
    const { count } = await this.prisma.curriculo.updateMany({
      where: { id: curriculo.id, markdown: curriculo.markdown, docxPath: curriculo.docxPath, pdfPath: curriculo.pdfPath },
      data: { pacotePath: chave },
    });
    return count ? { pacotePath: chave, bytes: pacote.length } : { descartado: 'o curriculo mudou durante o empacotamento' };
  }
}
