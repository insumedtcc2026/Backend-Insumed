import knex from '../database/index.js';
import bcrypt from 'bcrypt';

export default {

  // busca todos os administradores
  async prescritorall(req, res) {
    try {
      const dados = await knex('prescritor'); // corrigi nome da tabela
      console.log(dados);
      return res.status(200).send(dados);
    } catch (error) {
      return res.status(500).send({
        message: 'Erro ao buscar prescritores',
        error: error.message
      });
    }
  },

  // cria um novo administrador
  async createprescritor(req, res) {
    try {
      console.log("BODY:", req.body);

      const {
        
        nome,
        email,
        tel,
        senha,
        cpf
      } = req.body;

      const hashSenha = await bcrypt.hash(senha, 10);

      const dadoscreate = {
        
        pre_nome: nome,
        pre_email: email,
        pre_tel: tel,
        pre_senha: hashSenha,
        pre_cpf: cpf,
      };

    
      const result = await knex('prescritor').insert(dadoscreate);

      return res.status(201).send({
        message: 'Prescritor criado com sucesso',
        
      });

    } catch (error) {
      return res.status(500).send({
        message: 'Erro ao criar Prescritor',
        error: error.message
      });
    }
  }
};