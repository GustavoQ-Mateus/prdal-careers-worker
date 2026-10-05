import { Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
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
import { ErroDefinitivo, type JobEmCurso } from '../jobs';
import { Logger } from '../logger';
import type { Rag } from '../rag';
import type { Executor } from '../worker';
import type { Executores } from '../porta-executores';

export const DEGRADACAO_CONTEXTO =
  'O histórico de notas e candidaturas não pôde ser consultado agora; o currículo foi gerado só com o perfil-mestre.';
export const DEGRADACAO_RENDERIZACAO =
  'Os arquivos PDF e DOCX não puderam ser gerados agora. O texto do currículo está salvo e você pode gerar os arquivos novamente.';
export const ENTRADA_AUSENTE = 'o pedido de geracao nao trouxe o perfil e a vaga; peca a geracao de novo';
export const CONSENTIMENTO_REVOGADO = 'consentimento para envio de dados ao provedor de IA ausente ou revogado';

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

interface EstadoGeracao {
  curriculoId?: string;
  contexto?: { contexto: FonteContexto[]; degradacao: string | null };
  rascunho?: { rascunho: unknown; promptVersion: string; modelo?: string | null; uso?: { chamadas: number }; requisicoes?: number };
  verificacoes?: { estado: unknown; rejeitadas: unknown[]; uso?: { chamadas: number }; requisicoes?: number }[];
  reparos?: { reparos: unknown[]; uso?: { chamadas: number }; requisicoes?: number }[];
  montagem?: ResultadoPasso;
  cortes?: Record<string, ResultadoPasso>;
  renderizacoes?: Record<string, Omit<Renderizacao, 'docx' | 'pdf'>>;
}

type ResultadoPasso = { markdown: string; estrutura?: unknown; analiseInicial: AtsAnalysis; analiseFinal: AtsAnalysis; degradacao: string | null; promptVersion?: string | null; modelo?: string | null };

export class ExecutorGeracao implements Executor {
  private readonly logger = new Logger('Geracao');

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ia: Ia,
    private readonly documentos: Documentos,
    private readonly armazenamento: Armazenamento,
    private readonly rag: Pick<Rag, 'recuperar'>,
    private readonly passos?: Executores,
  ) {}

  async executar(job: JobEmCurso): Promise<unknown> {
    const id = job.referenciaId;
    const geracao = await this.prisma.geracaoCurriculo.findUnique({ where: { id }, include: { vaga: true } });
    if (!geracao) return { ignorado: 'geracao removida' };
    if (geracao.status === 'CONCLUIDA' || geracao.status === 'ERRO') return { status: geracao.status, curriculoId: geracao.curriculoId };
    const usuario = await this.prisma.usuario.findUnique({ where: { id: geracao.usuarioId }, select: { consentimentoLlmEm: true } });
    if (!usuario?.consentimentoLlmEm) throw new ErroDefinitivo(CONSENTIMENTO_REVOGADO);
    const entrada = entradaValida(job.entrada);
    if (!entrada) throw new Error(ENTRADA_AUSENTE);
    const { perfilMestre, vaga, keywords } = entrada;

    const estado: EstadoGeracao = this.passos ? await this.lerEstado(job.id) : {};
    await this.prisma.geracaoCurriculo.update({ where: { id }, data: { status: 'ANALISANDO' } });
    const contextoSalvo = estado.contexto ?? await this.recuperarContexto(geracao.usuarioId, keywords);
    if (this.passos && !estado.contexto) await this.gravarEstado(job.id, estado, 'contexto', contextoSalvo);
    const { contexto, degradacao: degradacaoContexto } = contextoSalvo;

    await this.prisma.geracaoCurriculo.update({ where: { id }, data: { status: 'GERANDO' } });
    const pipeline = this.passos
      ? await this.gerarEmPassos(job, estado, { perfilMestre, vaga, keywords, contexto })
      : await this.ia.gerarCurriculo!({ perfilMestre, vaga, keywords, contexto }, geracao.usuarioId, `geracao:${id}`);
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
    const curriculoId = estado.curriculoId ?? randomUUID();
    if (this.passos && !estado.curriculoId) await this.gravarEstado(job.id, estado, 'curriculoId', curriculoId);

    let markdown = pipeline.markdown;
    let analiseFinal: AtsAnalysis = pipeline.analiseFinal;
    let degradacao = mesclarDegradacao(degradacaoContexto, pipeline.degradacao);
    let render = await this.renderizarSalvo(job.id, estado, geracao.usuarioId, curriculoId, markdown);

    let rodadas = 0;
    const estruturaGerada = pipeline.estrutura ?? null;
    let estrutura = estruturaGerada;
    while (render.paginas > 1 && rodadas < 2 && estruturaGerada) {
      rodadas += 1;
      this.logger.warn('curriculo com mais de uma pagina; rodada de corte de conteudo', { curriculoId, paginas: render.paginas, rodada: rodadas });
      try {
        let reducao = estado.cortes?.[String(rodadas)];
        if (!reducao) {
          reducao = await this.ia.reduzirCurriculo({ perfilMestre, vaga, keywords, estrutura: estruturaGerada, nivel: rodadas }, `geracao:${id}`);
          if (this.passos) await this.gravarEstado(job.id, estado, 'cortes', { ...estado.cortes, [rodadas]: reducao });
        }
        if (reducao.markdown === markdown) break;
        markdown = reducao.markdown;
        analiseFinal = reducao.analiseFinal;
        estrutura = reducao.estrutura ?? estrutura;
        render = await this.renderizarSalvo(job.id, estado, geracao.usuarioId, curriculoId, markdown);
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

  private async lerEstado(jobId: string): Promise<EstadoGeracao> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId }, select: { resultado: true } });
    const resultado = job?.resultado as { passos?: EstadoGeracao } | null;
    return resultado?.passos ?? {};
  }

  private async gravarEstado<K extends keyof EstadoGeracao>(jobId: string, estado: EstadoGeracao, chave: K, valor: EstadoGeracao[K]): Promise<void> {
    estado[chave] = valor;
    await this.prisma.job.update({ where: { id: jobId }, data: { resultado: { passos: estado } as unknown as Prisma.InputJsonValue } });
  }

  private async gerarEmPassos(job: JobEmCurso, estado: EstadoGeracao, payload: { perfilMestre: unknown; vaga: EntradaGeracao['vaga']; keywords: Keyword[]; contexto: FonteContexto[] }): Promise<ResultadoPasso> {
    const operacao = `geracao:${job.referenciaId}`;
    const usuarioId = job.usuarioId;
    if (!estado.rascunho) {
      const rascunho = await this.passos!.executar<NonNullable<EstadoGeracao['rascunho']>>('rascunho', payload, usuarioId, `${operacao}:rascunho`);
      await this.gravarEstado(job.id, estado, 'rascunho', rascunho);
    }
    let chamadas = estado.rascunho?.requisicoes ?? estado.rascunho?.uso?.chamadas ?? 0;
    const verificacoes = estado.verificacoes ?? [];
    const reparos = estado.reparos ?? [];
    let indice = 0;
    while (true) {
      await this.prisma.geracaoCurriculo.update({ where: { id: job.referenciaId }, data: { status: 'VALIDANDO' } });
      if (!verificacoes[indice]) {
        const anterior = indice > 0 ? verificacoes[indice - 1] : undefined;
        const verificacao = await this.passos!.executar<NonNullable<EstadoGeracao['verificacoes']>[number]>(
          'verificar', {
            ...payload,
            ...(anterior ? { estado: anterior.estado, reparos: reparos[indice - 1].reparos } : { rascunho: estado.rascunho!.rascunho }),
            chamadasRestantes: Math.max(0, 6 - chamadas),
          }, usuarioId, `${operacao}:verificar:${indice}`,
        );
        verificacoes.push(verificacao);
        await this.gravarEstado(job.id, estado, 'verificacoes', verificacoes);
      }
      chamadas += verificacoes[indice].requisicoes ?? verificacoes[indice].uso?.chamadas ?? 0;
      if (!verificacoes[indice].rejeitadas.length || chamadas >= 5) break;
      await this.prisma.geracaoCurriculo.update({ where: { id: job.referenciaId }, data: { status: 'GERANDO' } });
      if (!reparos[indice]) {
        const reparo = await this.passos!.executar<NonNullable<EstadoGeracao['reparos']>[number]>(
          'reparar', { ...payload, estado: verificacoes[indice].estado, chamadasRestantes: 6 - chamadas }, usuarioId, `${operacao}:reparar:${indice}`,
        );
        reparos.push(reparo);
        await this.gravarEstado(job.id, estado, 'reparos', reparos);
      }
      chamadas += reparos[indice].requisicoes ?? reparos[indice].uso?.chamadas ?? 0;
      if (!reparos[indice].reparos.length) break;
      indice += 1;
    }
    await this.prisma.geracaoCurriculo.update({ where: { id: job.referenciaId }, data: { status: 'VALIDANDO' } });
    if (!estado.montagem) {
      const montagem = await this.passos!.executar<ResultadoPasso>(
        'montar', { ...payload, estado: verificacoes[indice].estado }, usuarioId, `${operacao}:montar`,
      );
      montagem.modelo = estado.rascunho?.modelo ?? null;
      montagem.promptVersion = estado.rascunho?.promptVersion ?? null;
      await this.gravarEstado(job.id, estado, 'montagem', montagem);
    }
    return estado.montagem!;
  }

  private async renderizarSalvo(jobId: string, estado: EstadoGeracao, usuarioId: string, curriculoId: string, markdown: string): Promise<Renderizacao> {
    if (!this.passos) return this.renderizar(usuarioId, curriculoId, markdown);
    const chave = createHash('sha256').update(markdown).digest('hex');
    const salva = estado.renderizacoes?.[chave];
    if (salva) {
      const [docx, pdf] = await Promise.all([
        salva.docxPath ? this.armazenamento.ler(salva.docxPath) : Promise.resolve(null),
        salva.pdfPath ? this.armazenamento.ler(salva.pdfPath) : Promise.resolve(null),
      ]);
      return { ...salva, docx, pdf };
    }
    const render = await this.renderizar(usuarioId, curriculoId, markdown);
    const { docx: _docx, pdf: _pdf, ...dados } = render;
    await this.gravarEstado(jobId, estado, 'renderizacoes', { ...estado.renderizacoes, [chave]: dados });
    return render;
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
