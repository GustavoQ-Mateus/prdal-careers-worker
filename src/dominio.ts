import { Prisma, PrismaClient } from '@prisma/client';
import archiver from 'archiver';
import { randomUUID } from 'node:crypto';

type Banco = Prisma.TransactionClient;

export interface DadosNarracao {
  scoreInicial: number;
  scoreFinal: number;
  keywordsEncontradas: string[];
  keywordsAusentesIniciais: string[];
  pontosDeAtencao: string[];
  veredicto: string;
  keywordsCobertas: string[];
  keywordsAusentes: string[];
  degradacao: string | null;
}

export interface MensagensNarracao {
  etapa1: string;
  etapa3: string;
}

interface ResumoAnalise {
  score: number;
  keywordsEncontradas: string[];
  keywordsCriticasAusentes: string[];
  pontosEliminatorios: string[];
  veredicto: string;
}

function lista(valor: unknown): string[] {
  if (!Array.isArray(valor)) return [];
  return valor.map((item) => String(item).trim()).filter(Boolean);
}

function registro(valor: unknown): Record<string, unknown> | null {
  return valor && typeof valor === 'object' && !Array.isArray(valor) ? (valor as Record<string, unknown>) : null;
}

function resumoDaAnalise(analise: unknown): ResumoAnalise | null {
  const dados = registro(analise);
  if (!dados || typeof dados.score !== 'number') return null;
  return {
    score: dados.score,
    keywordsEncontradas: lista(dados.keywordsEncontradas),
    keywordsCriticasAusentes: lista(dados.keywordsCriticasAusentes),
    pontosEliminatorios: lista(dados.pontosEliminatorios),
    veredicto: typeof dados.veredicto === 'string' ? dados.veredicto.trim() : '',
  };
}

export function dadosDaNarracao(analiseInicial: unknown, analiseFinal: unknown, degradacao: string | null): DadosNarracao | null {
  const inicial = resumoDaAnalise(analiseInicial);
  const final = resumoDaAnalise(analiseFinal);
  if (!inicial || !final) return null;
  return {
    scoreInicial: inicial.score,
    scoreFinal: final.score,
    keywordsEncontradas: inicial.keywordsEncontradas,
    keywordsAusentesIniciais: inicial.keywordsCriticasAusentes,
    pontosDeAtencao: inicial.pontosEliminatorios,
    veredicto: inicial.veredicto,
    keywordsCobertas: final.keywordsEncontradas,
    keywordsAusentes: final.keywordsCriticasAusentes,
    degradacao: degradacao?.trim() || null,
  };
}

function itens(valores: string[]): string {
  return valores.length ? valores.join(', ') : 'Nenhuma';
}

export function narrar(dados: DadosNarracao): MensagensNarracao {
  const etapa1 = [
    'Etapa 1: Aderência do perfil-mestre',
    `Score: ${dados.scoreInicial}`,
    `Keywords encontradas: ${itens(dados.keywordsEncontradas)}`,
    `Keywords críticas ausentes: ${itens(dados.keywordsAusentesIniciais)}`,
    ...(dados.pontosDeAtencao.length ? [`Pontos de atenção: ${dados.pontosDeAtencao.join(', ')}`] : []),
    `Veredicto: ${dados.veredicto || 'Sem veredicto informado.'}`,
  ];
  const etapa3 = [
    'Etapa 3: Aderência do currículo gerado',
    `Score: ${dados.scoreFinal}. Para referência, a aderência do perfil-mestre foi ${dados.scoreInicial}.`,
    `Keywords cobertas: ${itens(dados.keywordsCobertas)}`,
    ...(dados.keywordsAusentes.length ? [`Keywords ainda ausentes: ${dados.keywordsAusentes.join(', ')}`] : []),
    ...(dados.degradacao ? [`Observação: ${dados.degradacao}`] : []),
  ];
  return { etapa1: etapa1.join('\n'), etapa3: etapa3.join('\n') };
}

export type EventoGeracao =
  | { tipo: 'geracao_concluida'; jobId: string; curriculoId: string; narracao: DadosNarracao | null }
  | { tipo: 'geracao_falhou'; jobId: string; erro: string };

type EstadoAts = 'SEM_ANALISE' | 'ANALISADA' | 'AGUARDANDO_CONFIRMACAO' | 'GERANDO' | 'CONCLUIDA' | 'FALHOU' | 'DESATUALIZADA';

interface SituacaoAts {
  estado: EstadoAts;
  jobId: string | null;
  curriculoId: string | null;
  perfilAlteradoNaGeracao: boolean;
}

const TENTATIVAS_CONCORRENCIA = 3;

export class TransicaoIgnorada extends Error {}

function situacaoDeLegado(geracao: { id: string; status: string; curriculoId: string | null } | null): SituacaoAts {
  const inicial: SituacaoAts = { estado: 'SEM_ANALISE', jobId: null, curriculoId: null, perfilAlteradoNaGeracao: false };
  if (!geracao) return inicial;
  if (geracao.status === 'CONCLUIDA') return { ...inicial, estado: 'CONCLUIDA', jobId: geracao.id, curriculoId: geracao.curriculoId };
  if (geracao.status === 'ERRO') return { ...inicial, estado: 'FALHOU', jobId: geracao.id };
  return { ...inicial, estado: 'GERANDO', jobId: geracao.id };
}

export function proximaSituacao(atual: SituacaoAts, evento: EventoGeracao): SituacaoAts | null {
  if (atual.estado !== 'GERANDO' || atual.jobId !== evento.jobId) return null;
  if (evento.tipo === 'geracao_falhou') return { ...atual, estado: 'FALHOU', perfilAlteradoNaGeracao: false };
  return {
    ...atual,
    estado: atual.perfilAlteradoNaGeracao ? 'DESATUALIZADA' : 'CONCLUIDA',
    curriculoId: evento.curriculoId,
    perfilAlteradoNaGeracao: false,
  };
}

class VersaoConcorrente extends Error {}

async function aplicarNo(db: Banco, usuarioId: string, vagaId: string, evento: EventoGeracao): Promise<SituacaoAts> {
  const linha = await db.pipelineAts.findUnique({ where: { vagaId } });
  const atual: SituacaoAts = linha
    ? { estado: linha.estado as EstadoAts, jobId: linha.jobId, curriculoId: linha.curriculoId, perfilAlteradoNaGeracao: linha.perfilAlteradoNaGeracao }
    : situacaoDeLegado(
        await db.geracaoCurriculo.findFirst({ where: { usuarioId, vagaId }, orderBy: { criadoEm: 'desc' }, select: { id: true, status: true, curriculoId: true } }),
      );
  const proxima = proximaSituacao(atual, evento);
  if (!proxima) throw new TransicaoIgnorada(`pipeline ATS em ${atual.estado} com job ${atual.jobId ?? 'nenhum'}; esta geracao nao e a que esta em andamento`);
  if (linha) {
    const { count } = await db.pipelineAts.updateMany({ where: { vagaId, versao: linha.versao }, data: { ...proxima, versao: linha.versao + 1 } });
    if (count === 0) throw new VersaoConcorrente();
  } else {
    await db.pipelineAts.create({ data: { vagaId, usuarioId, ...proxima, versao: 1 } });
  }
  await db.eventoPipelineAts.create({
    data: {
      vagaId,
      usuarioId,
      tipo: evento.tipo,
      de: atual.estado,
      para: proxima.estado,
      jobId: evento.jobId,
      dados: (evento.tipo === 'geracao_concluida' ? { curriculoId: evento.curriculoId, narracao: evento.narracao } : { erro: evento.erro }) as unknown as Prisma.InputJsonValue,
    },
  });
  return proxima;
}

export async function aplicarNoPipeline(prisma: PrismaClient, usuarioId: string, vagaId: string, evento: EventoGeracao): Promise<SituacaoAts> {
  for (let tentativa = 1; ; tentativa++) {
    try {
      return await prisma.$transaction((tx) => aplicarNo(tx, usuarioId, vagaId, evento));
    } catch (err) {
      const concorrente = err instanceof VersaoConcorrente || (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002');
      if (!concorrente || tentativa >= TENTATIVAS_CONCORRENCIA) throw err;
    }
  }
}

export function registrarEvento(
  tx: Banco,
  evento: { usuarioId: string; vagaId: string; curriculoId?: string | null; tipo: string; descricao: string; dados?: Prisma.InputJsonValue },
) {
  return tx.eventoOportunidade.create({
    data: {
      usuarioId: evento.usuarioId,
      vagaId: evento.vagaId,
      candidaturaId: null,
      curriculoId: evento.curriculoId ?? null,
      tipo: evento.tipo,
      origem: 'SISTEMA',
      descricao: evento.descricao,
      dados: evento.dados ?? {},
      ocorridoEm: new Date(),
    },
  });
}

export async function anexarConclusaoGeracao(
  prisma: PrismaClient,
  usuarioId: string,
  jobId: string,
  curriculo: Record<string, unknown>,
  narracao: MensagensNarracao,
  dados: DadosNarracao,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const candidatas = await tx.$queryRaw<{ id: string }[]>`
      SELECT c.id FROM copiloto_conversas c
       WHERE c.usuario_id = ${usuarioId}
         AND EXISTS (SELECT 1 FROM copiloto_mensagens m
                      WHERE m.conversa_id = c.id AND m.tool = 'gerar_curriculo'
                        AND m.dados -> 'resultado' ->> 'jobId' = ${jobId})
       ORDER BY c.atualizado_em DESC
       LIMIT 1
       FOR UPDATE`;
    const conversaId = candidatas[0]?.id;
    if (!conversaId) return false;
    const jaAnexada = await tx.$queryRaw<{ existe: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM copiloto_mensagens m
                      WHERE m.conversa_id = ${conversaId}
                        AND m.dados ->> 'origem' = 'geracao_assincrona'
                        AND m.dados ->> 'jobId' = ${jobId}) AS existe`;
    if (jaAnexada[0]?.existe) return false;
    const callId = randomUUID();
    const mensagens = [
      {
        papel: 'tool' as const,
        tool: 'buscar_curriculo',
        conteudo: JSON.stringify(curriculo),
        dados: { callId, efeito: 'leitura', args: { curriculoId: curriculo.id }, ok: true, resultado: curriculo, origem: 'geracao_assincrona', jobId },
      },
      { papel: 'assistant' as const, tool: null, conteudo: narracao.etapa1, dados: { origem: 'geracao_assincrona', jobId, etapa: 1, narracao: dados } },
      { papel: 'assistant' as const, tool: null, conteudo: narracao.etapa3, dados: { origem: 'geracao_assincrona', jobId, etapa: 3 } },
    ];
    const conversa = await tx.copilotoConversa.update({
      where: { id: conversaId },
      data: { totalMensagens: { increment: mensagens.length }, atualizadoEm: new Date() },
      select: { totalMensagens: true },
    });
    const primeira = conversa.totalMensagens - mensagens.length;
    await tx.copilotoMensagem.createMany({
      data: mensagens.map((mensagem, indice) => ({
        conversaId,
        ordem: primeira + indice,
        papel: mensagem.papel,
        conteudo: mensagem.conteudo,
        tool: mensagem.tool,
        dados: mensagem.dados as unknown as Prisma.InputJsonValue,
      })),
    });
    return true;
  });
}

export const TIPOS_ARQUIVO = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  zip: 'application/zip',
} as const;

export function chaveDoCurriculo(usuarioId: string, curriculoId: string, extensao: 'pdf' | 'docx' | 'zip'): string {
  return `usuarios/${usuarioId}/curriculos/${curriculoId}.${extensao}`;
}

export function ehChave(caminho: string | null | undefined): caminho is string {
  return typeof caminho === 'string' && caminho.startsWith('usuarios/');
}

export function nomeArquivo(valor: string): string {
  return valor.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim() || 'Curriculo';
}

export function montarPacote(
  curriculo: { rotulo: string; markdown: string; titulo: string; empresa: string },
  docx: Buffer | null,
  pdf: Buffer | null,
): Promise<Buffer> {
  const pasta = nomeArquivo(`${curriculo.titulo} - ${curriculo.empresa}`);
  const rotulo = nomeArquivo(curriculo.rotulo);
  return new Promise<Buffer>((resolver, rejeitar) => {
    const zip = archiver('zip', { zlib: { level: 9 } });
    const partes: Buffer[] = [];
    zip.on('data', (parte: Buffer) => partes.push(parte));
    zip.on('error', rejeitar);
    zip.on('end', () => resolver(Buffer.concat(partes)));
    zip.append(curriculo.markdown, { name: `${pasta}/Curriculo_${rotulo}.md` });
    if (docx) zip.append(docx, { name: `${pasta}/Curriculo_${rotulo}.docx` });
    if (pdf) zip.append(pdf, { name: `${pasta}/Curriculo_${rotulo}.pdf` });
    void zip.finalize();
  });
}
