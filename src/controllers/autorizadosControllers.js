// PESSOAS AUTORIZADAS A RETIRAR: familiar ou cuidador que pode buscar os
// insumos no lugar do paciente. A unidade cadastra na ficha do paciente
// (admin de uma unidade onde o paciente tem prescrição, ou o universal);
// o paciente só consulta. Remover desativa, para o histórico de retiradas
// continuar mostrando quem retirou.

import knex from '../database/index.js';
import {
  cpfValido, formatarCPF, formatarTelefone, idValido, normalizarNome, somenteDigitos, validarNome, validarTelefone,
} from '../utils/validacoes.js';

export const MAX_AUTORIZADOS = 5;
const MAX_PARENTESCO = 40;

const COLUNAS = ['pau_id', 'pau_nome', 'pau_cpf', 'pau_parentesco', 'pau_telefone', 'pau_criado_em'];

export const autorizadosDoPaciente = (pac_id, db = knex) =>
  db('paciente_autorizado').where({ pac_id, pau_ativo: true }).orderBy('pau_id').select(COLUNAS);

// Admin do posto só mexe em quem tem (ou teve) prescrição na unidade dele
async function podeEditar(sessao, pac_id) {
  if (sessao?.tp_universal) return true;
  const vinculo = await knex('solicitacao').where({ pac_id, pos_id: sessao?.posto_id ?? null }).first('sol_id');
  return Boolean(vinculo);
}

// Confere e normaliza { nome, cpf, parentesco, telefone }. Devolve { dados } ou { erro }.
function lerPessoa(corpo, paciente) {
  const erroNome = validarNome(corpo?.nome);
  if (erroNome) return { erro: erroNome };
  if (!cpfValido(corpo?.cpf)) return { erro: 'CPF inválido.' };
  if (somenteDigitos(corpo.cpf) === somenteDigitos(paciente.pac_cpf)) {
    return { erro: 'Este é o CPF do próprio paciente. Cadastre só quem retira no lugar dele.' };
  }
  const parentesco = typeof corpo?.parentesco === 'string' ? corpo.parentesco.trim() : '';
  if (parentesco.length > MAX_PARENTESCO) return { erro: `Parentesco: no máximo ${MAX_PARENTESCO} caracteres.` };
  const telefone = typeof corpo?.telefone === 'string' ? corpo.telefone.trim() : '';
  if (telefone) {
    const erroTel = validarTelefone(telefone);
    if (erroTel) return { erro: erroTel };
  }
  return {
    dados: {
      pau_nome: normalizarNome(corpo.nome),
      pau_cpf: formatarCPF(corpo.cpf),
      pau_parentesco: parentesco || null,
      pau_telefone: telefone ? formatarTelefone(telefone) : null,
    },
  };
}

async function pacienteOu404(req, res) {
  if (!idValido(req.params.id)) {
    res.status(400).json({ error: 'Paciente inválido.' });
    return null;
  }
  const paciente = await knex('pacientes').where('pac_id', Number(req.params.id)).first('pac_id', 'pac_cpf');
  if (!paciente) {
    res.status(404).json({ error: 'Paciente não encontrado' });
    return null;
  }
  return paciente;
}

const nomeDaSessao = async (sessao) => {
  const adm = sessao?.email ? await knex('administrador').where('adm_email', sessao.email).first('adm_nome') : null;
  return adm?.adm_nome ?? null;
};

export default {

  // GET /pacientes/:id/autorizados (admin)
  async listar(req, res) {
    try {
      const paciente = await pacienteOu404(req, res);
      if (!paciente) return;
      return res.status(200).json({
        autorizados: await autorizadosDoPaciente(paciente.pac_id),
        pode_editar: await podeEditar(req.session, paciente.pac_id),
        limite: MAX_AUTORIZADOS,
      });
    } catch (error) {
      console.error('Erro ao listar autorizados:', error);
      return res.status(500).json({ error: 'Erro ao buscar as pessoas autorizadas' });
    }
  },

  // POST /pacientes/:id/autorizados
  async criar(req, res) {
    try {
      const paciente = await pacienteOu404(req, res);
      if (!paciente) return;
      if (!(await podeEditar(req.session, paciente.pac_id))) {
        return res.status(403).json({ error: 'Só a unidade onde o paciente é atendido pode cadastrar quem retira por ele.' });
      }
      const { dados, erro } = lerPessoa(req.body, paciente);
      if (erro) return res.status(400).json({ error: erro });

      const atuais = await autorizadosDoPaciente(paciente.pac_id);
      if (atuais.length >= MAX_AUTORIZADOS) {
        return res.status(409).json({ error: `O paciente já tem ${MAX_AUTORIZADOS} pessoas autorizadas. Remova uma antes.` });
      }
      if (atuais.some((a) => a.pau_cpf === dados.pau_cpf)) {
        return res.status(409).json({ error: 'Esta pessoa já está autorizada.' });
      }

      const [novo] = await knex('paciente_autorizado')
        .insert({ ...dados, pac_id: paciente.pac_id, pau_criado_por: await nomeDaSessao(req.session) })
        .returning(COLUNAS);
      return res.status(201).json(novo);
    } catch (error) {
      console.error('Erro ao cadastrar autorizado:', error);
      return res.status(500).json({ error: 'Erro ao cadastrar a pessoa autorizada' });
    }
  },

  // PUT /pacientes/:id/autorizados/:pau
  async atualizar(req, res) {
    try {
      const paciente = await pacienteOu404(req, res);
      if (!paciente) return;
      if (!(await podeEditar(req.session, paciente.pac_id))) {
        return res.status(403).json({ error: 'Só a unidade onde o paciente é atendido pode alterar quem retira por ele.' });
      }
      const pau_id = Number(req.params.pau);
      const atual = await knex('paciente_autorizado').where({ pau_id, pac_id: paciente.pac_id, pau_ativo: true }).first('pau_id');
      if (!atual) return res.status(404).json({ error: 'Pessoa autorizada não encontrada.' });

      const { dados, erro } = lerPessoa(req.body, paciente);
      if (erro) return res.status(400).json({ error: erro });
      const repetido = await knex('paciente_autorizado')
        .where({ pac_id: paciente.pac_id, pau_ativo: true, pau_cpf: dados.pau_cpf })
        .whereNot('pau_id', pau_id)
        .first('pau_id');
      if (repetido) return res.status(409).json({ error: 'Esta pessoa já está autorizada.' });

      await knex('paciente_autorizado').where('pau_id', pau_id).update(dados);
      return res.status(200).json(await knex('paciente_autorizado').where('pau_id', pau_id).first(COLUNAS));
    } catch (error) {
      console.error('Erro ao alterar autorizado:', error);
      return res.status(500).json({ error: 'Erro ao alterar a pessoa autorizada' });
    }
  },

  // DELETE /pacientes/:id/autorizados/:pau (desativa)
  async remover(req, res) {
    try {
      const paciente = await pacienteOu404(req, res);
      if (!paciente) return;
      if (!(await podeEditar(req.session, paciente.pac_id))) {
        return res.status(403).json({ error: 'Só a unidade onde o paciente é atendido pode remover quem retira por ele.' });
      }
      const n = await knex('paciente_autorizado')
        .where({ pau_id: Number(req.params.pau), pac_id: paciente.pac_id, pau_ativo: true })
        .update({ pau_ativo: false });
      if (!n) return res.status(404).json({ error: 'Pessoa autorizada não encontrada.' });
      return res.status(200).json({ message: 'Autorização removida.' });
    } catch (error) {
      console.error('Erro ao remover autorizado:', error);
      return res.status(500).json({ error: 'Erro ao remover a pessoa autorizada' });
    }
  },

  // GET /meus-autorizados (paciente): só leitura
  async meus(req, res) {
    try {
      const lista = await autorizadosDoPaciente(req.session.id);
      return res.status(200).json(lista);
    } catch (error) {
      console.error('Erro ao listar meus autorizados:', error);
      return res.status(500).json({ error: 'Erro ao buscar as pessoas autorizadas' });
    }
  },
};
