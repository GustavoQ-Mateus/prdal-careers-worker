import { GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { PrismaClient } from '@prisma/client';
import { cabecalhoRequestId } from './contexto';

type Env = Record<string, string | undefined>;

const MARGEM_PRAZO_MS = 1000;
const COTA_PADRAO = 1_000_000;
const PESOS = { entrada: 1, cacheEscrita: 1.25, cacheLida: 0.1, saida: 5 };

export const DEGRADACAO_KEYWORDS_INDISPONIVEIS =
  'A extração de keywords da vaga está indisponível no momento. Tente novamente em instantes.';

function ms(env: Env, nome: string, padrao: number): number {
  const valor = Number(env[nome]);
  return Number.isFinite(valor) && valor > 0 ? valor : padrao;
}

export interface Keyword {
  termo: string;
  peso: number;
}

export interface UsoLlm {
  entrada: number;
  saida: number;
  cacheLida: number;
  cacheEscrita: number;
  chamadas: number;
}

export interface AtsAnalysis {
  score: number;
  keywordsEncontradas: string[];
  keywordsCriticasAusentes: string[];
  pontosEliminatorios: string[];
  veredicto: string;
  breakdown: unknown;
}

export interface FonteContexto {
  id: string;
  tipo: string;
  factual: boolean;
  titulo: string;
  texto: string;
  origem?: string;
  similaridade?: number;
}

export interface ResultadoGeracao {
  markdown: string;
  estrutura?: unknown;
  analiseInicial: AtsAnalysis;
  analiseFinal: AtsAnalysis;
  degradacao: string | null;
  promptVersion?: string | null;
  modelo?: string | null;
  uso?: UsoLlm | null;
}

export interface ExtracaoKeywords {
  keywords: Keyword[];
  status: 'VALIDAS' | 'PENDENTE';
  degradacao: string | null;
}

export interface EmbeddingDocumentos {
  modelo: string;
  dimensao: number;
  chunks: { documentoId: string; indice: number; fonteId: string; texto: string; vetor: number[] }[];
}

export interface EmbeddingConsultas {
  modelo: string;
  dimensao: number;
  limiar: number;
  vetores: number[][];
}

export class ErroDoServico extends Error {
  constructor(
    readonly servico: string,
    readonly status: number,
    detalhe: string,
    readonly corpo: unknown,
  ) {
    super(`${servico} respondeu ${status}${detalhe ? `: ${detalhe}` : ''}`);
  }
}

export class CotaEsgotada extends Error {
  constructor() {
    super('o limite diario de uso do assistente de IA foi atingido; o limite volta a valer a meia-noite (UTC)');
  }
}

function cabecalhoServico(env: Env): Record<string, string> {
  const token = env.SERVICE_TOKEN?.trim();
  return token ? { 'X-Prdal-Servico': token } : {};
}

function detalheDo(corpo: unknown): string {
  if (corpo && typeof corpo === 'object') {
    const dados = corpo as Record<string, unknown>;
    const detalhe = dados.detail ?? dados.message ?? dados.mensagem ?? dados.erro;
    if (typeof detalhe === 'string') return detalhe;
    if (detalhe && typeof detalhe === 'object') return JSON.stringify(detalhe).slice(0, 300);
  }
  return typeof corpo === 'string' ? corpo.slice(0, 300) : '';
}

async function lerCorpo(resposta: Response): Promise<unknown> {
  const texto = await resposta.text();
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

export async function postar(
  servico: string,
  url: string,
  corpo: unknown,
  opcoes: { env: Env; timeoutMs: number; cabecalhos?: Record<string, string>; binario?: boolean },
): Promise<unknown> {
  let resposta: Response;
  try {
    resposta = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cabecalhoServico(opcoes.env), ...cabecalhoRequestId(), ...(opcoes.cabecalhos ?? {}) },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(opcoes.timeoutMs),
    });
  } catch (err) {
    throw new Error(`${servico} indisponivel: ${(err as Error).message}`);
  }
  if (!resposta.ok) {
    const dados = await lerCorpo(resposta);
    throw new ErroDoServico(servico, resposta.status, detalheDo(dados), dados);
  }
  if (opcoes.binario) return Buffer.from(await resposta.arrayBuffer());
  return resposta.json();
}

export function diaUtc(agora: Date): Date {
  return new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()));
}

export class CotaTokens {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly env: Env = process.env,
  ) {}

  private limite(): number {
    const bruto = this.env.COTA_TOKENS_DIA?.trim();
    if (!bruto) return COTA_PADRAO;
    const valor = Number(bruto);
    return Number.isFinite(valor) && valor >= 0 ? Math.floor(valor) : COTA_PADRAO;
  }

  async verificar(usuarioId: string): Promise<void> {
    const limite = this.limite();
    if (limite === 0) return;
    const uso = await this.prisma.usoTokensDiario.findUnique({ where: { usuarioId_dia: { usuarioId, dia: diaUtc(new Date()) } } });
    if (!uso) return;
    const consumido = Math.ceil(uso.entrada * PESOS.entrada + uso.cacheEscrita * PESOS.cacheEscrita + uso.cacheLida * PESOS.cacheLida + uso.saida * PESOS.saida);
    if (consumido >= limite) throw new CotaEsgotada();
  }

  async registrar(usuarioId: string, uso: UsoLlm | null | undefined): Promise<void> {
    if (!uso || !uso.chamadas) return;
    const valores = { entrada: uso.entrada ?? 0, saida: uso.saida ?? 0, cacheLida: uso.cacheLida ?? 0, cacheEscrita: uso.cacheEscrita ?? 0, chamadas: uso.chamadas };
    const dia = diaUtc(new Date());
    await this.prisma.usoTokensDiario.upsert({
      where: { usuarioId_dia: { usuarioId, dia } },
      create: { usuarioId, dia, ...valores },
      update: {
        entrada: { increment: valores.entrada },
        saida: { increment: valores.saida },
        cacheLida: { increment: valores.cacheLida },
        cacheEscrita: { increment: valores.cacheEscrita },
        chamadas: { increment: valores.chamadas },
      },
    });
  }
}

export interface Ia {
  gerarCurriculo(payload: unknown, usuarioId: string, operacao: string): Promise<ResultadoGeracao>;
  reduzirCurriculo(payload: unknown, operacao: string): Promise<ResultadoGeracao>;
  keywords(descricao: string, usuarioId: string): Promise<ExtracaoKeywords>;
  classificar(titulo: string, descricao: string): Promise<{ categoria: string; nivel: string }>;
  embeddingDocumentos(documentos: { id: string; origemId: string; tipo: string; texto: string }[]): Promise<EmbeddingDocumentos>;
  embeddingConsultas(consultas: string[]): Promise<EmbeddingConsultas>;
}

export class IaHttp implements Ia {
  private readonly base: string;
  private readonly geracaoMs: number;
  private readonly llmMs: number;

  constructor(
    private readonly cota: CotaTokens,
    private readonly env: Env = process.env,
  ) {
    this.base = env.AI_SERVICE_URL ?? 'http://localhost:8000';
    this.geracaoMs = ms(env, 'AI_GENERATE_TIMEOUT_MS', 300_000);
    this.llmMs = ms(env, 'AI_LLM_TIMEOUT_MS', 60_000);
  }

  private prazo(timeoutMs: number, operacao?: string): Record<string, string> {
    return {
      'X-Prdal-Prazo-Ms': String(Math.max(1, timeoutMs - MARGEM_PRAZO_MS)),
      ...(operacao ? { 'X-Prdal-Operacao': operacao } : {}),
    };
  }

  private async comCota<T extends { uso?: UsoLlm | null }>(usuarioId: string, chamada: () => Promise<T>): Promise<T> {
    await this.cota.verificar(usuarioId);
    try {
      const dados = await chamada();
      await this.cota.registrar(usuarioId, dados.uso).catch(() => undefined);
      return dados;
    } catch (err) {
      const uso = err instanceof ErroDoServico ? (err.corpo as { uso?: UsoLlm } | null)?.uso : undefined;
      if (uso) await this.cota.registrar(usuarioId, uso).catch(() => undefined);
      throw err;
    }
  }

  gerarCurriculo(payload: unknown, usuarioId: string, operacao: string): Promise<ResultadoGeracao> {
    return this.comCota(usuarioId, async () =>
      (await postar('ai-service', `${this.base}/generate-cv-pipeline`, payload, {
        env: this.env,
        timeoutMs: this.geracaoMs,
        cabecalhos: this.prazo(this.geracaoMs, operacao),
      })) as ResultadoGeracao,
    );
  }

  async reduzirCurriculo(payload: unknown, operacao: string): Promise<ResultadoGeracao> {
    return (await postar('ai-service', `${this.base}/reduzir-curriculo`, payload, {
      env: this.env,
      timeoutMs: this.llmMs,
      cabecalhos: this.prazo(this.llmMs, operacao),
    })) as ResultadoGeracao;
  }

  async keywords(descricao: string, usuarioId: string): Promise<ExtracaoKeywords> {
    const dados = await this.comCota(usuarioId, async () =>
      (await postar('ai-service', `${this.base}/keywords`, { descricao }, {
        env: this.env,
        timeoutMs: this.llmMs,
        cabecalhos: this.prazo(this.llmMs),
      })) as { keywords?: Keyword[]; status?: string; degradacao?: string | null; uso?: UsoLlm | null },
    );
    const keywords = dados.keywords ?? [];
    return {
      keywords,
      status: dados.status === 'VALIDAS' && keywords.length ? 'VALIDAS' : 'PENDENTE',
      degradacao: dados.degradacao ?? null,
    };
  }

  async classificar(titulo: string, descricao: string): Promise<{ categoria: string; nivel: string }> {
    return (await postar('ai-service', `${this.base}/classify`, { titulo, descricao }, { env: this.env, timeoutMs: this.llmMs })) as {
      categoria: string;
      nivel: string;
    };
  }

  async embeddingDocumentos(documentos: { id: string; origemId: string; tipo: string; texto: string }[]): Promise<EmbeddingDocumentos> {
    return (await postar('ai-service', `${this.base}/embeddings/documentos`, { documentos }, { env: this.env, timeoutMs: this.llmMs })) as EmbeddingDocumentos;
  }

  async embeddingConsultas(consultas: string[]): Promise<EmbeddingConsultas> {
    return (await postar('ai-service', `${this.base}/embeddings/consultas`, { consultas }, { env: this.env, timeoutMs: this.llmMs })) as EmbeddingConsultas;
  }
}

export interface Documentos {
  renderPdf(markdown: string, template?: string): Promise<Buffer>;
  renderDocx(markdown: string, template?: string): Promise<Buffer>;
}

export class DocumentosHttp implements Documentos {
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(private readonly env: Env = process.env) {
    this.base = env.DOC_SERVICE_URL ?? 'http://localhost:8080';
    this.timeoutMs = ms(env, 'DOC_SERVICE_TIMEOUT_MS', 60_000);
  }

  renderPdf(markdown: string, template?: string): Promise<Buffer> {
    return this.render('pdf', markdown, template);
  }

  renderDocx(markdown: string, template?: string): Promise<Buffer> {
    return this.render('docx', markdown, template);
  }

  private async render(formato: 'pdf' | 'docx', markdown: string, template?: string): Promise<Buffer> {
    return (await postar('doc-service', `${this.base}/render/${formato}`, { markdown, template }, { env: this.env, timeoutMs: this.timeoutMs, binario: true })) as Buffer;
  }
}

export interface Armazenamento {
  gravar(chave: string, dados: Buffer, tipo: string): Promise<string>;
  ler(chave: string): Promise<Buffer>;
  verificar(): Promise<void>;
}

export class ArmazenamentoS3 implements Armazenamento {
  private conexao: { cliente: S3Client; bucket: string } | null = null;

  constructor(private readonly env: Env = process.env) {}

  private conectar() {
    if (!this.conexao) {
      const bucket = this.env.S3_BUCKET?.trim();
      if (!bucket) throw new Error('S3_BUCKET ausente; defina o bucket dos arquivos de curriculo');
      const endpoint = this.env.S3_ENDPOINT?.trim() || undefined;
      this.conexao = {
        bucket,
        cliente: new S3Client({ region: this.env.AWS_REGION?.trim() || 'us-east-1', ...(endpoint ? { endpoint, forcePathStyle: true } : {}) }),
      };
    }
    return this.conexao;
  }

  async gravar(chave: string, dados: Buffer, tipo: string): Promise<string> {
    const { cliente, bucket } = this.conectar();
    await cliente.send(new PutObjectCommand({ Bucket: bucket, Key: chave, Body: dados, ContentType: tipo }));
    return chave;
  }

  async ler(chave: string): Promise<Buffer> {
    const { cliente, bucket } = this.conectar();
    const resposta = await cliente.send(new GetObjectCommand({ Bucket: bucket, Key: chave }));
    return Buffer.from(await resposta.Body!.transformToByteArray());
  }

  async verificar(): Promise<void> {
    const { cliente, bucket } = this.conectar();
    await cliente.send(new HeadBucketCommand({ Bucket: bucket }));
  }
}
