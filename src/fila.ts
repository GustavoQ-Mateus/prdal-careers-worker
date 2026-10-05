import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { TipoJob } from '@prisma/client';

export interface MensagemJob {
  jobId: string;
  tipo: TipoJob;
}

export interface MensagemRecebida {
  corpo: string;
  recibo: string;
  recebimentos: number;
}

export interface Fila {
  enviar(mensagem: MensagemJob): Promise<void>;
  receber(esperaS: number, sinal?: AbortSignal): Promise<MensagemRecebida[]>;
  apagar(recibo: string): Promise<void>;
  mudarVisibilidade(recibo: string, segundos: number): Promise<void>;
  verificar(): Promise<void>;
}

export function lerMensagem(corpo: string): MensagemJob | null {
  try {
    const dados = JSON.parse(corpo) as Partial<MensagemJob>;
    return typeof dados.jobId === 'string' && typeof dados.tipo === 'string' ? { jobId: dados.jobId, tipo: dados.tipo } : null;
  } catch {
    return null;
  }
}

export function configuracaoSqs(env: Record<string, string | undefined> = process.env) {
  const url = env.SQS_FILA_JOBS_URL?.trim();
  if (!url) throw new Error('SQS_FILA_JOBS_URL ausente; defina a URL da fila de jobs');
  const endpoint = env.SQS_ENDPOINT?.trim() || undefined;
  return { url, endpoint, regiao: env.AWS_REGION?.trim() || 'us-east-1' };
}

export class FilaSqs implements Fila {
  private readonly cliente: SQSClient;
  private readonly url: string;

  constructor(env: Record<string, string | undefined> = process.env) {
    const { url, endpoint, regiao } = configuracaoSqs(env);
    this.url = url;
    this.cliente = new SQSClient({ region: regiao, ...(endpoint ? { endpoint } : {}) });
  }

  async enviar(mensagem: MensagemJob): Promise<void> {
    await this.cliente.send(new SendMessageCommand({ QueueUrl: this.url, MessageBody: JSON.stringify({ jobId: mensagem.jobId, tipo: mensagem.tipo }) }));
  }

  async receber(esperaS: number, sinal?: AbortSignal): Promise<MensagemRecebida[]> {
    const resposta = await this.cliente.send(
      new ReceiveMessageCommand({
        QueueUrl: this.url,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: esperaS,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
      { abortSignal: sinal },
    );
    return (resposta.Messages ?? [])
      .filter((m) => m.ReceiptHandle)
      .map((m) => ({
        corpo: m.Body ?? '',
        recibo: m.ReceiptHandle!,
        recebimentos: Number(m.Attributes?.ApproximateReceiveCount ?? 1),
      }));
  }

  async apagar(recibo: string): Promise<void> {
    await this.cliente.send(new DeleteMessageCommand({ QueueUrl: this.url, ReceiptHandle: recibo }));
  }

  async mudarVisibilidade(recibo: string, segundos: number): Promise<void> {
    await this.cliente.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.url, ReceiptHandle: recibo, VisibilityTimeout: segundos }));
  }

  async verificar(): Promise<void> {
    await this.cliente.send(new GetQueueAttributesCommand({ QueueUrl: this.url, AttributeNames: ['QueueArn'] }));
  }
}
