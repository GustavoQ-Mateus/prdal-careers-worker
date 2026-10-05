const assert = require('node:assert/strict');
const test = require('node:test');
const { inflateRawSync } = require('node:zlib');
const { ExecutorExportacao } = require('../dist/executores/exportacao');
const { ArmazenamentoMemoria } = require('./helpers/armazenamento-memoria');

function entradasZip(buffer) {
  const entradas = new Map();
  for (let pos = 0; pos < buffer.length - 46; pos += 1) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) continue;
    const metodo = buffer.readUInt16LE(pos + 10);
    const tamanho = buffer.readUInt32LE(pos + 20);
    const nomeTamanho = buffer.readUInt16LE(pos + 28);
    const extraTamanho = buffer.readUInt16LE(pos + 30);
    const comentarioTamanho = buffer.readUInt16LE(pos + 32);
    const local = buffer.readUInt32LE(pos + 42);
    const nome = buffer.subarray(pos + 46, pos + 46 + nomeTamanho).toString();
    const inicio = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const conteudo = buffer.subarray(inicio, inicio + tamanho);
    entradas.set(nome, metodo === 8 ? inflateRawSync(conteudo) : conteudo);
    pos += 45 + nomeTamanho + extraTamanho + comentarioTamanho;
  }
  return entradas;
}

test('zip inclui dados e arquivos sem senha, sessoes ou vetores', async () => {
  const armazenamento = new ArmazenamentoMemoria();
  const chavePdf = 'usuarios/u1/curriculos/c1.pdf';
  await armazenamento.gravar(chavePdf, Buffer.from('pdf de teste'), 'application/pdf');
  const linhas = {
    usuario: { id: 'u1', email: 'pessoa@teste.dev', senhaHash: 'segredo', consentimentoLlmEm: null },
    vaga: [{ id: 'v1', usuarioId: 'u1' }],
    curriculo: [{ id: 'c1', vagaId: 'v1', pdfPath: chavePdf, docxPath: null, pacotePath: null }],
    candidatura: [{ id: 'a1', vagaId: 'v1' }],
    copilotoConversa: [{ id: 'cv1', usuarioId: 'u1' }],
    copilotoMensagem: [{ id: 'm1', conversaId: 'cv1', conteudo: 'olá' }],
    documentoRag: [{ id: 'd1', usuarioId: 'u1', texto: 'texto pessoal' }],
    chunkRag: [{ id: 'ch1', documentoId: 'd1', texto: 'trecho', embedding: [1, 2] }],
  };
  const prisma = new Proxy({}, { get: (_, modelo) => ({
    findUnique: async ({ select }) => {
      const linha = linhas[modelo] ?? null;
      return select && linha ? Object.fromEntries(Object.keys(select).map((campo) => [campo, linha[campo]])) : linha;
    },
    findMany: async ({ select }) => (linhas[modelo] ?? []).map((linha) => select ? Object.fromEntries(Object.keys(select).map((campo) => [campo, linha[campo]])) : linha),
  }) });
  const executor = new ExecutorExportacao(prisma, armazenamento);
  const resultado = await executor.executar({ id: 'j1', usuarioId: 'u1' });
  assert.equal(resultado.chave, 'usuarios/u1/exportacoes/j1.zip');
  const zip = entradasZip(await armazenamento.ler(resultado.chave));
  assert.equal(zip.get('arquivos/curriculos/c1.pdf').toString(), 'pdf de teste');
  const dados = JSON.parse(zip.get('dados.json').toString());
  assert.equal(dados.conta.email, 'pessoa@teste.dev');
  assert.deepEqual(dados.candidaturas.map(({ id }) => id), ['a1']);
  assert.deepEqual(dados.mensagensCopiloto.map(({ id }) => id), ['m1']);
  assert.equal(JSON.stringify(dados).includes('senhaHash'), false);
  assert.equal(JSON.stringify(dados).includes('embedding'), false);
  assert.equal(JSON.stringify(dados).includes('sessoes'), false);
});
