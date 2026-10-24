// MEUS INSUMOS (paciente): o que ele recebe hoje, pelas prescrições
// autorizadas e ainda válidas, com a situação de cada insumo na unidade.
// "Indisponível" quando o que está livre no estoque (descontado o que está
// reservado para outras coletas) não cobre a quantidade de uma retirada.
// O paciente não vê o número do estoque, só a situação.

import knex from '../database/index.js';
import { itensDasPrescricoes, resumoRecorrencia } from '../utils/itensPrescricao.js';
import { reservados } from '../utils/estoque.js';
import { isoData } from '../utils/status.js';
import { dataHojeBrasil } from '../utils/validacoes.js';

export default {

  // GET /meus-insumos
  async listar(req, res) {
    try {
      const hoje = dataHojeBrasil();
      const prescricoes = await knex('solicitacao as sol')
        .leftJoin('postosdesaude as pos', 'pos.pos_id', 'sol.pos_id')
        .where('sol.pac_id', req.session.id)
        .where('sol.sol_status', 'Autorizado')
        .where((w) => w.whereNull('sol.sol_data_vencimento').orWhere('sol.sol_data_vencimento', '>=', hoje))
        .orderBy('sol.sol_id', 'desc')
        .select('sol.sol_id', 'sol.pos_id', 'sol.sol_data_vencimento', 'sol.sol_periodicidade_dias',
          'pos.pos_nome', 'pos.pos_endereco', 'pos.pos_whatsapp');
      if (!prescricoes.length) return res.status(200).json([]);

      const ids = prescricoes.map((p) => p.sol_id);
      const itens = await itensDasPrescricoes(ids);
      const agendamentos = await knex('solicitacao')
        .whereIn('sol_origem_id', ids)
        .whereIn('sol_status', ['agendado', 'concluido'])
        .orderBy('sol_id')
        .select('sol_id', 'sol_origem_id', 'sol_status', 'sol_data_de_coleta', 'sol_turno');

      // reserva das coletas em aberto deste paciente: não conta contra ele mesmo
      const abertos = agendamentos.filter((a) => a.sol_status === 'agendado');
      const proprios = new Map();
      if (abertos.length) {
        const linhas = await knex('coleta').whereIn('sol_id', abertos.map((a) => a.sol_id)).select('sol_id', 'ins_id', 'quantidade');
        for (const l of linhas) {
          const chave = `${l.sol_id}:${l.ins_id}`;
          proprios.set(chave, (proprios.get(chave) ?? 0) + Number(l.quantidade));
        }
      }

      const insIds = [...itens.values()].flat().map((i) => i.ins_id);
      const reserva = await reservados(insIds);
      const estoque = new Map((insIds.length
        ? await knex('insumo').whereIn('ins_id', [...new Set(insIds)]).select('ins_id', 'ins_quantidade')
        : []).map((i) => [Number(i.ins_id), Number(i.ins_quantidade ?? 0)]));

      const saida = prescricoes.map((p) => {
        const dela = agendamentos.filter((a) => a.sol_origem_id === p.sol_id);
        const aberto = dela.find((a) => a.sol_status === 'agendado') ?? null;
        const { retiradas_concluidas, proxima_retirada } = resumoRecorrencia(p, dela);
        return {
          sol_id: p.sol_id,
          posto: { pos_id: p.pos_id, pos_nome: p.pos_nome, pos_endereco: p.pos_endereco ?? null, pos_whatsapp: p.pos_whatsapp ?? null },
          sol_data_vencimento: isoData(p.sol_data_vencimento),
          sol_periodicidade_dias: p.sol_periodicidade_dias ? Number(p.sol_periodicidade_dias) : null,
          retiradas_concluidas,
          proxima_retirada,
          agendamento: aberto
            ? { sol_id: aberto.sol_id, data: isoData(aberto.sol_data_de_coleta), turno: aberto.sol_turno ?? null }
            : null,
          itens: (itens.get(Number(p.sol_id)) ?? []).map((i) => {
            const meu = aberto ? proprios.get(`${aberto.sol_id}:${i.ins_id}`) ?? 0 : 0;
            const livre = (estoque.get(Number(i.ins_id)) ?? 0) - (reserva.get(Number(i.ins_id)) ?? 0) + meu;
            return {
              ins_id: i.ins_id,
              ins_nome: i.ins_nome,
              ins_marca: i.ins_marca,
              quantidade: i.quantidade,
              situacao: livre >= i.quantidade ? 'disponivel' : 'indisponivel',
            };
          }),
        };
      });
      return res.status(200).json(saida);
    } catch (error) {
      console.error('Erro ao listar meus insumos:', error);
      return res.status(500).json({ error: 'Erro ao buscar os seus insumos' });
    }
  },
};
