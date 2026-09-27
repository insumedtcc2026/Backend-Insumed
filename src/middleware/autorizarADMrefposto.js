import knex from '../database/index.js';

export default async (req, res, next) => {
  try {
    const { id } = req.params;
    const admin = req.session;

    if (admin?.tipo !== "ADMIN") {
      return res.status(403).send({
        error: 'Acesso permitido somente a administradores'
      });
    }
    const solicitacao = await knex("solicitacao")
      .where('sol_id', id)
      .first();

    if (!solicitacao) {
      return res.status(404).send({
        error: 'Solicitação não encontrada'
      });
    }

    if (!admin.tp_universal && admin.posto_id !== solicitacao.pos_id) {
      return res.status(403).send({
        error: 'Você só pode acessar solicitações do seu posto'
      });
    }
    req.solicitacao = solicitacao;
    return next();

  } catch (erro) {
    console.error('Erro ao validar acesso à solicitação:', erro);
    return res.status(500).send({
      error: 'Erro ao validar acesso'
    });
  }
};