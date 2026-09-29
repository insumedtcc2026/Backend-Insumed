import knex from '../database/index.js';
import bcrypt from 'bcrypt';

export default {

  // busca todos os administradores
  async autorizadorrall(req, res) {
    try {
      const dados = await knex('autorizador'); // corrigi nome da tabela
      console.log(dados);
      return res.status(200).send(dados);
    } catch (error) {
      return res.status(500).send({
        message: 'Erro ao buscar autorizadores',
        error: error.message
      });
    }
  },


  async buscarPrescricoesAprovadas(req, res) {
    try {

      console.log("========== BUSCANDO PRESCRIÇÕES APROVADAS =========="); console.log("Sessão:", req.session);
        const autorizador = req.session;

        const query = knex("solicitacao as sol")
            .innerJoin(
                "pacientes as pac",
                "pac.pac_id",
                "sol.pac_id"
            )
            .leftJoin(
                "insumo as ins",
                "ins.ins_id",
                "sol.ins_id"
            )
            .leftJoin(
                "postosdesaude as pos",
                "pos.pos_id",
                "sol.pos_id"
            )
            .select(
                "sol.sol_id",
                "sol.pac_id",
                "sol.pos_id",
                "sol.sol_status",
                "sol.sol_data_solicitacao",
                "sol.sol_data_vencimento",

                "sol.sol_motivo_reenvio",
                "sol.sol_observacao",
                "sol.sol_prescricao_tipo",

                "pac.pac_nome",
                "pac.pac_cpf",
                "pac.pac_avatar",

                "ins.ins_nome",
                "pos.pos_nome"
            )
            .whereIn("sol.sol_status", [
                "Aprovado",
            
            ]);

      
 const prescricoes = await query;

        return res.status(200).json(prescricoes);

    } catch (error) {
        console.error("Erro ao buscar prescrições aprovadas:", error);

        return res.status(500).json({
            error: "Erro ao buscar prescrições aprovadas."
        });
    }
},
  

  // cria um novo administrador
  async createautorizador(req, res) {
    try {
      console.log("BODY:", req.body);

      const {
        
        nome,
        email,
        telefone,
        senha,
        cpf
      } = req.body;

      const hashSenha = await bcrypt.hash(senha, 10);

      const dadoscreate = {
        
        aut_nome: nome,
        aut_email: email,
        aut_tel: telefone,
        aut_senha: hashSenha,
        aut_cpf: cpf,
      };

    
      const result = await knex('autorizador').insert(dadoscreate);

      return res.status(201).send({
        message: 'Autorizador criado com sucesso',
        
      });

    } catch (error) {
      return res.status(500).send({
        message: 'Erro ao criar Autorizador',
        error: error.message
      });
    }
  }
};