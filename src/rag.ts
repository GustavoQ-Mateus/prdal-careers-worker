import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { FonteContexto, Ia } from './clientes';

export const TETO_CONSULTAS = 12;
export const TETO_CHUNKS = 20;
export const POR_CONSULTA = 5;
export const DIMENSAO_PADRAO = 384;
export const DEGRADACAO_REINDEXACAO =
  'Parte do histórico de notas e candidaturas ainda não foi reindexada com o modelo atual e ficou fora desta geração.';

export class DimensaoIncompativel extends Error {}

export function dimensaoConfigurada(env: Record<string, string | undefined> = process.env): number {
  const valor = Number(env.EMBED_DIMENSAO);
  return Number.isInteger(valor) && valor > 0 ? valor : DIMENSAO_PADRAO;
}

export function consultasUnicas(consultas: string[]): string[] {
  const vistas = new Set<string>();
  const unicas: string[] = [];
  for (const consulta of consultas) {
    const limpa = consulta.trim();
    const chave = limpa.toLowerCase();
    if (limpa && !vistas.has(chave)) {
      vistas.add(chave);
      unicas.push(limpa);
    }
  }
  return unicas.slice(0, TETO_CONSULTAS);
}

function literalVetor(vetor: number[]): string {
  if (!vetor.every((valor) => Number.isFinite(valor))) throw new DimensaoIncompativel('vetor com valor nao numerico');
  return `[${vetor.join(',')}]`;
}

interface ChunkEncontrado {
  fonteId: string;
  texto: string;
  tipo: string;
  factual: boolean;
  titulo: string;
  origem: string;
  similaridade: number;
}

export class Rag {
  private dimensao: number | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ia: Ia,
  ) {}

  private async exigirDimensao(dimensao: number): Promise<void> {
    if (this.dimensao === null) {
      const linhas = await this.prisma.$queryRaw<{ dimensao: number }[]>`
        SELECT atttypmod AS dimensao FROM pg_attribute
         WHERE attrelid = 'chunks_rag'::regclass AND attname = 'embedding'`;
      const coluna = Number(linhas[0]?.dimensao);
      if (coluna !== dimensaoConfigurada()) {
        throw new DimensaoIncompativel(`a coluna chunks_rag.embedding tem ${coluna} dimensoes e EMBED_DIMENSAO pede ${dimensaoConfigurada()}`);
      }
      this.dimensao = coluna;
    }
    if (dimensao !== this.dimensao) {
      throw new DimensaoIncompativel(`o embedding veio com ${dimensao} dimensoes e o banco guarda ${this.dimensao}`);
    }
  }

  async indexar(documento: { id: string; usuarioId: string; origemId: string; tipo: string; texto: string }): Promise<number> {
    const resposta = await this.ia.embeddingDocumentos([{ id: documento.id, origemId: documento.origemId, tipo: documento.tipo, texto: documento.texto }]);
    await this.exigirDimensao(resposta.dimensao);
    const chunks = resposta.chunks.filter((chunk) => chunk.documentoId === documento.id);
    const linhas = chunks.map(
      (chunk) =>
        Prisma.sql`(${randomUUID()}, ${documento.id}, ${documento.usuarioId}, ${chunk.indice}, ${chunk.fonteId}, ${chunk.texto}, ${resposta.modelo}, ${literalVetor(chunk.vetor)}::vector)`,
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.chunkRag.deleteMany({ where: { documentoId: documento.id } });
      if (!linhas.length) return;
      await tx.$executeRaw`
        INSERT INTO chunks_rag (id, documento_id, usuario_id, indice, fonte_id, texto, modelo, embedding)
        VALUES ${Prisma.join(linhas)}`;
    });
    return chunks.length;
  }

  async recuperar(usuarioId: string, consultas: string[]): Promise<{ chunks: FonteContexto[]; degradacao: string | null }> {
    const unicas = consultasUnicas(consultas);
    if (!unicas.length) return { chunks: [], degradacao: null };
    const { modelo, dimensao, limiar, vetores } = await this.ia.embeddingConsultas(unicas);
    await this.exigirDimensao(dimensao);
    const literais = vetores.map(literalVetor);
    const [encontrados, deOutroModelo] = await Promise.all([
      this.prisma.$queryRaw<ChunkEncontrado[]>`
        SELECT r.*
          FROM unnest(${literais}::text[]) WITH ORDINALITY AS q(v, n)
         CROSS JOIN LATERAL (
           SELECT c.fonte_id AS "fonteId", c.texto, d.tipo::text AS tipo, d.factual, d.titulo, d.origem::text AS origem,
                  1 - (c.embedding <=> q.v::vector) AS similaridade
             FROM chunks_rag c
             JOIN documentos_rag d ON d.id = c.documento_id
            WHERE c.usuario_id = ${usuarioId} AND c.modelo = ${modelo}
            ORDER BY c.embedding <=> q.v::vector
            LIMIT ${POR_CONSULTA}
         ) r
         ORDER BY q.n, r.similaridade DESC`,
      this.prisma.chunkRag.count({ where: { usuarioId, modelo: { not: modelo } } }),
    ]);
    const melhores = new Map<string, FonteContexto & { similaridade: number }>();
    for (const chunk of encontrados) {
      const similaridade = Number(chunk.similaridade);
      if (similaridade < limiar) continue;
      const atual = melhores.get(chunk.fonteId);
      if (atual && atual.similaridade >= similaridade) continue;
      melhores.set(chunk.fonteId, {
        id: chunk.fonteId,
        tipo: chunk.tipo,
        factual: chunk.factual,
        titulo: chunk.titulo,
        texto: chunk.texto,
        origem: chunk.origem,
        similaridade: Math.round(similaridade * 10000) / 10000,
      });
    }
    const ordenados = [...melhores.values()].sort((a, b) => b.similaridade - a.similaridade);
    return { chunks: ordenados.slice(0, TETO_CHUNKS), degradacao: deOutroModelo > 0 ? DEGRADACAO_REINDEXACAO : null };
  }
}
