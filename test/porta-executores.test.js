const assert = require('node:assert/strict');
const test = require('node:test');
const { ExecutoresHttp, ExecutoresLambda } = require('../dist/porta-executores');
const { ExecutorKeywords } = require('../dist/executores/keywords');

const cota = { verificar: async () => {}, registrar: async () => {} };

test('portas http e lambda devolvem o mesmo resultado e propagam prazo', async () => {
  const anterior = global.fetch;
  const requisicoes = [];
  const resultado = { estado: { resumo: [] }, rejeitadas: [], juiz: 'desligado', uso: { chamadas: 0 } };
  global.fetch = async (url, opcoes) => {
    requisicoes.push([url, opcoes]);
    return new Response(JSON.stringify(resultado), { status: 200 });
  };
  try {
    const env = { AI_SERVICE_URL: 'http://ia', AI_STEP_TIMEOUT_MS: '5001', LAMBDA_GERACAO_VERIFICAR: 'verificar-funcao' };
    const http = new ExecutoresHttp(cota, env);
    const invocacoes = [];
    const lambda = new ExecutoresLambda(cota, {
      send: async (comando, opcoes) => {
        invocacoes.push([comando, opcoes]);
        return { Payload: Buffer.from(JSON.stringify(resultado)) };
      },
    }, env, (entrada) => ({ input: entrada }));
    const payload = { perfilMestre: { nome: 'Pessoa' }, chamadasRestantes: 0 };
    assert.deepEqual(await http.executar('verificar', payload, 'u1', 'op1'), await lambda.executar('verificar', payload, 'u1', 'op1'));
    assert.equal(requisicoes[0][0], 'http://ia/geracao/verificar');
    assert.equal(requisicoes[0][1].headers['X-Prdal-Prazo-Ms'], '4001');
    assert.equal(invocacoes[0][0].input.FunctionName, 'verificar-funcao');
    assert.deepEqual(JSON.parse(invocacoes[0][0].input.Payload), { passo: 'verificar', payload, operacao: 'op1', prazoMs: 4001 });
    assert.ok(invocacoes[0][1].abortSignal);
  } finally {
    global.fetch = anterior;
  }
});

test('keywords em lambda voltam ao worker para gravacao no banco', async () => {
  const salvas = [];
  const prisma = {
    vaga: {
      findUnique: async () => ({ id: 'v1', usuarioId: 'u1', descricao: 'Java' }),
      update: async ({ data }) => { salvas.push(data); },
      updateMany: async ({ data }) => { salvas.push(data); return { count: 1 }; },
    },
  };
  const lambda = new ExecutoresLambda(cota, {
    send: async () => ({ Payload: Buffer.from(JSON.stringify({ keywords: [{ termo: 'Java', peso: 1 }], status: 'VALIDAS', degradacao: null })) }),
  }, { LAMBDA_KEYWORDS: 'keywords-funcao' }, (entrada) => ({ input: entrada }));
  const executor = new ExecutorKeywords(prisma, {}, lambda);
  assert.deepEqual(await executor.executar({ id: 'job1', referenciaId: 'v1' }), { keywords: 1 });
  assert.equal(salvas[1].keywordsStatus, 'VALIDAS');
});
