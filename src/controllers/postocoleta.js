import knex from "../database/index.js"; 


export default{
     async listar(req, res) {

        try {

            const postos = await knex("postosdesaude")
                .select("*")
                .orderBy("pos_nome");

            return res.json(postos);

        } catch (erro) {

            console.log(erro);

            return res.status(500).json({
                erro: erro.message
            });

        }

    }

}
