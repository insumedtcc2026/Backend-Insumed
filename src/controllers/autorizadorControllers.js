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