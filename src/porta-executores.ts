import { CotaTokens, ErroDoServico, postar, type UsoLlm } from './clientes';
import { ErroDefinitivo } from './jobs';

type Env = Record<string, string | undefined>;
type EntradaLambda = { FunctionName: string; InvocationType: 'RequestResponse'; Payload: Buffer };
type ClienteLambda = { send(comando: unknown, opcoes: { abortSignal: AbortSignal }): Promise<{ Payload?: Uint8Array; FunctionError?: string }> };
export type Passo = 'rascunho' | 'verificar' | 'reparar' | 'montar' | 'keywords';

export interface Executores {
  executar<T>(passo: Passo, payload: unknown, usuarioId: string, operacao: string): Promise<T>;
}

const NOMES: Record<Passo, string> = {
  rascunho: 'LAMBDA_GERACAO_RASCUNHO',
  verificar: 'LAMBDA_GERACAO_VERIFICAR',
  reparar: 'LAMBDA_GERACAO_REPARAR',
  montar: 'LAMBDA_GERACAO_MONTAR',
  keywords: 'LAMBDA_KEYWORDS',
};

export class ExecutoresHttp implements Executores {
  constructor(private readonly cota: CotaTokens, private readonly env: Env = process.env) {}

  async executar<T>(passo: Passo, payload: unknown, usuarioId: string, operacao: string): Promise<T> {
    const timeoutMs = this.timeout();
    try {
      return await this.comCota(usuarioId, async () => (await postar('ai-service', `${this.env.AI_SERVICE_URL ?? 'http://localhost:8000'}/${passo === 'keywords' ? 'keywords' : `geracao/${passo}`}`, payload, {
        env: this.env,
        timeoutMs,
        cabecalhos: { 'X-Prdal-Prazo-Ms': String(timeoutMs - 1000), 'X-Prdal-Operacao': operacao },
      })) as T);
    } catch (erro) {
      if (erro instanceof ErroDoServico && erro.status === 422) throw new ErroDefinitivo(erro.message);
      throw erro;
    }
  }

  protected timeout(): number {
    const valor = Number(this.env.AI_STEP_TIMEOUT_MS);
    return Number.isFinite(valor) && valor >= 5000 && valor < 900000 ? valor : 120000;
  }

  protected async comCota<T>(usuarioId: string, chamar: () => Promise<T>): Promise<T> {
    await this.cota.verificar(usuarioId);
    try {
      const resposta = await chamar();
      await this.cota.registrar(usuarioId, (resposta as { uso?: UsoLlm | null }).uso).catch(() => undefined);
      return resposta;
    } catch (erro) {
      const uso = erro instanceof ErroDoServico ? (erro.corpo as { uso?: UsoLlm } | null)?.uso : undefined;
      if (uso) await this.cota.registrar(usuarioId, uso).catch(() => undefined);
      throw erro;
    }
  }
}

export class ExecutoresLambda extends ExecutoresHttp {
  constructor(cota: CotaTokens, private readonly cliente: ClienteLambda, private readonly variaveis: Env = process.env, private readonly criarComando: (entrada: EntradaLambda) => unknown = (entrada) => {
    const { InvokeCommand } = require('@aws-sdk/client-lambda');
    return new InvokeCommand(entrada);
  }) {
    super(cota, variaveis);
  }

  override async executar<T>(passo: Passo, payload: unknown, usuarioId: string, operacao: string): Promise<T> {
    const nome = this.variaveis[NOMES[passo]]?.trim();
    if (!nome) throw new Error(`${NOMES[passo]} ausente`);
    const timeoutMs = this.timeout();
    return this.comCota(usuarioId, async () => {
      const resposta = await this.cliente.send(this.criarComando({
        FunctionName: nome,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify({ passo, payload, operacao, prazoMs: timeoutMs - 1000 })),
      }), { abortSignal: AbortSignal.timeout(timeoutMs) });
      const texto = Buffer.from(resposta.Payload ?? []).toString('utf8');
      let dados: unknown;
      try { dados = JSON.parse(texto); } catch { throw new Error(`resposta invalida do executor ${passo}`); }
      if (resposta.FunctionError) throw new Error(`executor ${passo} falhou: ${texto.slice(0, 300)}`);
      if (dados && typeof dados === 'object' && 'erroDefinitivo' in dados) throw new ErroDefinitivo(String(dados.erroDefinitivo));
      return dados as T;
    });
  }
}

export function criarPortaExecutores(cota: CotaTokens, env: Env = process.env): Executores {
  if (env.EXECUTOR_MODO === 'lambda') {
    const { LambdaClient } = require('@aws-sdk/client-lambda');
    return new ExecutoresLambda(cota, new LambdaClient({ region: env.AWS_REGION ?? 'us-east-1' }), env);
  }
  if (!env.EXECUTOR_MODO || env.EXECUTOR_MODO === 'http') return new ExecutoresHttp(cota, env);
  throw new Error(`EXECUTOR_MODO invalido: ${env.EXECUTOR_MODO}`);
}
