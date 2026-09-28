import knex from '../database/index.js';
import bcrypt from 'bcrypt';
import jsonwebtoken from 'jsonwebtoken';

export default {

  // busca todos os administradores
  async administradorall(req, res) {
    try {
      const dados = await knex('administrador'); 
      console.log(dados);
      return res.status(200).send(dados);
    } catch (error) {
      return res.status(500).send({
        message: 'Erro ao buscar administradores',
        error: error.message
      });
    }
  },

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
      posto_id,  
    } = req.body;

    const matriculaExiste = await knex('administrador')
      .where('adm_matricula', matricula)
      .first();
    if (matriculaExiste) {
      return res.status(400).json({ erro: 'Matrícula já cadastrada' });
    }

    const emailExiste = await knex('administrador')
      .where('adm_email', email)
      .first();
    if (emailExiste) {
      return res.status(400).json({ erro: 'Email já cadastrado' });
    }

    if (posto_id) {
      const postoExiste = await knex('postosdesaude')
        .where('pos_id', posto_id)
        .first();
      if (!postoExiste) {
        return res.status(400).json({ erro: 'Posto inválido' });
      }
    }

    const hashSenha = await bcrypt.hash(senha, 10);

    const dadoscreate = {
      adm_matricula: matricula,
      adm_nome: nome,
      adm_email: email,
      adm_tel: telefone,
      adm_senha: hashSenha,
      adm_cpf: cpf,
      pos_id: posto_id,  
      tp_universal: false, 
    };

    const result = await knex('administrador').insert(dadoscreate);

    return res.status(201).send({
      message: 'Administrador criado com sucesso',
      id: result[0],
      tp_universal: false,
      vinculado_a_posto: posto_id
    });

  } catch (error) {
    console.error('Erro ao criar administrador:', error);
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
            { id: admin.adm_id, email: admin.adm_email, posto: admin.pos_id, tp_universal: admin.tp_universal ,tipo: 'ADMIN' },
            secret,
            { expiresIn: "7d" }
          );
        return res.status(200).json({
          msg: "Autenticação realizada com sucesso",
          token,
          usuario: { id: admin.adm_id,
            email: admin.adm_email,
            nome: admin.adm_nome,
            matricula: admin.adm_matricula,
            telefone: admin.adm_tel,
            cpf: admin.adm_cpf,
            posto_id: admin.pos_id,          
            tp_universal: admin.tp_universal 
          },
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

