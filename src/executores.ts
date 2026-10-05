import type { PrismaClient } from '@prisma/client';
import { Armazenamento, CotaTokens, Documentos, DocumentosHttp, Ia, IaHttp, ArmazenamentoS3 } from './clientes';
import { ExecutorGeracao } from './executores/geracao';
import { ExecutorKeywords } from './executores/keywords';
import { ExecutorImportacao, ExecutorReindexacao } from './executores/lotes';
import { ExecutorPacote } from './executores/pacote';
import { ExecutorExportacao } from './executores/exportacao';
import { ExecutorExclusao } from './executores/exclusao';
import { Agendador, AgendadorEventBridge, ExecutorLembrete } from './lembretes';
import { Rag } from './rag';
import type { Executores } from './worker';

export interface Dependencias {
  prisma: PrismaClient;
  ia?: Ia;
  documentos?: Documentos;
  armazenamento?: Armazenamento;
  agendador?: Agendador | null;
}

export function montarExecutores({ prisma, ia, documentos, armazenamento, agendador }: Dependencias): Executores {
  const clienteIa = ia ?? new IaHttp(new CotaTokens(prisma));
  const arquivos = armazenamento ?? new ArmazenamentoS3();
  const rag = new Rag(prisma, clienteIa);
  const agendadorLembretes = agendador === undefined
    ? process.env.AGENDADOR_MODO === 'eventbridge' ? new AgendadorEventBridge() : null
    : agendador;
  return {
    gerar_curriculo: new ExecutorGeracao(prisma, clienteIa, documentos ?? new DocumentosHttp(), arquivos, rag),
    extrair_keywords: new ExecutorKeywords(prisma, clienteIa),
    importar_lote: new ExecutorImportacao(prisma, clienteIa),
    reindexar_contexto: new ExecutorReindexacao(prisma, rag),
    empacotar_curriculo: new ExecutorPacote(prisma, arquivos),
    exportar_dados: new ExecutorExportacao(prisma, arquivos),
    excluir_conta: new ExecutorExclusao(prisma, arquivos, agendadorLembretes),
    sincronizar_lembrete: new ExecutorLembrete(prisma, agendadorLembretes),
  };
}
