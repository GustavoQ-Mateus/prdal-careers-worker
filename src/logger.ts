import { requestIdAtual } from './contexto';

export type Nivel = 'log' | 'warn' | 'error';
export type Escritor = (linha: string) => void;

const escritorPadrao: Escritor = (linha) => process.stdout.write(`${linha}\n`);

export class Logger {
  constructor(
    private readonly contexto: string,
    private readonly escrever: Escritor = escritorPadrao,
  ) {}

  log(mensagem: string, campos: Record<string, unknown> = {}) {
    this.registrar('log', mensagem, campos);
  }

  warn(mensagem: string, campos: Record<string, unknown> = {}) {
    this.registrar('warn', mensagem, campos);
  }

  error(mensagem: string, campos: Record<string, unknown> = {}) {
    this.registrar('error', mensagem, campos);
  }

  private registrar(nivel: Nivel, mensagem: string, campos: Record<string, unknown>) {
    const { requestId: explicito, ...resto } = campos;
    const requestId = (explicito as string | undefined) ?? requestIdAtual();
    this.escrever(
      JSON.stringify({
        horario: new Date().toISOString(),
        nivel,
        servico: 'worker',
        contexto: this.contexto,
        ...(requestId ? { requestId } : {}),
        mensagem,
        ...resto,
      }),
    );
  }
}
