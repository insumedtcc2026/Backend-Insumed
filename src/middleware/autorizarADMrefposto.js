import knex from "../database/index.js";

async function validarAcessoSolicitacao(req, res, next) {
    try {
        const { id } = req.params;
        const admin = req.session;

        if (admin.tipo !== 'ADMIN') {
            return res.status(403).json({
                erro: 'Acesso negado: apenas admins'
            });
        }

        const solicitacao = await knex('solicitacao')
            .select('sol_id', 'pos_id')
            .where('sol_id', id)
            .first();

        if (!solicitacao) {
            return res.status(404).json({
                erro: 'Solicitação não encontrada'
            });
        }
        if (!admin.tp_universal && admin.posto_id !== solicitacao.pos_id) {
            return res.status(403).json({
                erro: 'Acesso negado: solicitação de outro posto'
            });
        }

        req.solicitacao = solicitacao;
        next();

    } catch (erro) {
        console.error('Erro em validarAcessoSolicitacao:', erro);
        return res.status(500).json({
            erro: 'Erro ao validar acesso',
            message: erro.message
        });
    }
}

export default validarAcessoSolicitacao;