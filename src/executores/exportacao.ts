import { PrismaClient } from '@prisma/client';
import archiver from 'archiver';
import type { Armazenamento } from '../clientes';
import type { JobEmCurso } from '../jobs';
import type { Executor } from '../worker';

export async function dadosDaConta(prisma: PrismaClient, usuarioId: string) {
  const conta = await prisma.usuario.findUnique({
    where: { id: usuarioId },
    select: { id: true, email: true, criadoEm: true, consentimentoLlmEm: true, exclusaoAgendadaPara: true },
  });
  if (!conta) throw new Error('conta nao encontrada para exportacao');
  const [perfil, oportunidades, acoes, eventos, geracoes, pipelinesAts, eventosPipelineAts, conversas, notas, documentosRag, preferencias, usoTokens, lotes, jobs] = await Promise.all([
    prisma.perfilMestre.findUnique({ where: { usuarioId } }),
    prisma.vaga.findMany({ where: { usuarioId } }),
    prisma.acaoOportunidade.findMany({ where: { usuarioId } }),
    prisma.eventoOportunidade.findMany({ where: { usuarioId } }),
    prisma.geracaoCurriculo.findMany({ where: { usuarioId } }),
    prisma.pipelineAts.findMany({ where: { usuarioId } }),
    prisma.eventoPipelineAts.findMany({ where: { usuarioId } }),
    prisma.copilotoConversa.findMany({ where: { usuarioId } }),
    prisma.notaObsidian.findMany({ where: { usuarioId } }),
    prisma.documentoRag.findMany({ where: { usuarioId } }),
    prisma.preferenciaUsuario.findUnique({ where: { usuarioId } }),
    prisma.usoTokensDiario.findMany({ where: { usuarioId } }),
    prisma.lote.findMany({ where: { usuarioId } }),
    prisma.job.findMany({ where: { usuarioId } }),
  ]);
  const oportunidadeIds = oportunidades.map(({ id }) => id);
  const conversaIds = conversas.map(({ id }) => id);
  const documentoIds = documentosRag.map(({ id }) => id);
  const loteIds = lotes.map(({ id }) => id);
  const [curriculos, candidaturas, mensagensCopiloto, confirmacoesCopiloto, turnosCopiloto, chunksRag, loteItens] = await Promise.all([
    prisma.curriculo.findMany({ where: { vagaId: { in: oportunidadeIds } } }),
    prisma.candidatura.findMany({ where: { vagaId: { in: oportunidadeIds } } }),
    prisma.copilotoMensagem.findMany({ where: { conversaId: { in: conversaIds } } }),
    prisma.copilotoConfirmacao.findMany({ where: { conversaId: { in: conversaIds } } }),
    prisma.turnoCopiloto.findMany({ where: { conversaId: { in: conversaIds } } }),
    prisma.chunkRag.findMany({ where: { documentoId: { in: documentoIds } }, select: { id: true, documentoId: true, usuarioId: true, indice: true, fonteId: true, texto: true, modelo: true, criadoEm: true } }),
    prisma.loteItem.findMany({ where: { loteId: { in: loteIds } } }),
  ]);
  return {
    conta, perfil, oportunidades, candidaturas, acoes, eventos, curriculos, geracoes,
    pipelinesAts, eventosPipelineAts, conversas, mensagensCopiloto, confirmacoesCopiloto,
    turnosCopiloto, notas, documentosRag, chunksRag, preferencias, usoTokens, lotes, loteItens, jobs,
  };
}

export function chavesDosArquivos(usuarioId: string, curriculos: { pdfPath: string | null; docxPath: string | null; pacotePath: string | null }[]): string[] {
  const prefixo = `usuarios/${usuarioId}/`;
  return [...new Set(curriculos.flatMap((curriculo) => [curriculo.pdfPath, curriculo.docxPath, curriculo.pacotePath])
    .filter((chave): chave is string => !!chave && chave.startsWith(prefixo) && !chave.includes('..')))];
}

export function montarExportacao(dados: Awaited<ReturnType<typeof dadosDaConta>>, arquivos: { chave: string; dados: Buffer }[], usuarioId: string): Promise<Buffer> {
  return new Promise((resolver, rejeitar) => {
    const zip = archiver('zip', { zlib: { level: 9 } });
    const partes: Buffer[] = [];
    zip.on('data', (parte: Buffer) => partes.push(parte));
    zip.on('error', rejeitar);
    zip.on('end', () => resolver(Buffer.concat(partes)));
    zip.append(JSON.stringify(dados, null, 2), { name: 'dados.json' });
    const prefixo = `usuarios/${usuarioId}/`;
    for (const arquivo of arquivos) zip.append(arquivo.dados, { name: `arquivos/${arquivo.chave.slice(prefixo.length)}` });
    void zip.finalize();
  });
}

export class ExecutorExportacao implements Executor {
  constructor(private readonly prisma: PrismaClient, private readonly armazenamento: Armazenamento) {}

  async executar(job: JobEmCurso): Promise<{ chave: string }> {
    const dados = await dadosDaConta(this.prisma, job.usuarioId);
    const chaves = chavesDosArquivos(job.usuarioId, dados.curriculos);
    const arquivos = await Promise.all(chaves.map(async (chave) => ({ chave, dados: await this.armazenamento.ler(chave) })));
    const zip = await montarExportacao(dados, arquivos, job.usuarioId);
    const chave = `usuarios/${job.usuarioId}/exportacoes/${job.id}.zip`;
    await this.armazenamento.gravar(chave, zip, 'application/zip');
    return { chave };
  }
}
