const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const raiz = path.resolve(__dirname, '..');
const pacote = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));
const origem = path.resolve(raiz, process.env.PRISMA_SCHEMA_ORIGEM || pacote.config.schemaPrisma);
const destino = path.join(raiz, 'prisma', 'schema.prisma');

if (fs.existsSync(origem)) {
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.copyFileSync(origem, destino);
} else if (!fs.existsSync(destino)) {
  console.error(`schema do Prisma nao encontrado em ${origem}`);
  process.exit(1);
}

const gerar = spawnSync('npx', ['prisma', 'generate', '--schema', destino], { cwd: raiz, stdio: 'inherit', shell: true });
process.exit(gerar.status ?? 1);
