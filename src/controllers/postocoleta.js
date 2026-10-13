import knex from "../database/index.js"; 

export default{
     async listar(req, res) {
        try {
            const postos = await knex("postosdesaude")
                .select("*")
                .orderBy("pos_nome");

            return res.json(postos);
        } catch (erro) {
            console.error("Erro ao listar postos:", erro);
            return res.status(500).json({
                erro: "Erro ao listar postos de coleta"
            });
        }
    },

    async listarporid(req, res) { 
        try {
            const { id } = req.params;

            const postoid = await knex("postosdesaude")
                .select("*")
                .where("pos_id", id)
                .first();
            if (!postoid) {
                return res.status(404).json({ 
                    erro: 'Posto não encontrado' 
                });
            }
            return res.json(postoid);
            
        } catch (erro) { 
            console.error('Erro ao obter posto:', erro);
            return res.status(500).json({ 
                erro: 'Erro ao obter posto' 
            });
        }
    }
}