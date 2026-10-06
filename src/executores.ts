import type { PrismaClient } from '@prisma/client';
import { Armazenamento, CotaTokens, Documentos, criarDocumentos, Ia, IaHttp, ArmazenamentoS3 } from './clientes';
import { ExecutorGeracao } from './executores/geracao';
import { ExecutorKeywords } from './executores/keywords';
import { ExecutorImportacao, ExecutorReindexacao } from './executores/lotes';
import { ExecutorPacote } from './executores/pacote';
import { ExecutorExportacao } from './executores/exportacao';
import { ExecutorExclusao } from './executores/exclusao';
import { Agendador, AgendadorEventBridge, ExecutorLembrete } from './lembretes';
import { Rag } from './rag';
import type { Executores } from './worker';
import { criarPortaExecutores } from './porta-executores';
import type { Executores as PortaExecutores } from './porta-executores';

export interface Dependencias {
  prisma: PrismaClient;
  ia?: Ia;
  documentos?: Documentos;
  armazenamento?: Armazenamento;
  agendador?: Agendador | null;
  passos?: PortaExecutores;
}

export function montarExecutores({ prisma, ia, documentos, armazenamento, agendador, passos }: Dependencias): Executores {
  const clienteIa = ia ?? new IaHttp(new CotaTokens(prisma));
  const porta = passos ?? (ia ? undefined : criarPortaExecutores(new CotaTokens(prisma)));
  const arquivos = armazenamento ?? new ArmazenamentoS3();
  const rag = new Rag(prisma, clienteIa);
  const agendadorLembretes = agendador === undefined
    ? process.env.AGENDADOR_MODO === 'eventbridge' ? new AgendadorEventBridge() : null
    : agendador;
  return {
    gerar_curriculo: new ExecutorGeracao(prisma, clienteIa, documentos ?? criarDocumentos(), arquivos, rag, porta),
    extrair_keywords: new ExecutorKeywords(prisma, clienteIa, porta),
    importar_lote: new ExecutorImportacao(prisma, clienteIa),
    reindexar_contexto: new ExecutorReindexacao(prisma, rag),
    empacotar_curriculo: new ExecutorPacote(prisma, arquivos),
    exportar_dados: new ExecutorExportacao(prisma, arquivos),
    excluir_conta: new ExecutorExclusao(prisma, arquivos, agendadorLembretes),
    sincronizar_lembrete: new ExecutorLembrete(prisma, agendadorLembretes),
  };
}
