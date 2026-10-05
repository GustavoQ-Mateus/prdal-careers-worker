import { Prisma, PrismaClient, StatusJob, TipoJob } from '@prisma/client';

export interface JobEmCurso {
  id: string;
  tipo: TipoJob;
  status: StatusJob;
  tentativas: number;
  usuarioId: string;
  referenciaId: string;
  requestId: string | null;
  entrada: Prisma.JsonValue | null;
}

export class ErroDefinitivo extends Error {}

export interface JobParaReenviar {
  id: string;
  tipo: TipoJob;
}

export interface JobOrfaoEsgotado extends JobEmCurso {}

export interface RepositorioJobs {
  obterLease(id: string, worker: string, leaseS: number): Promise<JobEmCurso | null>;
  estender(id: string, worker: string, leaseS: number): Promise<boolean>;
  concluir(id: string, worker: string, resultado: unknown): Promise<boolean>;
  liberarComErro(id: string, worker: string, erro: string): Promise<boolean>;
  falharDefinitivo(id: string, worker: string, erro: string): Promise<boolean>;
  devolver(id: string, worker: string): Promise<boolean>;
  criarExclusoesVencidas(limite: number): Promise<JobParaReenviar[]>;
  paraReenviar(pendenteAntigoS: number, reenvioS: number, limite: number): Promise<JobParaReenviar[]>;
  orfaosEsgotados(maxTentativas: number, reenvioS: number, erro: string): Promise<JobOrfaoEsgotado[]>;
  estado(id: string): Promise<StatusJob | null>;
  verificar(): Promise<void>;
}

const AGORA = Prisma.sql`timezone('UTC', now())`;

function emSegundos(segundos: number) {
  return Prisma.sql`make_interval(secs => ${segundos})`;
}

function json(valor: unknown): string | null {
  return valor === undefined ? null : JSON.stringify(valor);
}

export class RepositorioJobsPostgres implements RepositorioJobs {
  constructor(private readonly prisma: PrismaClient) {}

  async obterLease(id: string, worker: string, leaseS: number): Promise<JobEmCurso | null> {
    const linhas = await this.prisma.$queryRaw<JobEmCurso[]>`
      UPDATE jobs
         SET status = 'PROCESSANDO',
             locked_until = ${AGORA} + ${emSegundos(leaseS)},
             locked_by = ${worker},
             tentativas = tentativas + 1,
             iniciado_em = COALESCE(iniciado_em, ${AGORA}),
             atualizado_em = ${AGORA}
       WHERE id = ${id}
         AND (status = 'PENDENTE' OR (status = 'PROCESSANDO' AND locked_until < ${AGORA}))
   RETURNING id, tipo, status, tentativas, usuario_id AS "usuarioId", referencia_id AS "referenciaId",
             request_id AS "requestId", entrada`;
    return linhas[0] ?? null;
  }

  async estender(id: string, worker: string, leaseS: number): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE jobs SET locked_until = ${AGORA} + ${emSegundos(leaseS)}, atualizado_em = ${AGORA}
       WHERE id = ${id} AND status = 'PROCESSANDO' AND locked_by = ${worker}`;
    return n > 0;
  }

  async concluir(id: string, worker: string, resultado: unknown): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE jobs
         SET status = 'CONCLUIDO', resultado = ${json(resultado)}::jsonb, erro = NULL,
             locked_until = NULL, concluido_em = ${AGORA}, atualizado_em = ${AGORA}
       WHERE id = ${id} AND status = 'PROCESSANDO' AND locked_by = ${worker}`;
    return n > 0;
  }

  async liberarComErro(id: string, worker: string, erro: string): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE jobs
         SET status = 'PENDENTE', erro = ${erro}, locked_until = NULL, locked_by = NULL, atualizado_em = ${AGORA}
       WHERE id = ${id} AND status = 'PROCESSANDO' AND locked_by = ${worker}`;
    return n > 0;
  }

  async falharDefinitivo(id: string, worker: string, erro: string): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE jobs
         SET status = 'ERRO', erro = ${erro}, locked_until = NULL, concluido_em = ${AGORA}, atualizado_em = ${AGORA}
       WHERE id = ${id} AND status = 'PROCESSANDO' AND locked_by = ${worker}`;
    return n > 0;
  }

  async devolver(id: string, worker: string): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE jobs
         SET status = 'PENDENTE', tentativas = GREATEST(tentativas - 1, 0), locked_until = NULL, locked_by = NULL,
             atualizado_em = ${AGORA}
       WHERE id = ${id} AND status = 'PROCESSANDO' AND locked_by = ${worker}`;
    return n > 0;
  }

  async criarExclusoesVencidas(limite: number): Promise<JobParaReenviar[]> {
    const usuarios = await this.prisma.usuario.findMany({
      where: { exclusaoAgendadaPara: { lte: new Date() } },
      select: { id: true },
      orderBy: { exclusaoAgendadaPara: 'asc' },
      take: limite,
    });
    const criados: JobParaReenviar[] = [];
    for (const usuario of usuarios) {
      const ativo = await this.prisma.job.findFirst({
        where: { usuarioId: usuario.id, tipo: 'excluir_conta', status: { in: ['PENDENTE', 'PROCESSANDO'] } },
      });
      if (ativo) continue;
      try {
        const job = await this.prisma.job.create({ data: { tipo: 'excluir_conta', usuarioId: usuario.id, referenciaId: usuario.id } });
        criados.push({ id: job.id, tipo: job.tipo });
      } catch (erro) {
        if ((erro as { code?: string }).code !== 'P2002' && (erro as { code?: string }).code !== 'P2003') throw erro;
      }
    }
    return criados;
  }

  async paraReenviar(pendenteAntigoS: number, reenvioS: number, limite: number): Promise<JobParaReenviar[]> {
    return this.prisma.$queryRaw<JobParaReenviar[]>`
      UPDATE jobs SET enfileirado_em = ${AGORA}
       WHERE id IN (
         SELECT id FROM jobs
          WHERE (status = 'PENDENTE'
                 AND ((enfileirado_em IS NULL AND criado_em < ${AGORA} - ${emSegundos(pendenteAntigoS)})
                      OR enfileirado_em < ${AGORA} - ${emSegundos(reenvioS)}))
             OR (status = 'PROCESSANDO' AND locked_until < ${AGORA} - ${emSegundos(reenvioS)}
                 AND (enfileirado_em IS NULL OR enfileirado_em < ${AGORA} - ${emSegundos(reenvioS)}))
          ORDER BY criado_em
          LIMIT ${limite}
          FOR UPDATE SKIP LOCKED)
   RETURNING id, tipo`;
  }

  async orfaosEsgotados(maxTentativas: number, reenvioS: number, erro: string): Promise<JobOrfaoEsgotado[]> {
    return this.prisma.$queryRaw<JobOrfaoEsgotado[]>`
      UPDATE jobs
         SET status = 'ERRO', erro = COALESCE(erro, ${erro}), locked_until = NULL,
             concluido_em = ${AGORA}, atualizado_em = ${AGORA}
       WHERE id IN (
         SELECT id FROM jobs
          WHERE status = 'PROCESSANDO' AND tentativas >= ${maxTentativas}
            AND locked_until < ${AGORA} - ${emSegundos(reenvioS)}
          FOR UPDATE SKIP LOCKED)
   RETURNING id, tipo, status, tentativas, usuario_id AS "usuarioId", referencia_id AS "referenciaId",
             request_id AS "requestId", entrada`;
  }

  async estado(id: string): Promise<StatusJob | null> {
    const job = await this.prisma.job.findUnique({ where: { id }, select: { status: true } });
    return job?.status ?? null;
  }

  async verificar(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }
}
