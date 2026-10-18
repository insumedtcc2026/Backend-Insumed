// Avisos de estoque. A movimentação de estoque não passa pelo histórico,
// então o aviso é criado direto, comparando a quantidade antes e depois.
//
// - Equipe (admins do posto + universais): estoque baixo e esgotado.
// - Paciente: só quando o insumo faz parte de uma coleta AGENDADA dele no
//   mesmo posto (baixo, esgotado e reabastecido depois de esgotar).

import knex from '../database/index.js';
import { dataHojeBrasil } from '../utils/validacoes.js';
import { adminsDoPosto, paciente } from './destinatarios.js';
import { criarNotificacoes } from './gravar.js';
import { LINKS } from './regras.js';
import { LIMITE_ESTOQUE_BAIXO } from '../controllers/painelControllers.js';

export const situacaoEstoque = (quantidade) => {
  const q = Number(quantidade);
  if (!(q > 0)) return 'esgotado';
  if (q <= LIMITE_ESTOQUE_BAIXO) return 'baixo';
  return 'ok';
};

async function avisarUm({ ins_id, antes, depois }) {
  const de = situacaoEstoque(antes);
  const para = situacaoEstoque(depois);
  if (de === para) return;
  // de esgotado para baixo: para o paciente já é "reabastecido"
  const reabastecido = de === 'esgotado' && para !== 'esgotado';
  if (para === 'ok' && !reabastecido) return;

  const insumo = await knex('insumo').where('ins_id', ins_id).first('ins_id', 'ins_nome', 'pos_id');
  if (!insumo) return;
  const hoje = dataHojeBrasil();
  const nome = insumo.ins_nome ?? 'insumo';
  const lista = [];

  if (para !== 'ok') {
    const admins = await adminsDoPosto(knex, insumo.pos_id);
    lista.push(...admins.map((dest) => ({
      dest,
      evento: `estoque_${para}`,
      tom: para === 'esgotado' ? 'erro' : 'alerta',
      prioridade: para === 'esgotado' ? 1 : 2,
      titulo: para === 'esgotado' ? 'Estoque esgotado' : 'Estoque baixo',
      mensagem: para === 'esgotado'
        ? `O insumo ${nome} está esgotado na unidade.`
        : `O insumo ${nome} está com estoque reduzido (${Number(depois)} ${Number(depois) === 1 ? 'unidade' : 'unidades'}).`,
      link: LINKS.insumosAdmin,
      chave: `estoque:${ins_id}:${para}:${hoje}`,
    })));
  }

  // pacientes com coleta agendada que inclui este insumo, no mesmo posto
  const coletas = await knex('coleta as c')
    .join('solicitacao as s', 's.sol_id', 'c.sol_id')
    .where('c.ins_id', ins_id)
    .where('s.sol_status', 'agendado')
    .modify((qb) => { if (insumo.pos_id) qb.where('s.pos_id', insumo.pos_id); })
    .select('s.sol_id', 's.pac_id');

  const situacao = reabastecido ? 'reabastecido' : para;
  const TEXTOS = {
    esgotado: { tom: 'erro', titulo: 'Estoque esgotado', mensagem: `O insumo ${nome} está temporariamente indisponível em sua unidade de retirada.` },
    baixo: { tom: 'alerta', titulo: 'Estoque baixo', mensagem: `O insumo ${nome} está com estoque reduzido e pode se esgotar em breve. Fique atento até sua data de coleta.` },
    reabastecido: { tom: 'sucesso', titulo: 'Estoque reabastecido', mensagem: `O insumo ${nome} já está disponível novamente para retirada em sua unidade de atendimento.` },
  };

  for (const c of coletas) {
    lista.push({
      dest: paciente(c.pac_id),
      evento: `estoque_${situacao}`,
      prioridade: situacao === 'reabastecido' ? 2 : 1,
      ...TEXTOS[situacao],
      link: LINKS.agendamentoPaciente(c.sol_id),
      sol_id: c.sol_id,
      chave: `estoque:${ins_id}:${situacao}:${c.sol_id}:${hoje}`,
    });
  }

  await criarNotificacoes(knex, lista);
}

/**
 * Chamado depois do commit de qualquer mudança de estoque.
 * Nunca lança erro (o estoque já foi salvo).
 * @param mudancas [{ ins_id, antes, depois }]
 */
export async function avisarEstoque(mudancas) {
  for (const m of mudancas) {
    try {
      await avisarUm(m);
    } catch (error) {
      console.error(`Erro ao avisar estoque do insumo ${m.ins_id}:`, error);
    }
  }
}
