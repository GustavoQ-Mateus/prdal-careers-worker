import { CreateScheduleCommand, DeleteScheduleCommand, ResourceNotFoundException, SchedulerClient, UpdateScheduleCommand } from '@aws-sdk/client-scheduler';
import type { PrismaClient } from '@prisma/client';
import type { JobEmCurso } from './jobs';
import type { Executor } from './worker';

export interface EventoLembrete {
  acaoId: string;
  email: string;
  titulo: string;
  oportunidade: string;
  data: string;
}

export interface Agendador {
  salvar(nome: string, data: Date, evento: EventoLembrete): Promise<void>;
  apagar(nome: string): Promise<void>;
}

export interface EnviadorLembrete {
  enviar(evento: EventoLembrete): Promise<void>;
}

export function nomeAgendamento(acaoId: string): string {
  return `acao-${acaoId}`;
}

export class AgendadorEventBridge implements Agendador {
  constructor(
    private readonly cliente = new SchedulerClient({ region: process.env.AWS_REGION || 'us-east-1' }),
    private readonly alvo = process.env.LEMBRETE_LAMBDA_ARN || '',
    private readonly papel = process.env.SCHEDULER_ROLE_ARN || '',
  ) {
    if (!alvo || !papel) throw new Error('LEMBRETE_LAMBDA_ARN e SCHEDULER_ROLE_ARN obrigatorios');
  }

  async salvar(nome: string, data: Date, evento: EventoLembrete): Promise<void> {
    const entrada = {
      Name: nome,
      ScheduleExpression: `at(${data.toISOString().slice(0, 19)})`,
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' as const },
      ActionAfterCompletion: 'DELETE' as const,
      Target: { Arn: this.alvo, RoleArn: this.papel, Input: JSON.stringify(evento) },
    };
    try {
      await this.cliente.send(new UpdateScheduleCommand(entrada));
    } catch (erro) {
      if (!(erro instanceof ResourceNotFoundException)) throw erro;
      await this.cliente.send(new CreateScheduleCommand(entrada));
    }
  }

  async apagar(nome: string): Promise<void> {
    try {
      await this.cliente.send(new DeleteScheduleCommand({ Name: nome }));
    } catch (erro) {
      if (!(erro instanceof ResourceNotFoundException)) throw erro;
    }
  }
}

export class EnviadorHttp implements EnviadorLembrete {
  constructor(private readonly url = process.env.LEMBRETE_URL || 'http://enviar-lembrete:3002') {}

  async enviar(evento: EventoLembrete): Promise<void> {
    const resposta = await fetch(`${this.url}/enviar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': process.env.SERVICE_TOKEN || '' },
      body: JSON.stringify(evento),
      signal: AbortSignal.timeout(10000),
    });
    if (!resposta.ok) throw new Error(`envio de lembrete falhou: ${resposta.status}`);
  }
}

export class ExecutorLembrete implements Executor {
  constructor(private readonly prisma: PrismaClient, private readonly agendador: Agendador | null) {}

  async executar(job: JobEmCurso): Promise<{ agendado: boolean }> {
    const acao = await this.prisma.acaoOportunidade.findUnique({
      where: { id: job.referenciaId },
      include: { usuario: { select: { email: true } }, vaga: { select: { titulo: true, empresa: true } } },
    });
    const nome = nomeAgendamento(job.referenciaId);
    if (!acao?.lembrarEm || acao.concluidaEm || acao.canceladaEm || acao.lembreteEnviadoEm) {
      await this.agendador?.apagar(nome);
      return { agendado: false };
    }
    if (this.agendador) {
      await this.agendador.salvar(nome, acao.lembrarEm, {
        acaoId: acao.id,
        email: acao.usuario.email,
        titulo: acao.titulo,
        oportunidade: `${acao.vaga.titulo} - ${acao.vaga.empresa}`,
        data: acao.lembrarEm.toISOString(),
      });
    }
    return { agendado: true };
  }
}

export class VarreduraLembretes {
  constructor(private readonly prisma: PrismaClient, private readonly enviador: EnviadorLembrete) {}

  async executar(limite = 50): Promise<number> {
    const acoes = await this.prisma.acaoOportunidade.findMany({
      where: { lembrarEm: { lte: new Date() }, lembreteEnviadoEm: null, concluidaEm: null, canceladaEm: null },
      select: { id: true },
      orderBy: { lembrarEm: 'asc' },
      take: limite,
    });
    let enviados = 0;
    for (const acao of acoes) {
      await this.prisma.$transaction(async (tx) => {
        const linhas = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM acoes_oportunidade WHERE id = ${acao.id} FOR UPDATE`;
        if (!linhas.length) return;
        const atual = await tx.acaoOportunidade.findUnique({
          where: { id: acao.id },
          include: { usuario: { select: { email: true } }, vaga: { select: { titulo: true, empresa: true } } },
        });
        if (!atual?.lembrarEm || atual.lembrarEm > new Date() || atual.lembreteEnviadoEm || atual.concluidaEm || atual.canceladaEm) return;
        await this.enviador.enviar({
          acaoId: atual.id,
          email: atual.usuario.email,
          titulo: atual.titulo,
          oportunidade: `${atual.vaga.titulo} - ${atual.vaga.empresa}`,
          data: atual.lembrarEm.toISOString(),
        });
        await tx.acaoOportunidade.update({ where: { id: atual.id }, data: { lembreteEnviadoEm: new Date() } });
        enviados += 1;
      }, { timeout: 15000 });
    }
    return enviados;
  }
}
