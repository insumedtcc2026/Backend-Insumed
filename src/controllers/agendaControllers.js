// HORÁRIOS DA UNIDADE: turnos, vagas e dias fechados. Leitura pública
// (o paciente vê o horário de funcionamento); alteração só do admin da
// própria unidade ou do admin universal.

import knex from '../database/index.js';
import { agendaDoPosto, horariosDoPosto, lerHorarios } from '../utils/agenda.js';
import { isoData, somarDias } from '../utils/status.js';
import { dataHojeBrasil, validarDataISO } from '../utils/validacoes.js';

const podeEditar = (sessao, pos_id) => Boolean(sessao?.tp_universal) || Number(sessao?.posto_id) === Number(pos_id);

async function postoOu404(req, res) {
  const pos_id = Number(req.params.id);
  if (!Number.isInteger(pos_id) || pos_id <= 0) {
    res.status(400).json({ error: 'Unidade inválida.' });
    return null;
  }
  const posto = await knex('postosdesaude').where('pos_id', pos_id).first('pos_id', 'pos_nome');
  if (!posto) {
    res.status(404).json({ error: 'Unidade não encontrada.' });
    return null;
  }
  return posto;
}

export default {

  // GET /postos/:id/horarios (público): turnos e próximos dias fechados
  async horarios(req, res) {
    try {
      const posto = await postoOu404(req, res);
      if (!posto) return;
      const { horarios, padrao } = await horariosDoPosto(posto.pos_id);
      const bloqueios = await knex('posto_bloqueio')
        .where('pos_id', posto.pos_id)
        .where('pbl_data', '>=', dataHojeBrasil())
        .orderBy('pbl_data')
        .select('pbl_id', 'pbl_data', 'pbl_motivo');
      return res.status(200).json({
        posto,
        padrao,
        horarios,
        bloqueios: bloqueios.map((b) => ({ id: b.pbl_id, data: isoData(b.pbl_data), motivo: b.pbl_motivo })),
      });
    } catch (error) {
      console.error('Erro ao buscar horários:', error);
      return res.status(500).json({ error: 'Erro ao buscar os horários da unidade' });
    }
  },

  // PUT /postos/:id/horarios: substitui todos os turnos da unidade
  async salvarHorarios(req, res) {
    try {
      const posto = await postoOu404(req, res);
      if (!posto) return;
      if (!podeEditar(req.session, posto.pos_id)) {
        return res.status(403).json({ error: 'Você só pode alterar os horários da sua unidade.' });
      }
      const { horarios, erro } = lerHorarios(req.body?.horarios);
      if (erro) return res.status(400).json({ error: erro });
      if (!horarios.length) return res.status(400).json({ error: 'A unidade precisa atender em pelo menos um turno.' });

      await knex.transaction(async (trx) => {
        await trx('posto_horario').where('pos_id', posto.pos_id).del();
        await trx('posto_horario').insert(horarios.map((h) => ({
          pos_id: posto.pos_id,
          phr_dia_semana: h.dia_semana,
          phr_turno: h.turno,
          phr_abre: h.abre,
          phr_fecha: h.fecha,
          phr_vagas: h.vagas,
        })));
      });
      return res.status(200).json({ message: 'Horários salvos.', horarios });
    } catch (error) {
      console.error('Erro ao salvar horários:', error);
      return res.status(500).json({ error: 'Erro ao salvar os horários' });
    }
  },

  // POST /postos/:id/bloqueios { data, motivo }
  async criarBloqueio(req, res) {
    try {
      const posto = await postoOu404(req, res);
      if (!posto) return;
      if (!podeEditar(req.session, posto.pos_id)) {
        return res.status(403).json({ error: 'Você só pode alterar a agenda da sua unidade.' });
      }
      const { data } = req.body ?? {};
      const motivo = typeof req.body?.motivo === 'string' ? req.body.motivo.trim().slice(0, 120) : '';
      if (!data || validarDataISO(data)) return res.status(400).json({ error: 'Informe uma data válida.' });
      if (data < dataHojeBrasil()) return res.status(400).json({ error: 'A data não pode estar no passado.' });

      const existe = await knex('posto_bloqueio').where({ pos_id: posto.pos_id, pbl_data: data }).first('pbl_id');
      if (existe) return res.status(409).json({ error: 'Este dia já está marcado como fechado.' });

      const [novo] = await knex('posto_bloqueio')
        .insert({ pos_id: posto.pos_id, pbl_data: data, pbl_motivo: motivo || null })
        .returning('pbl_id');

      // quem já está marcado nesse dia precisa ser remarcado pela unidade
      const afetados = Number((await knex('solicitacao')
        .where({ pos_id: posto.pos_id, sol_status: 'agendado', sol_data_de_coleta: data })
        .count({ total: '*' }).first())?.total ?? 0);

      return res.status(201).json({
        id: typeof novo === 'object' ? novo.pbl_id : novo,
        data,
        motivo: motivo || null,
        agendamentos_no_dia: afetados,
      });
    } catch (error) {
      console.error('Erro ao fechar o dia:', error);
      return res.status(500).json({ error: 'Erro ao marcar o dia como fechado' });
    }
  },

  // DELETE /postos/:id/bloqueios/:bloqueio
  async removerBloqueio(req, res) {
    try {
      const posto = await postoOu404(req, res);
      if (!posto) return;
      if (!podeEditar(req.session, posto.pos_id)) {
        return res.status(403).json({ error: 'Você só pode alterar a agenda da sua unidade.' });
      }
      const n = await knex('posto_bloqueio').where({ pos_id: posto.pos_id, pbl_id: Number(req.params.bloqueio) }).del();
      if (!n) return res.status(404).json({ error: 'Dia fechado não encontrado.' });
      return res.status(200).json({ message: 'O dia voltou a ficar aberto.' });
    } catch (error) {
      console.error('Erro ao reabrir o dia:', error);
      return res.status(500).json({ error: 'Erro ao reabrir o dia' });
    }
  },

  // GET /postos/:id/agenda?inicio=&fim= (admin): ocupação de cada turno
  async ocupacao(req, res) {
    try {
      const posto = await postoOu404(req, res);
      if (!posto) return;
      const inicio = req.query.inicio || dataHojeBrasil();
      const fim = req.query.fim || somarDias(inicio, 13);
      if (validarDataISO(inicio) || validarDataISO(fim) || fim < inicio) {
        return res.status(400).json({ error: 'Intervalo de datas inválido' });
      }
      if (somarDias(inicio, 62) < fim) return res.status(400).json({ error: 'Consulte no máximo 62 dias por vez.' });
      return res.status(200).json(await agendaDoPosto(posto.pos_id, inicio, fim));
    } catch (error) {
      console.error('Erro ao consultar a agenda:', error);
      return res.status(500).json({ error: 'Erro ao consultar a agenda' });
    }
  },
};
