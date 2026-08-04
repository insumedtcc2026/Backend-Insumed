import knex from '../database/index.js';
import bcrypt from 'bcrypt';

export default {

  // busca todos os administradores
  async administradorall(req, res) {
    try {
      const dados = await knex('administrador'); // corrigi nome da tabela
      console.log(dados);
      return res.status(200).send(dados);
    } catch (error) {
      return res.status(500).send({
        message: 'Erro ao buscar administradores',
        error: error.message
      });
    }
  },

  // cria um novo administrador
  async createadministrador(req, res) {
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
        adm_nome: nome,
        adm_email: email,
        adm_telefone: telefone,
        adm_senha: hashSenha,
        adm_cpf: cpf,
      };

    
      const result = await knex('administrador').insert(dadoscreate);

      return res.status(201).send({
        message: 'Administrador criado com sucesso',
        id: result[0]
      });

    } catch (error) {
      return res.status(500).send({
        message: 'Erro ao criar administrador',
        error: error.message
      });
    }
  }
};