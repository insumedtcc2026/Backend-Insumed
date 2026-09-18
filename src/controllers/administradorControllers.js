import knex from '../database/index.js';
import bcrypt from 'bcrypt';
import jsonwebtoken from 'jsonwebtoken';

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
        matricula,
        nome,
        email,
        telefone,
        senha,
        cpf,
      } = req.body;

      const hashSenha = await bcrypt.hash(senha, 10);

      const dadoscreate = {
        adm_matricula: matricula,
        adm_nome: nome,
        adm_email: email,
        adm_tel: telefone,
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
  },


   async login(req, res) {
    try {
      const { email, senha } = req.body;

      if (!email || !senha) {
        return res.status(400).json({ erro: "E-mail e senha são obrigatórios" });
      }

      const secret = process.env.ACCESS_TOKEN_SECRET || 'sua_chave_secreta_fallback';

      const admin = await knex("administrador").where({ adm_email: email }).first();
      if (admin) {
        const senhaValida = await bcrypt.compare(senha, admin.adm_senha);
        if (senhaValida) {
          const token = jsonwebtoken.sign(
            { id: admin.adm_id, email: admin.adm_email, tipo: 'ADMIN' },
            secret,
            { expiresIn: "7d" }
          );
          return res.status(200).json({
            msg: "Autenticação realizada com sucesso",
            token,
            usuario: admin,
            tipo: "ADMIN"
          });
        }
      }
      // Se não encontrou usuário ou a senha estava errada
      return res.status(401).json({ msg: "E-mail ou senha inválidos" });

    } catch (erro) {
      console.error("ERRO NO LOGIN:", erro);
      return res.status(500).json({ erro: erro.message });
    }
  }
};

