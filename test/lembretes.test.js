const assert = require('node:assert/strict');
const test = require('node:test');
const { ExecutorLembrete, VarreduraLembretes, nomeAgendamento, AgendadorEventBridge } = require('../dist/lembretes');
const { ExecutorExclusao } = require('../dist/executores/exclusao');
const { ResourceNotFoundException } = require('@aws-sdk/client-scheduler');

function acao(alteracoes = {}) {
  return { id: 'abc', titulo: 'Responder', lembrarEm: new Date('2026-10-06T12:00:00Z'), concluidaEm: null, canceladaEm: null, lembreteEnviadoEm: null, usuario: { email: 'a@exemplo.com' }, vaga: { titulo: 'Engenharia', empresa: 'Empresa' }, ...alteracoes };
}

test('executor cria, troca e apaga pelo nome da acao', async () => {
  const chamadas = [];
  let atual = acao();
  const prisma = { acaoOportunidade: { findUnique: async () => atual } };
  const agendador = { salvar: async (...args) => chamadas.push(['salvar', ...args]), apagar: async (nome) => chamadas.push(['apagar', nome]) };
  const executor = new ExecutorLembrete(prisma, agendador);
  await executor.executar({ referenciaId: 'abc' });
  atual = acao({ lembrarEm: new Date('2026-10-07T12:00:00Z') });
  await executor.executar({ referenciaId: 'abc' });
  atual = acao({ canceladaEm: new Date() });
  await executor.executar({ referenciaId: 'abc' });
  assert.deepEqual(chamadas.map((c) => [c[0], c[1]]), [['salvar', 'acao-abc'], ['salvar', 'acao-abc'], ['apagar', 'acao-abc']]);
  assert.equal(chamadas[1][2].toISOString(), '2026-10-07T12:00:00.000Z');
});

test('EventBridge atualiza, cria se ausente e remove idempotente', async () => {
  const chamadas = [];
  const cliente = { send: async (comando) => {
    chamadas.push(comando.constructor.name);
    if (comando.constructor.name === 'CreateScheduleCommand') {
      assert.equal(comando.input.ActionAfterCompletion, 'DELETE');
      assert.equal(comando.input.ScheduleExpression, 'at(2026-10-06T12:00:00)');
    }
    if (comando.constructor.name === 'UpdateScheduleCommand') throw new ResourceNotFoundException({ message: 'ausente', $metadata: {} });
  } };
  const agendador = new AgendadorEventBridge(cliente, 'arn:lambda', 'arn:role');
  await agendador.salvar('acao-abc', new Date('2026-10-06T12:00:00Z'), { acaoId: 'abc', email: 'a@exemplo.com', titulo: 'T', oportunidade: 'V', data: '2026-10-06T12:00:00Z' });
  await agendador.apagar('acao-abc');
  assert.deepEqual(chamadas, ['UpdateScheduleCommand', 'CreateScheduleCommand', 'DeleteScheduleCommand']);
});

test('modo local envia uma vez e marca apos envio', async () => {
  let atual = acao({ lembrarEm: new Date('2026-10-01T12:00:00Z') });
  let envios = 0;
  const tx = { $queryRaw: async () => [{ id: atual.id }], acaoOportunidade: { findUnique: async () => atual, update: async ({ data }) => { atual = { ...atual, ...data }; } } };
  const prisma = { acaoOportunidade: { findMany: async () => atual.lembreteEnviadoEm ? [] : [{ id: atual.id }] }, $transaction: async (fn) => fn(tx) };
  const varredura = new VarreduraLembretes(prisma, { enviar: async () => { envios += 1; } });
  assert.equal(await varredura.executar(), 1);
  assert.equal(await varredura.executar(), 0);
  assert.equal(envios, 1);
});

test('exclusao apaga agendamentos antes da conta', async () => {
  const ordem = [];
  const prisma = { usuario: { findFirst: async () => ({ id: 'u1' }), deleteMany: async () => { ordem.push('banco'); return { count: 1 }; } }, acaoOportunidade: { findMany: async () => [{ id: 'a1' }, { id: 'a2' }] } };
  const armazenamento = { apagarPrefixo: async () => ordem.push('s3') };
  const agendador = { apagar: async (nome) => ordem.push(nome) };
  await new ExecutorExclusao(prisma, armazenamento, agendador).executar({ usuarioId: 'u1' });
  assert.deepEqual(ordem, [nomeAgendamento('a1'), nomeAgendamento('a2'), 's3', 'banco']);
});
