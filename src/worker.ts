import type { TipoJob } from '@prisma/client';
import { comRequestId } from './contexto';
import { Fila, lerMensagem, MensagemRecebida } from './fila';
import { JobEmCurso, RepositorioJobs } from './jobs';
import { Escritor, Logger } from './logger';

export interface Executor {
  executar(job: JobEmCurso): Promise<unknown>;
  aoEsgotar?(job: JobEmCurso, erro: string): Promise<void>;
}

export type Executores = Partial<Record<TipoJob, Executor>>;

export interface OpcoesWorker {
  id: string;
  concorrencia: number;
  leaseS: number;
  esperaS: number;
  maxTentativas: number;
  varreduraIntervaloMs: number;
  pendenteAntigoS: number;
  reenvioS: number;
  esperaAposErroMs?: number;
  visibilidadeInicialS?: number;
  escritor?: Escritor;
}

interface EmCurso {
  job: JobEmCurso;
  recibo: string;
  recebimentos: number;
  promessa: Promise<void>;
  devolvido: boolean;
  batida?: NodeJS.Timeout;
}

const LIMITE_VARREDURA = 50;
const VISIBILIDADE_INICIAL_S = 15;
const ERRO_ORFAO = 'o job parou de responder em todas as tentativas e foi encerrado';

export function esperaDaTentativa(tentativas: number): number {
  return Math.min(5 * 4 ** Math.max(tentativas - 1, 0), 300);
}

export function mensagemDeErro(err: unknown): string {
  const texto = err instanceof Error ? err.message : String(err);
  return texto.trim() || 'falha sem mensagem';
}

function pausa(ms: number, sinal: AbortSignal): Promise<void> {
  return new Promise((resolver) => {
    if (sinal.aborted) return resolver();
    const relogio = setTimeout(resolver, ms);
    sinal.addEventListener('abort', () => {
      clearTimeout(relogio);
      resolver();
    }, { once: true });
  });
}

export class Worker {
  private readonly logger: Logger;
  private readonly parada = new AbortController();
  private readonly emCurso = new Map<string, EmCurso>();
  private lacos: Promise<void>[] = [];
  private varredura: NodeJS.Timeout | null = null;
  private varrendo = false;

  constructor(
    private readonly fila: Fila,
    private readonly jobs: RepositorioJobs,
    private readonly executores: Executores,
    private readonly opcoes: OpcoesWorker,
  ) {
    this.logger = new Logger('Worker', opcoes.escritor);
  }

  iniciar(): void {
    this.lacos = Array.from({ length: this.opcoes.concorrencia }, () => this.laco());
    this.varredura = setInterval(() => void this.varrer(), this.opcoes.varreduraIntervaloMs);
    this.logger.log('worker iniciado', { worker: this.opcoes.id, concorrencia: this.opcoes.concorrencia });
  }

  get parando(): boolean {
    return this.parada.signal.aborted;
  }

  emAndamento(): number {
    return this.emCurso.size;
  }

  async parar(prazoMs: number): Promise<{ limpo: boolean; devolvidos: number }> {
    this.parada.abort();
    if (this.varredura) clearInterval(this.varredura);
    this.logger.log('desligamento iniciado', { prazoMs, emCurso: this.emCurso.size });
    const terminou = Promise.all(this.lacos).then(() => true);
    const esgotou = new Promise<boolean>((resolver) => setTimeout(() => resolver(false), prazoMs).unref());
    const limpo = await Promise.race([terminou, esgotou]);
    let devolvidos = 0;
    for (const atual of [...this.emCurso.values()]) {
      atual.devolvido = true;
      if (atual.batida) clearInterval(atual.batida);
      const devolvido = await this.jobs.devolver(atual.job.id, this.opcoes.id).catch(() => false);
      await this.devolverMensagem(atual, 0).catch(() => undefined);
      if (devolvido) devolvidos += 1;
      this.logger.warn('lease devolvido no desligamento', { jobId: atual.job.id, tipo: atual.job.tipo, requestId: atual.job.requestId ?? undefined });
    }
    this.logger.log('desligamento concluido', { limpo, devolvidos });
    return { limpo, devolvidos };
  }

  async varrer(): Promise<number> {
    if (this.varrendo || this.parando) return 0;
    this.varrendo = true;
    try {
      const esgotados = await this.jobs.orfaosEsgotados(this.opcoes.maxTentativas, this.opcoes.reenvioS, ERRO_ORFAO);
      for (const job of esgotados) await this.esgotar(job, ERRO_ORFAO);
      const pendentes = await this.jobs.paraReenviar(this.opcoes.pendenteAntigoS, this.opcoes.reenvioS, LIMITE_VARREDURA);
      let enviados = 0;
      for (const job of pendentes) {
        try {
          await this.fila.enviar({ jobId: job.id, tipo: job.tipo });
          enviados += 1;
        } catch (err) {
          this.logger.warn('varredura nao reenfileirou o job', { jobId: job.id, erro: mensagemDeErro(err) });
        }
      }
      if (pendentes.length || esgotados.length) {
        this.logger.log('varredura de jobs', { reenfileirados: enviados, encerrados: esgotados.length });
      }
      return enviados;
    } catch (err) {
      this.logger.warn('varredura falhou', { erro: mensagemDeErro(err) });
      return 0;
    } finally {
      this.varrendo = false;
    }
  }

  private async laco(): Promise<void> {
    while (!this.parando) {
      let mensagens: MensagemRecebida[] = [];
      try {
        mensagens = await this.fila.receber(this.opcoes.esperaS, this.opcoes.visibilidadeInicialS ?? VISIBILIDADE_INICIAL_S, this.parada.signal);
      } catch (err) {
        if (this.parando) break;
        this.logger.warn('falha ao receber da fila', { erro: mensagemDeErro(err) });
        await pausa(this.opcoes.esperaAposErroMs ?? 2000, this.parada.signal);
        continue;
      }
      for (const mensagem of mensagens) {
        if (this.parando) {
          await this.fila.mudarVisibilidade(mensagem.recibo, 0).catch(() => undefined);
          continue;
        }
        await this.tratar(mensagem);
      }
    }
  }

  async tratar(mensagem: MensagemRecebida): Promise<void> {
    const corpo = lerMensagem(mensagem.corpo);
    if (!corpo) {
      this.logger.warn('mensagem invalida descartada', { corpo: mensagem.corpo.slice(0, 200) });
      await this.fila.apagar(mensagem.recibo);
      return;
    }
    const job = await this.jobs.obterLease(corpo.jobId, this.opcoes.id, this.opcoes.leaseS);
    if (!job) {
      if ((await this.jobs.estado(corpo.jobId)) === 'ERRO') {
        await this.fila.mudarVisibilidade(mensagem.recibo, 0);
        this.logger.log('mensagem de job em erro devolvida para seguir para a fila de mensagens mortas', { jobId: corpo.jobId, recebimentos: mensagem.recebimentos });
        return;
      }
      this.logger.log('mensagem sem lease descartada', { jobId: corpo.jobId, tipo: corpo.tipo, recebimentos: mensagem.recebimentos });
      await this.fila.apagar(mensagem.recibo);
      return;
    }
    await this.fila.mudarVisibilidade(mensagem.recibo, this.opcoes.leaseS).catch((err) =>
      this.logger.warn('visibilidade da mensagem nao estendida; o lease segue valendo', { jobId: job.id, erro: mensagemDeErro(err) }),
    );
    const atual: EmCurso = { job, recibo: mensagem.recibo, recebimentos: mensagem.recebimentos, devolvido: false, promessa: Promise.resolve() };
    atual.promessa = comRequestId(job.requestId ?? job.id, () => this.executar(atual, mensagem.recebimentos));
    this.emCurso.set(job.id, atual);
    try {
      await atual.promessa;
    } finally {
      this.emCurso.delete(job.id);
    }
  }

  private async executar(atual: EmCurso, recebimentos: number): Promise<void> {
    const { job, recibo } = atual;
    const executor = this.executores[job.tipo];
    const inicio = Date.now();
    this.logger.log('job iniciado', { jobId: job.id, tipo: job.tipo, tentativa: job.tentativas, recebimentos });
    const batida = setInterval(() => void this.renovar(atual), Math.max(1000, Math.floor((this.opcoes.leaseS * 1000) / 3)));
    atual.batida = batida;
    try {
      if (job.tentativas > this.opcoes.maxTentativas) throw new Error(ERRO_ORFAO);
      if (!executor) throw new Error(`nenhum executor para o tipo ${job.tipo}`);
      const resultado = await executor.executar(job);
      clearInterval(batida);
      if (atual.devolvido) return;
      await this.jobs.concluir(job.id, this.opcoes.id, resultado ?? null);
      await this.fila.apagar(recibo);
      this.logger.log('job concluido', { jobId: job.id, tipo: job.tipo, tentativa: job.tentativas, duracaoMs: Date.now() - inicio });
    } catch (err) {
      clearInterval(batida);
      if (atual.devolvido) return;
      const erro = mensagemDeErro(err);
      if (job.tentativas >= this.opcoes.maxTentativas) {
        await this.jobs.falharDefinitivo(job.id, this.opcoes.id, erro);
        await this.fila.mudarVisibilidade(recibo, 0).catch(() => undefined);
        await this.esgotar(job, erro);
        this.logger.error('job falhou em todas as tentativas; a mensagem segue para a fila de mensagens mortas', {
          jobId: job.id,
          tipo: job.tipo,
          tentativa: job.tentativas,
          erro,
        });
        return;
      }
      await this.jobs.liberarComErro(job.id, this.opcoes.id, erro);
      const espera = esperaDaTentativa(job.tentativas);
      await this.devolverMensagem(atual, espera).catch((falha) =>
        this.logger.warn('mensagem nao devolvida a fila; a varredura reenfileira o job', { jobId: job.id, erro: mensagemDeErro(falha) }),
      );
      this.logger.warn('job falhou; nova tentativa depois da espera', { jobId: job.id, tipo: job.tipo, tentativa: job.tentativas, esperaS: espera, erro });
    }
  }

  private async devolverMensagem(atual: EmCurso, esperaS: number): Promise<void> {
    if (atual.recebimentos < this.opcoes.maxTentativas) {
      await this.fila.mudarVisibilidade(atual.recibo, esperaS);
      return;
    }
    await this.fila.enviar({ jobId: atual.job.id, tipo: atual.job.tipo }, esperaS);
    await this.fila.apagar(atual.recibo);
    this.logger.log('mensagem trocada por uma nova: a fila ja contou todos os recebimentos, mas o job ainda tem tentativas', {
      jobId: atual.job.id,
      tentativa: atual.job.tentativas,
      recebimentos: atual.recebimentos,
    });
  }

  private async esgotar(job: JobEmCurso, erro: string): Promise<void> {
    try {
      await comRequestId(job.requestId ?? job.id, () => this.executores[job.tipo]?.aoEsgotar?.(job, erro) ?? Promise.resolve());
    } catch (err) {
      this.logger.warn('estado de erro do objeto do job nao registrado', { jobId: job.id, erro: mensagemDeErro(err) });
    }
  }

  private async renovar(atual: EmCurso): Promise<void> {
    if (atual.devolvido) return;
    try {
      const mantido = await this.jobs.estender(atual.job.id, this.opcoes.id, this.opcoes.leaseS);
      await this.fila.mudarVisibilidade(atual.recibo, this.opcoes.leaseS);
      if (!mantido) this.logger.warn('lease perdido durante o job', { jobId: atual.job.id });
    } catch (err) {
      this.logger.warn('lease nao renovado', { jobId: atual.job.id, erro: mensagemDeErro(err) });
    }
  }
}
