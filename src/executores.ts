import type { PrismaClient } from '@prisma/client';
import { Armazenamento, CotaTokens, Documentos, DocumentosHttp, Ia, IaHttp, ArmazenamentoS3 } from './clientes';
import { ExecutorGeracao } from './executores/geracao';
import { ExecutorKeywords } from './executores/keywords';
import { ExecutorImportacao, ExecutorReindexacao } from './executores/lotes';
import { ExecutorPacote } from './executores/pacote';
import { Rag } from './rag';
import type { Executores } from './worker';

export interface Dependencias {
  prisma: PrismaClient;
  ia?: Ia;
  documentos?: Documentos;
  armazenamento?: Armazenamento;
}

export function montarExecutores({ prisma, ia, documentos, armazenamento }: Dependencias): Executores {
  const clienteIa = ia ?? new IaHttp(new CotaTokens(prisma));
  const arquivos = armazenamento ?? new ArmazenamentoS3();
  const rag = new Rag(prisma, clienteIa);
  return {
    gerar_curriculo: new ExecutorGeracao(prisma, clienteIa, documentos ?? new DocumentosHttp(), arquivos, rag),
    extrair_keywords: new ExecutorKeywords(prisma, clienteIa),
    importar_lote: new ExecutorImportacao(prisma, clienteIa),
    reindexar_contexto: new ExecutorReindexacao(prisma, rag),
    empacotar_curriculo: new ExecutorPacote(prisma, arquivos),
  };
}
