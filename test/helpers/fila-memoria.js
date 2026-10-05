class FilaMemoria {
  constructor({ maxRecebimentos = 3 } = {}) {
    this.maxRecebimentos = maxRecebimentos;
    this.mensagens = [];
    this.mortas = [];
    this.apagadas = 0;
    this.sequencia = 0;
  }

  async enviar(mensagem, atrasoS = 0) {
    this.enviadas = (this.enviadas ?? 0) + 1;
    this.mensagens.push({ id: ++this.sequencia, corpo: JSON.stringify(mensagem), recebimentos: 0, visivelEm: atrasoS ? Date.now() + 1 : 0, recibo: null });
  }

  async receber(esperaS, _visibilidadeS, sinal) {
    const limite = Date.now() + Math.min(esperaS, 0.05) * 1000;
    for (;;) {
      if (sinal?.aborted) return [];
      const agora = Date.now();
      for (const m of [...this.mensagens]) {
        if (m.visivelEm > agora) continue;
        if (m.recebimentos >= this.maxRecebimentos) {
          this.mensagens.splice(this.mensagens.indexOf(m), 1);
          this.mortas.push(m);
          continue;
        }
        m.recebimentos += 1;
        m.recibo = `r-${m.id}-${m.recebimentos}`;
        m.visivelEm = agora + 30_000;
        return [{ corpo: m.corpo, recibo: m.recibo, recebimentos: m.recebimentos }];
      }
      await new Promise((r) => setTimeout(r, 5));
      if (Date.now() >= limite) return [];
    }
  }

  async apagar(recibo) {
    const i = this.mensagens.findIndex((m) => m.recibo === recibo);
    if (i >= 0) {
      this.mensagens.splice(i, 1);
      this.apagadas += 1;
    }
  }

  async mudarVisibilidade(recibo, segundos) {
    const m = this.mensagens.find((x) => x.recibo === recibo);
    if (m) m.visivelEm = Date.now() + segundos;
  }

  async verificar() {}
}

module.exports = { FilaMemoria };
