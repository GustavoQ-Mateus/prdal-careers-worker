import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { Armazenamento, AtsAnalysis, Documentos, FonteContexto, Ia, Keyword } from '../clientes';
import {
  aplicarNoPipeline,
  anexarConclusaoGeracao,
  chaveDoCurriculo,
  DadosNarracao,
  dadosDaNarracao,
  montarPacote,
  narrar,
  registrarEvento,
  TIPOS_ARQUIVO,
} from '../dominio';
import type { JobEmCurso } from '../jobs';
import { Logger } from '../logger';
import type { Rag } from '../rag';
import type { Executor } from '../worker';

export const DEGRADACAO_CONTEXTO =
  'O histórico de notas e candidaturas não pôde ser consultado agora; o currículo foi gerado só com o perfil-mestre.';
export const DEGRADACAO_RENDERIZACAO =
  'Os arquivos PDF e DOCX não puderam ser gerados agora. O texto do currículo está salvo e você pode gerar os arquivos novamente.';
export const ENTRADA_AUSENTE = 'o pedido de geracao nao trouxe o perfil e a vaga; peca a geracao de novo';

export interface EntradaGeracao {
  perfilMestre: unknown;
  vaga: { titulo: string; empresa: string; descricao: string; keywords: Keyword[] };
  keywords: Keyword[];
}

function mesclarDegradacao(atual: string | null, nova: string | null): string | null {
  const partes = [atual, nova].filter((parte): parte is string => !!parte);
  return partes.length ? partes.join('; ') : null;
}

function contarPaginasPdf(pdf: Buffer): number {
  return pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)?.length ?? 0;
}

export function entradaValida(valor: unknown): EntradaGeracao | null {
  const entrada = valor as Partial<EntradaGeracao> | null;
  if (!entrada || !entrada.perfilMestre || !entrada.vaga || !Array.isArray(entrada.keywords) || !entrada.keywords.length) return null;
  return entrada as EntradaGeracao;
}

interface Renderizacao {
  docxPath: string | null;
  pdfPath: string | null;
  docx: Buffer | null;
  pdf: Buffer | null;
  paginas: number;
  falhou: boolean;
}

export class ExecutorGeracao implements Executor {
  private readonly logger = new Logger('Geracao');

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ia: Ia,
    private readonly documentos: Documentos,
    private readonly armazenamento: Armazenamento,
    private readonly rag: Pick<Rag, 'recuperar'>,
  ) {}

  async executar(job: JobEmCurso): Promise<unknown> {
    const id = job.referenciaId;
    const geracao = await this.prisma.geracaoCurriculo.findUnique({ where: { id }, include: { vaga: true } });
    if (!geracao) return { ignorado: 'geracao removida' };
    if (geracao.status === 'CONCLUIDA' || geracao.status === 'ERRO') return { status: geracao.status, curriculoId: geracao.curriculoId };
    const entrada = entradaValida(job.entrada);
    if (!entrada) throw new Error(ENTRADA_AUSENTE);
    const { perfilMestre, vaga, keywords } = entrada;

    await this.prisma.geracaoCurriculo.update({ where: { id }, data: { status: 'ANALISANDO' } });
    const { contexto, degradacao: degradacaoContexto } = await this.recuperarContexto(geracao.usuarioId, keywords);

    await this.prisma.geracaoCurriculo.update({ where: { id }, data: { status: 'GERANDO' } });
    const pipeline = await this.ia.gerarCurriculo({ perfilMestre, vaga, keywords, contexto }, geracao.usuarioId, `geracao:${id}`);
    await this.prisma.geracaoCurriculo.update({
      where: { id },
      data: {
        analiseInicial: pipeline.analiseInicial as unknown as Prisma.InputJsonValue,
        degradacao: mesclarDegradacao(degradacaoContexto, pipeline.degradacao),
      },
    });
    await this.prisma.geracaoCurriculo.update({
      where: { id },
      data: { status: 'VALIDANDO', analiseFinal: pipeline.analiseFinal as unknown as Prisma.InputJsonValue },
    });
    const versoes = await this.prisma.curriculo.count({ where: { vagaId: geracao.vagaId } });
    const curriculoId = randomUUID();

    let markdown = pipeline.markdown;
    let analiseFinal: AtsAnalysis = pipeline.analiseFinal;
    let degradacao = mesclarDegradacao(degradacaoContexto, pipeline.degradacao);
    let render = await this.renderizar(geracao.usuarioId, curriculoId, markdown);

    let rodadas = 0;
    const estruturaGerada = pipeline.estrutura ?? null;
    let estrutura = estruturaGerada;
    while (render.paginas > 1 && rodadas < 2 && estruturaGerada) {
      rodadas += 1;
      this.logger.warn('curriculo com mais de uma pagina; rodada de corte de conteudo', { curriculoId, paginas: render.paginas, rodada: rodadas });
      try {
        const reducao = await this.ia.reduzirCurriculo({ perfilMestre, vaga, keywords, estrutura: estruturaGerada, nivel: rodadas }, `geracao:${id}`);
        if (reducao.markdown === markdown) break;
        markdown = reducao.markdown;
        analiseFinal = reducao.analiseFinal;
        estrutura = reducao.estrutura ?? estrutura;
        render = await this.renderizar(geracao.usuarioId, curriculoId, markdown);
      } catch (err) {
        this.logger.warn('corte de conteudo indisponivel', { curriculoId, erro: (err as Error).message });
        break;
      }
    }
    if (render.paginas > 1) {
      degradacao = mesclarDegradacao(degradacao, `Curriculo mantido com ${render.paginas} paginas apos ${rodadas} rodada(s) de corte de conteudo`);
    }
    if (render.falhou) degradacao = mesclarDegradacao(degradacao, DEGRADACAO_RENDERIZACAO);

    const rotulo = `${geracao.vaga.empresa} · ${geracao.vaga.titulo}${versoes > 0 ? ` (regeração ${versoes + 1})` : ''}`;
    const pacote = await montarPacote({ rotulo, markdown, titulo: geracao.vaga.titulo, empresa: geracao.vaga.empresa }, render.docx, render.pdf);
    const pacotePath = await this.armazenamento.gravar(chaveDoCurriculo(geracao.usuarioId, curriculoId, 'zip'), pacote, TIPOS_ARQUIVO.zip);

    await this.prisma.$transaction(async (tx) => {
      await tx.curriculo.create({
        data: {
          id: curriculoId,
          vagaId: geracao.vagaId,
          rotulo,
          markdown,
          docxPath: render.docxPath,
          pdfPath: render.pdfPath,
          pacotePath,
          score: analiseFinal.score,
          scoreBreakdown: analiseFinal.breakdown as Prisma.InputJsonValue,
          analiseInicial: pipeline.analiseInicial as unknown as Prisma.InputJsonValue,
          analiseFinal: analiseFinal as unknown as Prisma.InputJsonValue,
          degradacao,
          modelo: pipeline.modelo ?? null,
          promptVersion: pipeline.promptVersion ?? null,
          estrutura: estrutura === null ? Prisma.DbNull : (estrutura as Prisma.InputJsonValue),
        },
      });
      await tx.geracaoCurriculo.update({
        where: { id },
        data: { status: 'CONCLUIDA', curriculoId, erro: null, analiseFinal: analiseFinal as unknown as Prisma.InputJsonValue, degradacao },
      });
      await registrarEvento(tx, {
        usuarioId: geracao.usuarioId,
        vagaId: geracao.vagaId,
        curriculoId,
        tipo: 'CURRICULO_GERADO',
        descricao: 'Curriculo gerado',
        dados: { curriculoId, scoreInicial: pipeline.analiseInicial.score, scoreFinal: analiseFinal.score, degradacao },
      });
    });
    const narracao = dadosDaNarracao(pipeline.analiseInicial, analiseFinal, degradacao);
    await this.semFalhar('pipeline ATS sem transicao', () =>
      aplicarNoPipeline(this.prisma, geracao.usuarioId, geracao.vagaId, { tipo: 'geracao_concluida', jobId: id, curriculoId, narracao }),
    );
    if (narracao) {
      await this.semFalhar('narracao da geracao nao anexada', () => this.anexarNaConversa(geracao.usuarioId, id, curriculoId, narracao));
    }
    return { curriculoId, score: analiseFinal.score, paginas: render.paginas, degradacao };
  }

  async aoEsgotar(job: JobEmCurso, erro: string): Promise<void> {
    const geracao = await this.prisma.geracaoCurriculo.findUnique({ where: { id: job.referenciaId } });
    if (!geracao || geracao.status === 'CONCLUIDA') return;
    await this.prisma.geracaoCurriculo.update({ where: { id: geracao.id }, data: { status: 'ERRO', erro } });
    await this.semFalhar('pipeline ATS sem transicao', () =>
      aplicarNoPipeline(this.prisma, geracao.usuarioId, geracao.vagaId, { tipo: 'geracao_falhou', jobId: geracao.id, erro }),
    );
  }

  private async anexarNaConversa(usuarioId: string, jobId: string, curriculoId: string, dados: DadosNarracao): Promise<void> {
    const curriculo = await this.prisma.curriculo.findUnique({ where: { id: curriculoId } });
    if (!curriculo) return;
    const persistido = {
      id: curriculo.id,
      vagaId: curriculo.vagaId,
      rotulo: curriculo.rotulo,
      score: curriculo.score,
      breakdown: curriculo.scoreBreakdown,
      analiseInicial: curriculo.analiseInicial,
      analiseFinal: curriculo.analiseFinal,
      degradacao: curriculo.degradacao,
    };
    await anexarConclusaoGeracao(this.prisma, usuarioId, jobId, persistido, narrar(dados), dados);
  }

  private async semFalhar(mensagem: string, passo: () => Promise<unknown>): Promise<void> {
    try {
      await passo();
    } catch (err) {
      this.logger.warn(mensagem, { erro: (err as Error).message });
    }
  }

  private async recuperarContexto(usuarioId: string, keywords: Keyword[]): Promise<{ contexto: FonteContexto[]; degradacao: string | null }> {
    const consultas = [...keywords].sort((a, b) => b.peso - a.peso).map((keyword) => keyword.termo);
    if (!consultas.length) return { contexto: [], degradacao: null };
    try {
      const { chunks, degradacao } = await this.rag.recuperar(usuarioId, consultas);
      return { contexto: chunks, degradacao };
    } catch (err) {
      this.logger.warn('degradacao: contexto do rag indisponivel', { codigo: 'contexto_rag_indisponivel', usuarioId, erro: (err as Error).message });
      return { contexto: [], degradacao: DEGRADACAO_CONTEXTO };
    }
  }

  private async renderizar(usuarioId: string, curriculoId: string, markdown: string): Promise<Renderizacao> {
    try {
      let template: string | undefined;
      let pdf = await this.documentos.renderPdf(markdown);
      let paginas = contarPaginasPdf(pdf);
      if (paginas > 1) {
        template = 'compact';
        pdf = await this.documentos.renderPdf(markdown, template);
        paginas = contarPaginasPdf(pdf);
      }
      const docx = await this.documentos.renderDocx(markdown, template);
      const docxPath = await this.armazenamento.gravar(chaveDoCurriculo(usuarioId, curriculoId, 'docx'), docx, TIPOS_ARQUIVO.docx);
      const pdfPath = await this.armazenamento.gravar(chaveDoCurriculo(usuarioId, curriculoId, 'pdf'), pdf, TIPOS_ARQUIVO.pdf);
      return { docxPath, pdfPath, docx, pdf, paginas, falhou: false };
    } catch (err) {
      this.logger.warn('degradacao: renderizacao indisponivel', { codigo: 'renderizacao_doc_service_indisponivel', curriculoId, erro: (err as Error).message });
      return { docxPath: null, pdfPath: null, docx: null, pdf: null, paginas: 0, falhou: true };
    }
  }
}
