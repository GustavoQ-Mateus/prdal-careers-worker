class ArmazenamentoMemoria {
  constructor() {
    this.objetos = new Map();
  }

  async gravar(chave, dados, tipo) {
    this.objetos.set(chave, { dados: Buffer.from(dados), tipo });
    return chave;
  }

  async ler(chave) {
    const objeto = this.objetos.get(chave);
    if (!objeto) throw new Error(`objeto ${chave} nao encontrado`);
    return objeto.dados;
  }

  async verificar() {}
}

module.exports = { ArmazenamentoMemoria };
