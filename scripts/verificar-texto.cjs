const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');

const raiz = path.resolve(__dirname, '..');
const arquivos = execFileSync('git', ['ls-files', '-z', '--', '.'], { cwd: raiz, encoding: 'utf8' }).split('\0').filter(Boolean);
let falhas = 0;

function acusar(arquivo, texto, posicao, motivo) {
  const linha = texto.slice(0, posicao).split('\n').length;
  console.error(arquivo + ':' + linha + ': ' + motivo);
  falhas++;
}

function comentarios(arquivo, texto) {
  const fonte = ts.createSourceFile(arquivo, texto, ts.ScriptTarget.Latest, true);
  const literais = [];
  function visitar(no) {
    if (ts.isStringLiteral(no) || ts.isRegularExpressionLiteral(no) || ts.isTemplateLiteralToken(no) || ts.isJsxText(no)) {
      literais.push([no.getStart(fonte), no.end]);
    } else {
      ts.forEachChild(no, visitar);
    }
  }
  visitar(fonte);
  literais.sort((a, b) => a[0] - b[0]);
  let inicio = 0;
  for (const [fim, proximo] of [...literais, [texto.length, texto.length]]) {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, texto.slice(inicio, fim));
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
        acusar(arquivo, texto, inicio + scanner.getTokenPos(), 'comentario em codigo');
      }
    }
    inicio = proximo;
  }
}

for (const arquivo of arquivos) {
  const caminho = path.join(raiz, arquivo);
  if (!fs.existsSync(caminho) || !fs.statSync(caminho).isFile()) continue;
  const texto = fs.readFileSync(caminho, 'utf8');
  const posicao = texto.indexOf(String.fromCodePoint(0x2014));
  if (posicao !== -1) acusar(arquivo, texto, posicao, 'travessao proibido');
  if (/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(arquivo)) comentarios(arquivo, texto);
}

if (falhas) process.exit(1);
console.log('Texto verificado: ' + arquivos.length + ' arquivos');
