const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { Worker, esperaDaTentativa } = require('../dist/worker');
const { requestIdAtual } = require('../dist/contexto');
const { FilaMemoria } = require('./helpers/fila-memoria');
const { JobsMemoria } = require('./helpers/jobs-memoria');
const { ErroDefinitivo } = require('../dist/jobs');

function opcoes(extra = {}) {
  return {
    id: 'w1',
    concorrencia: 1,
    leaseS: 60,
    esperaS: 0,
    maxTentativas: 3,
    varreduraIntervaloMs: 60_000,
    pendenteAntigoS: 30,
    reenvioS: 600,
    esperaAposErroMs: 5,
    escritor: () => {},
    ...extra,
  };
}

async function ate(condicao, ms = 3000) {
  const limite = Date.now() + ms;
  while (!condicao()) {
    if (Date.now() > limite) throw new Error('condicao nao atingida no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('conclui o job, grava o resultado, apaga a mensagem e loga com o requestId do pedido', async () => {
  const fila = new FilaMemoria();
  const jobs = new JobsMemoria();
  const logs = [];
  jobs.criar({ id: 'j1', tipo: 'extrair_keywords', requestId: 'req-origem' });
  await fila.enviar({ jobId: 'j1', tipo: 'extrair_keywords' });
  let vistoNoContexto;
  const worker = new Worker(fila, jobs, {
    extrair_keywords: { executar: async () => { vistoNoContexto = requestIdAtual(); return { keywords: 3 }; } },
  }, opcoes({ escritor: (l) => logs.push(JSON.parse(l)) }));
  worker.iniciar();
  await ate(() => jobs.jobs.get('j1').status === 'CONCLUIDO');
  await worker.parar(100);
  assert.deepEqual(jobs.jobs.get('j1').resultado, { keywords: 3 });
  assert.equal(fila.mensagens.length, 0);
  assert.equal(vistoNoContexto, 'req-origem');
  const concluido = logs.find((l) => l.mensagem === 'job concluido');
  assert.equal(concluido.requestId, 'req-origem');
  assert.equal(concluido.servico, 'worker');
});

test('duas replicas com mensagem duplicada: so uma processa, a outra descarta sem lease', async () => {
  const fila = new FilaMemoria();
  const jobs = new JobsMemoria();
  jobs.criar({ id: 'j1', tipo: 'gerar_curriculo' });
  await fila.enviar({ jobId: 'j1', tipo: 'gerar_curriculo' });
  await fila.enviar({ jobId: 'j1', tipo: 'gerar_curriculo' });
  const execucoes = [];
  let liberar;
  const travado = new Promise((r) => (liberar = r));
  const executor = (nome) => ({ gerar_curriculo: { executar: async () => { execucoes.push(nome); await travado; } } });
  const logsB = [];
  const a = new Worker(fila, jobs, executor('a'), opcoes({ id: 'a' }));
  const b = new Worker(fila, jobs, executor('b'), opcoes({ id: 'b', escritor: (l) => logsB.push(JSON.parse(l)) }));
  a.iniciar();
  await ate(() => execucoes.length === 1);
  b.iniciar();
  await ate(() => logsB.some((l) => l.mensagem === 'mensagem sem lease descartada'));
  liberar();
  await ate(() => jobs.jobs.get('j1').status === 'CONCLUIDO');
  await Promise.all([a.parar(100), b.parar(100)]);
  assert.deepEqual(execucoes, ['a']);
  assert.equal(fila.mensagens.length, 0);
});

test('falha conta tentativa; na terceira o job fica em erro e a mensagem vai para a fila de mortas', async () => {
  const fila = new FilaMemoria({ maxRecebimentos: 3 });
  const jobs = new JobsMemoria();
  jobs.criar({ id: 'j1', tipo: 'gerar_curriculo' });
  await fila.enviar({ jobId: 'j1', tipo: 'gerar_curriculo' });
  const esgotados = [];
  let chamadas = 0;
  const worker = new Worker(fila, jobs, {
    gerar_curriculo: {
      executar: async () => { chamadas += 1; throw new Error('o servico de IA esta indisponivel'); },
      aoEsgotar: async (job, erro) => esgotados.push([job.id, erro]),
    },
  }, opcoes());
  worker.iniciar();
  await ate(() => jobs.jobs.get('j1').status === 'ERRO');
  await ate(() => fila.mortas.length === 1);
  await worker.parar(100);
  assert.equal(chamadas, 3);
  assert.equal(jobs.jobs.get('j1').tentativas, 3);
  assert.equal(jobs.jobs.get('j1').erro, 'o servico de IA esta indisponivel');
  assert.deepEqual(esgotados, [['j1', 'o servico de IA esta indisponivel']]);
  assert.equal(fila.mortas[0].recebimentos, 3);
});

test('desligamento com job em curso devolve o lease e outro worker retoma sem gastar tentativa', async () => {
  const fila = new FilaMemoria();
  const jobs = new JobsMemoria();
  jobs.criar({ id: 'j1', tipo: 'gerar_curriculo' });
  await fila.enviar({ jobId: 'j1', tipo: 'gerar_curriculo' });
  let iniciou = false;
  const lento = new Worker(fila, jobs, { gerar_curriculo: { executar: () => { iniciou = true; return new Promise(() => {}); } } }, opcoes({ id: 'lento' }));
  lento.iniciar();
  await ate(() => iniciou);
  const resultado = await lento.parar(30);
  assert.deepEqual(resultado, { limpo: false, devolvidos: 1 });
  assert.equal(jobs.jobs.get('j1').status, 'PENDENTE');
  assert.equal(jobs.jobs.get('j1').tentativas, 0);
  const outro = new Worker(fila, jobs, { gerar_curriculo: { executar: async () => 'ok' } }, opcoes({ id: 'outro' }));
  outro.iniciar();
  await ate(() => jobs.jobs.get('j1').status === 'CONCLUIDO');
  await outro.parar(100);
  assert.equal(jobs.jobs.get('j1').tentativas, 1);
  assert.equal(jobs.jobs.get('j1').lockedBy, 'outro');
});

test('desligamento sem job em curso termina limpo e para de receber', async () => {
  const fila = new FilaMemoria();
  const jobs = new JobsMemoria();
  const worker = new Worker(fila, jobs, {}, opcoes());
  worker.iniciar();
  assert.deepEqual(await worker.parar(500), { limpo: true, devolvidos: 0 });
  jobs.criar({ id: 'j1', tipo: 'gerar_curriculo' });
  await fila.enviar({ jobId: 'j1', tipo: 'gerar_curriculo' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(jobs.jobs.get('j1').status, 'PENDENTE');
});

test('varredura reenfileira o job pendente que nunca chegou a fila', async () => {
  const fila = new FilaMemoria();
  const jobs = new JobsMemoria();
  jobs.criar({ id: 'j1', tipo: 'importar_lote' });
  const worker = new Worker(fila, jobs, {}, opcoes());
  assert.equal(await worker.varrer(), 1);
  assert.deepEqual(JSON.parse(fila.mensagens[0].corpo), { jobId: 'j1', tipo: 'importar_lote' });
});

test('exclusao da conta remove o proprio job e confirma a mensagem sem DLQ', async () => {
  const fila = new FilaMemoria();
  const jobs = new JobsMemoria();
  jobs.criar({ id: 'j1', tipo: 'excluir_conta' });
  await fila.enviar({ jobId: 'j1', tipo: 'excluir_conta' });
  const worker = new Worker(fila, jobs, {
    excluir_conta: { executar: async () => { jobs.jobs.delete('j1'); return { excluido: true }; } },
  }, opcoes());
  worker.iniciar();
  await ate(() => fila.mensagens.length === 0);
  await worker.parar(100);
  assert.equal(jobs.jobs.has('j1'), false);
  assert.equal(fila.apagadas, 1);
});

test('falta de consentimento encerra geracao em erro sem nova tentativa', async () => {
  const fila = new FilaMemoria();
  const jobs = new JobsMemoria();
  jobs.criar({ id: 'j1', tipo: 'gerar_curriculo' });
  await fila.enviar({ jobId: 'j1', tipo: 'gerar_curriculo' });
  const erros = [];
  const worker = new Worker(fila, jobs, {
    gerar_curriculo: {
      executar: async () => { throw new ErroDefinitivo('consentimento ausente'); },
      aoEsgotar: async (_job, erro) => erros.push(erro),
    },
  }, opcoes());
  worker.iniciar();
  await ate(() => jobs.jobs.get('j1').status === 'ERRO');
  await worker.parar(100);
  assert.equal(jobs.jobs.get('j1').tentativas, 1);
  assert.deepEqual(erros, ['consentimento ausente']);
  assert.equal(fila.mensagens.length, 0);
});

test('mensagem invalida ou de job inexistente e descartada', async () => {
  const fila = new FilaMemoria();
  const jobs = new JobsMemoria();
  fila.mensagens.push({ id: 99, corpo: 'nao e json', recebimentos: 0, visivelEm: 0 });
  await fila.enviar({ jobId: 'sumiu', tipo: 'gerar_curriculo' });
  const worker = new Worker(fila, jobs, {}, opcoes());
  worker.iniciar();
  await ate(() => fila.mensagens.length === 0);
  await worker.parar(100);
  assert.equal(fila.apagadas, 2);
});

test('espera entre tentativas cresce e tem teto', () => {
  assert.deepEqual([1, 2, 3, 9].map(esperaDaTentativa), [5, 20, 80, 300]);
});

test('o worker nao importa codigo da api nem de outra unidade', () => {
  const pasta = path.resolve(__dirname, '..', 'src');
  const arquivos = fs.readdirSync(pasta, { recursive: true }).filter((f) => String(f).endsWith('.ts'));
  for (const arquivo of arquivos) {
    const texto = fs.readFileSync(path.join(pasta, String(arquivo)), 'utf8');
    assert.doesNotMatch(texto, /from '(\.\.\/)+(\.\.\/)?(api|jobs|lambdas)\//, String(arquivo));
    assert.doesNotMatch(texto, /apps\/(api|jobs|lambdas)/, String(arquivo));
  }
});

test('recebimentos perdidos num poll abortado nao mandam para a fila de mortas um job que ainda tem tentativas', async () => {
  const fila = new FilaMemoria({ maxRecebimentos: 3 });
  const jobs = new JobsMemoria();
  jobs.criar({ id: 'j1', tipo: 'extrair_keywords' });
  await fila.enviar({ jobId: 'j1', tipo: 'extrair_keywords' });
  fila.mensagens[0].recebimentos = 2;
  const tentativas = [];
  const esgotados = [];
  const worker = new Worker(fila, jobs, {
    extrair_keywords: {
      executar: async (job) => { tentativas.push(job.tentativas); throw new Error('sem Claude'); },
      aoEsgotar: async (job) => esgotados.push(job.id),
    },
  }, opcoes());
  worker.iniciar();
  await ate(() => jobs.jobs.get('j1').status === 'ERRO');
  await ate(() => fila.mortas.length === 1);
  await worker.parar(100);
  assert.deepEqual(tentativas, [1, 2, 3]);
  assert.deepEqual(esgotados, ['j1']);
  assert.equal(fila.mensagens.length, 0);
});

test('duplicata de job concluido e apagada; de job em erro segue para a fila de mortas', async () => {
  const fila = new FilaMemoria({ maxRecebimentos: 3 });
  const jobs = new JobsMemoria();
  jobs.criar({ id: 'ok', tipo: 'gerar_curriculo', status: 'CONCLUIDO' });
  jobs.criar({ id: 'falhou', tipo: 'gerar_curriculo', status: 'ERRO' });
  await fila.enviar({ jobId: 'ok', tipo: 'gerar_curriculo' });
  await fila.enviar({ jobId: 'falhou', tipo: 'gerar_curriculo' });
  const worker = new Worker(fila, jobs, {}, opcoes());
  worker.iniciar();
  await ate(() => fila.mensagens.length === 0);
  await worker.parar(100);
  assert.equal(fila.apagadas, 1);
  assert.deepEqual(fila.mortas.map((m) => JSON.parse(m.corpo).jobId), ['falhou']);
});
