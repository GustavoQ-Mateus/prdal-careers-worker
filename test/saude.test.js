const assert = require('node:assert/strict');
const test = require('node:test');
const { servidorSaude } = require('../dist/saude');

async function subir(t, sondas, desligando = () => false) {
  const servidor = servidorSaude(sondas, 200, desligando);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  t.after(() => servidor.close());
  return `http://127.0.0.1:${servidor.address().port}`;
}

const ok = (nome) => ({ nome, verificar: async () => {} });
const fora = (nome) => ({ nome, verificar: async () => { throw new Error('fora'); } });

test('health responde sem tocar em dependencia e ready confere postgres e fila', async (t) => {
  const url = await subir(t, [ok('postgres'), ok('fila')]);
  assert.deepEqual(await (await fetch(`${url}/health`)).json(), { service: 'worker', status: 'ok' });
  const ready = await fetch(`${url}/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual((await ready.json()).dependencias.map((d) => [d.nome, d.obrigatoria, d.estado]), [
    ['postgres', true, 'ok'],
    ['fila', true, 'ok'],
  ]);
});

test('fila fora ou desligamento em curso deixam o ready em 503', async (t) => {
  const semFila = await subir(t, [ok('postgres'), fora('fila')]);
  const resposta = await fetch(`${semFila}/ready`);
  assert.equal(resposta.status, 503);
  assert.equal((await resposta.json()).dependencias[1].estado, 'indisponivel');
  const desligando = await subir(t, [ok('postgres'), ok('fila')], () => true);
  assert.equal((await fetch(`${desligando}/ready`)).status, 503);
});
