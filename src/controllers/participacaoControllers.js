// O PACIENTE NA AGENDA: pedir outra data, confirmar presença e cancelar o
// próprio agendamento. E a resposta da unidade ao pedido de outra data.
//
// Pedido de outra data: só para o próprio agendamento, ainda "agendado" e
// até a véspera. A unidade aceita (vira uma remarcação, com o mesmo
// protocolo) ou recusa com motivo. Enquanto há pedido aberto, outro não.

import knex from '../database/index.js';
import { ACOES, registrarHistorico } from '../utils/historico.js';
import { conferirVaga, proximasOpcoes, ROTULO_TURNO, TURNOS } from '../utils/agenda.js';
import { dataBR, isoData, somarDias } from '../utils/status.js';
import { dataHojeBrasil, validarDataISO } from '../utils/validacoes.js';
import { notificar } from '../notificacoes/processador.js';

const MAX_TEXTO = 300;
const comTurno = (data, turno) => `${dataBR(data)}${turno ? ` (${ROTULO_TURNO[turno] ?? turno})` : ''}`;

// Agendamento do paciente logado, travado para a alteração
async function doPaciente(trx, sessao, id) {
  return trx('solicitacao')
    .where({ sol_id: Number(id), pac_id: sessao.id })
    .forUpdate()
    .first('sol_id', 'pos_id', 'sol_status', 'sol_protocolo', 'sol_data_de_coleta', 'sol_turno', 'sol_origem_id',
      'sol_pedido_situacao');
}

// Histórico no agendamento e na prescrição de origem (padrão dos agendamentos)
async function registrarNosDois(trx, sessao, ag, dados) {
  await registrarHistorico(trx, sessao, { sol_id: ag.sol_id, de: 'agendado', para: dados.para ?? 'agendado', ...dados });
  if (ag.sol_origem_id) {
    await registrarHistorico(trx, sessao, { ...dados, sol_id: ag.sol_origem_id, de: 'Autorizado', para: 'Autorizado' });
  }
}

const textoLimpo = (valor) => (typeof valor === 'string' ? valor.trim() : '');

export default {

  // GET /meus-agendamentos/:id/opcoes: dias e turnos com vaga para o
  // pedido de outra data (até o vencimento da prescrição)
  async opcoes(req, res) {
    try {
      const ag = await knex('solicitacao')
        .where({ sol_id: Number(req.params.id), pac_id: req.session.id })
        .first('sol_id', 'pos_id', 'sol_status', 'sol_data_de_coleta', 'sol_turno', 'sol_origem_id');
      if (!ag) return res.status(404).json({ error: 'Agendamento não encontrado' });
      if (ag.sol_status !== 'agendado') return res.status(409).json({ error: 'Este agendamento não está mais em aberto.' });

      const origem = ag.sol_origem_id
        ? await knex('solicitacao').where('sol_id', ag.sol_origem_id).first('sol_data_vencimento')
        : null;
      const opcoes = await proximasOpcoes(ag.pos_id, somarDias(dataHojeBrasil(), 1), {
        limite: 20, ate: isoData(origem?.sol_data_vencimento), ignorarSolId: ag.sol_id,
      });
      const atual = isoData(ag.sol_data_de_coleta);
      return res.status(200).json(opcoes
        .filter((o) => !(o.data === atual && o.turno === (ag.sol_turno ?? 'manha')))
        .map(({ data, turno, abre, fecha, livres }) => ({ data, turno, abre, fecha, livres })));
    } catch (error) {
      console.error('Erro ao buscar opções de data:', error);
      return res.status(500).json({ error: 'Erro ao buscar as datas disponíveis' });
    }
  },

  // POST /meus-agendamentos/:id/outra-data { data, turno, motivo }
  async pedirOutraData(req, res) {
    try {
      const { data, turno } = req.body ?? {};
      const motivo = textoLimpo(req.body?.motivo);
      if (!data || validarDataISO(data)) return res.status(400).json({ error: 'Escolha a nova data.' });
      if (!TURNOS.includes(turno)) return res.status(400).json({ error: 'Escolha o turno (manhã ou tarde).' });
      if (motivo.length > MAX_TEXTO) return res.status(400).json({ error: `O motivo deve ter no máximo ${MAX_TEXTO} caracteres.` });
      const hoje = dataHojeBrasil();
      if (data <= hoje) return res.status(400).json({ error: 'A nova data precisa ser a partir de amanhã.' });

      const resultado = await knex.transaction(async (trx) => {
        const ag = await doPaciente(trx, req.session, req.params.id);
        if (!ag) return { status: 404, corpo: { error: 'Agendamento não encontrado' } };
        if (ag.sol_status !== 'agendado') return { status: 409, corpo: { error: 'Este agendamento não está mais em aberto.' } };
        const atual = isoData(ag.sol_data_de_coleta);
        if (atual <= hoje) {
          return { status: 409, corpo: { error: 'O pedido de outra data pode ser feito até a véspera. Fale com a unidade.' } };
        }
        if (ag.sol_pedido_situacao === 'pedido') {
          return { status: 409, corpo: { error: 'Você já pediu outra data. Aguarde a resposta da unidade.' } };
        }
        if (atual === data && (ag.sol_turno ?? 'manha') === turno) {
          return { status: 400, corpo: { error: 'Escolha uma data ou um turno diferente do atual.' } };
        }
        if (ag.sol_origem_id) {
          const origem = await trx('solicitacao').where('sol_id', ag.sol_origem_id).first('sol_data_vencimento');
          const vencimento = isoData(origem?.sol_data_vencimento);
          if (vencimento && data > vencimento) {
            return { status: 400, corpo: { error: `A data não pode ser depois do vencimento da prescrição (${dataBR(vencimento)}).` } };
          }
        }
        const vaga = await conferirVaga(ag.pos_id, data, turno, { db: trx, ignorarSolId: ag.sol_id });
        if (vaga.erro) return { status: 409, corpo: { error: vaga.erro } };

        await trx('solicitacao').where('sol_id', ag.sol_id).update({
          sol_pedido_data: data,
          sol_pedido_turno: turno,
          sol_pedido_motivo: motivo || null,
          sol_pedido_situacao: 'pedido',
          sol_pedido_resposta: null,
          sol_pedido_em: trx.fn.now(),
        });
        await registrarNosDois(trx, req.session, ag, {
          acao: ACOES.OUTRA_DATA_PEDIDA,
          detalhe: `${ag.sol_protocolo ?? 'Agendamento ' + ag.sol_id} · de ${comTurno(atual, ag.sol_turno)} para ${comTurno(data, turno)}` +
            (motivo ? ` · Motivo: ${motivo}` : ''),
        });
        return { status: 201, corpo: { message: 'Pedido enviado. A unidade vai responder pelo sino.', sol_pedido_situacao: 'pedido' } };
      });

      if (resultado.status === 201) await notificar();
      return res.status(resultado.status).json(resultado.corpo);
    } catch (error) {
      console.error('Erro ao pedir outra data:', error);
      return res.status(500).json({ error: 'Erro ao enviar o pedido' });
    }
  },

  // PATCH /meus-agendamentos/:id/presenca { resposta: 'vou' | 'nao_vou' }
  async presenca(req, res) {
    try {
      const resposta = req.body?.resposta;
      if (!['vou', 'nao_vou'].includes(resposta)) return res.status(400).json({ error: 'Responda "vou" ou "não vou".' });

      const resultado = await knex.transaction(async (trx) => {
        const ag = await doPaciente(trx, req.session, req.params.id);
        if (!ag) return { status: 404, corpo: { error: 'Agendamento não encontrado' } };
        if (ag.sol_status !== 'agendado') return { status: 409, corpo: { error: 'Este agendamento não está mais em aberto.' } };
        if (isoData(ag.sol_data_de_coleta) < dataHojeBrasil()) {
          return { status: 409, corpo: { error: 'A data desta coleta já passou.' } };
        }
        await trx('solicitacao').where('sol_id', ag.sol_id).update({ sol_presenca: resposta, sol_presenca_em: trx.fn.now() });
        await registrarNosDois(trx, req.session, ag, {
          acao: ACOES.PRESENCA,
          detalhe: `${ag.sol_protocolo ?? 'Agendamento ' + ag.sol_id} · ${comTurno(isoData(ag.sol_data_de_coleta), ag.sol_turno)} · ` +
            (resposta === 'vou' ? 'Paciente confirmou presença' : 'Paciente avisou que não vai'),
        });
        return { status: 200, corpo: { message: resposta === 'vou' ? 'Presença confirmada. Obrigado!' : 'Aviso registrado.', sol_presenca: resposta } };
      });

      if (resultado.status === 200) await notificar();
      return res.status(resultado.status).json(resultado.corpo);
    } catch (error) {
      console.error('Erro ao registrar presença:', error);
      return res.status(500).json({ error: 'Erro ao registrar a resposta' });
    }
  },

  // PATCH /meus-agendamentos/:id/cancelar { motivo }: o paciente desiste da
  // data. O estoque reservado volta a ficar disponível e a prescrição pode
  // ser agendada de novo.
  async cancelarPeloPaciente(req, res) {
    try {
      const motivo = textoLimpo(req.body?.motivo);
      if (motivo.length > MAX_TEXTO) return res.status(400).json({ error: `O motivo deve ter no máximo ${MAX_TEXTO} caracteres.` });

      const resultado = await knex.transaction(async (trx) => {
        const ag = await doPaciente(trx, req.session, req.params.id);
        if (!ag) return { status: 404, corpo: { error: 'Agendamento não encontrado' } };
        if (ag.sol_status !== 'agendado') return { status: 409, corpo: { error: 'Este agendamento não está mais em aberto.' } };

        const texto = `Cancelado pelo paciente${motivo ? `: ${motivo}` : ''}`;
        await trx('solicitacao').where('sol_id', ag.sol_id).update({
          sol_status: 'cancelado',
          sol_motivo_cancelamento: texto,
          sol_data_cancelamento: trx.fn.now(),
          sol_pedido_situacao: ag.sol_pedido_situacao === 'pedido' ? null : ag.sol_pedido_situacao,
        });
        await registrarNosDois(trx, req.session, ag, {
          acao: ACOES.CANCELADA, para: 'cancelado',
          detalhe: `${ag.sol_protocolo ?? 'Agendamento ' + ag.sol_id} · Motivo: ${texto}`,
        });
        return { status: 200, corpo: { message: 'Agendamento cancelado.' } };
      });

      if (resultado.status === 200) await notificar();
      return res.status(resultado.status).json(resultado.corpo);
    } catch (error) {
      console.error('Erro ao cancelar pelo paciente:', error);
      return res.status(500).json({ error: 'Erro ao cancelar o agendamento' });
    }
  },

  // PATCH /agendamentos/:id/pedido-outra-data { aceitar: true } | { aceitar: false, resposta }
  async responderPedido(req, res) {
    try {
      const aceitar = req.body?.aceitar;
      const resposta = textoLimpo(req.body?.resposta);
      if (typeof aceitar !== 'boolean') return res.status(400).json({ error: 'Informe se o pedido foi aceito.' });
      if (!aceitar && !resposta) return res.status(400).json({ error: 'Explique ao paciente por que a data não pode ser atendida.' });
      if (resposta.length > MAX_TEXTO) return res.status(400).json({ error: `A resposta deve ter no máximo ${MAX_TEXTO} caracteres.` });

      const resultado = await knex.transaction(async (trx) => {
        const ag = await trx('solicitacao')
          .where('sol_id', Number(req.params.id))
          .forUpdate()
          .first('sol_id', 'pos_id', 'sol_status', 'sol_protocolo', 'sol_data_de_coleta', 'sol_turno', 'sol_origem_id',
            'sol_pedido_situacao', 'sol_pedido_data', 'sol_pedido_turno');
        if (!ag) return { status: 404, corpo: { error: 'Agendamento não encontrado' } };
        if (ag.sol_status !== 'agendado' || ag.sol_pedido_situacao !== 'pedido') {
          return { status: 409, corpo: { error: 'Não há pedido de outra data em aberto neste agendamento.' } };
        }
        const atual = isoData(ag.sol_data_de_coleta);
        const pedida = isoData(ag.sol_pedido_data);

        if (!aceitar) {
          await trx('solicitacao').where('sol_id', ag.sol_id).update({ sol_pedido_situacao: 'recusado', sol_pedido_resposta: resposta });
          await registrarNosDois(trx, req.session, ag, {
            acao: ACOES.OUTRA_DATA_RECUSADA,
            detalhe: `${ag.sol_protocolo ?? 'Agendamento ' + ag.sol_id} · pedido para ${comTurno(pedida, ag.sol_pedido_turno)} · Motivo: ${resposta}`,
          });
          return { status: 200, corpo: { message: 'Pedido recusado. O paciente foi avisado.' } };
        }

        if (pedida <= dataHojeBrasil()) {
          return { status: 409, corpo: { error: 'A data pedida já passou. Recuse o pedido ou remarque com outra data.' } };
        }
        const vaga = await conferirVaga(ag.pos_id, pedida, ag.sol_pedido_turno, { db: trx, ignorarSolId: ag.sol_id });
        if (vaga.erro) return { status: 409, corpo: { error: `${vaga.erro} Recuse o pedido explicando ao paciente.` } };

        await trx('solicitacao').where('sol_id', ag.sol_id).update({
          sol_data_de_coleta: pedida,
          sol_turno: vaga.turno,
          sol_data_anterior: atual,
          sol_pedido_situacao: 'aceito',
          sol_pedido_resposta: resposta || null,
          // a confirmação de presença era da data antiga
          sol_presenca: null,
          sol_presenca_em: null,
        });
        await registrarNosDois(trx, req.session, ag, {
          acao: ACOES.REMARCADA,
          detalhe: `${ag.sol_protocolo ?? 'Agendamento ' + ag.sol_id} · de ${comTurno(atual, ag.sol_turno)} para ${comTurno(pedida, vaga.turno)}` +
            ' · Motivo: pedido do paciente',
        });
        return { status: 200, corpo: { message: 'Pedido aceito. A coleta foi remarcada.', sol_data_de_coleta: pedida, sol_turno: vaga.turno } };
      });

      if (resultado.status === 200) await notificar();
      return res.status(resultado.status).json(resultado.corpo);
    } catch (error) {
      console.error('Erro ao responder pedido de outra data:', error);
      return res.status(500).json({ error: 'Erro ao responder o pedido' });
    }
  },
};
