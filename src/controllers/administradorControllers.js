import knex from '../database/index.js';
import bcrypt from 'bcrypt';
import jsonwebtoken from 'jsonwebtoken';
import {
  coletarErros, formatarCPF, formatarTelefone, normalizarEmail, normalizarNome, somenteDigitos,
  validarConfirmacaoSenha, validarCPF, validarEmail, validarNome, validarObrigatorio,
  validarSenha, validarTelefone, whereCpf,
} from '../utils/validacoes.js';
import { registrarFalhaLogin, registrarSucessoLogin } from '../middleware/limiteLogin.js';

export default {

  // busca todos os administradores
  async administradorall(req, res) {
    try {
      const dados = (await knex('administrador')).map(({ adm_senha, ...resto }) => resto);
      return res.status(200).send(dados);
    } catch (error) {
      return res.status(500).send({
        message: 'Erro ao buscar administradores'
      });
    }
  },

async createadministrador(req, res) {
  try {
    const {
      matricula,
      nome,
      email,
      telefone,
      senha,
      confirmacao_senha,
      cpf,
      posto_id,  
    } = req.body ?? {};

    const erros = coletarErros(
      validarObrigatorio(matricula, "a matrícula"),
      validarNome(nome),
      validarEmail(email),
      validarTelefone(telefone),
      validarCPF(cpf),
      validarObrigatorio(posto_id, "a unidade de saúde"),
      validarSenha(senha),
      validarConfirmacaoSenha(senha, confirmacao_senha),
    );
    if (erros.length) {
      return res.status(400).json({ sucesso: false, erros });
    }

    const matriculaExiste = await knex('administrador')
      .where('adm_matricula', String(matricula).trim())
      .first();
    if (matriculaExiste) {
      return res.status(409).json({ erro: 'Matrícula já cadastrada' });
    }

    const emailExiste = await knex('administrador')
      .whereRaw('LOWER(adm_email) = ?', [normalizarEmail(email)])
      .first();
    if (emailExiste) {
      return res.status(409).json({ erro: 'E-mail já cadastrado' });
    }

    const cpfExiste = await knex('administrador')
      .whereRaw(...whereCpf('adm_cpf'), [somenteDigitos(cpf)])
      .first();
    if (cpfExiste) {
      return res.status(409).json({ erro: 'CPF já cadastrado' });
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
      adm_matricula: String(matricula).trim(),
      adm_nome: normalizarNome(nome),
      adm_email: normalizarEmail(email),
      adm_tel: formatarTelefone(telefone),
      adm_senha: hashSenha,
      adm_cpf: formatarCPF(cpf),
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
      erro: 'Erro ao criar administrador. Tente novamente.'
    });
  }
},


async loginGeral(req, res) {
    try {
        const { email, senha } = req.body;

        if (!email || !senha) {
            return res.status(400).json({
                erro: "E-mail e senha são obrigatórios"
            });
        }

        if (typeof email !== "string" || typeof senha !== "string" || validarEmail(email)) {
            return res.status(400).json({ erro: "Informe um e-mail válido." });
        }

        const emailNormalizado = normalizarEmail(email);

        const secret = process.env.ACCESS_TOKEN_SECRET;

        if (!secret) {
            console.error("ACCESS_TOKEN_SECRET não configurada");
            return res.status(500).json({
                erro: "Chave de autenticação não configurada"
            });
        }
const admin = await knex("administrador")
    .whereRaw("LOWER(adm_email) = ?", [emailNormalizado])
    .first();

const autorizador = await knex("autorizador")
    .whereRaw("LOWER(aut_email) = ?", [emailNormalizado])
    .first();

const paciente = await knex("pacientes")
    .whereRaw("LOWER(pac_email) = ?", [emailNormalizado])
    .first();

// 1. TENTA LOGIN COMO ADMINISTRADOR
       


        if (admin) {
            const senhaValida = await bcrypt.compare(
                senha,
                admin.adm_senha
            );

            if (senhaValida) {

                const token = jsonwebtoken.sign(
                    {
                        id: admin.adm_id,
                        email: admin.adm_email,
                        posto_id: admin.pos_id,
                        tp_universal: admin.tp_universal,
                        tipo: "ADMIN"
                    },
                    secret,
                    {
                        expiresIn: "7d"
                    }
                );

                registrarSucessoLogin(req);
                return res.status(200).json({
                    msg: "Autenticação realizada com sucesso",
                    token,

                    usuario: {
    adm_id: admin.adm_id,
    adm_nome: admin.adm_nome,
    adm_cpf: admin.adm_cpf,
    adm_email: admin.adm_email,
    adm_tel: admin.adm_tel,

    // informações necessárias para autorização
    posto_id: admin.pos_id,
    tp_universal: admin.tp_universal,

    tipo: "ADMIN"
}
                });
            }
        }


        
        

        if (autorizador) {
            const senhaValida = await bcrypt.compare(
                senha,
                autorizador.aut_senha
            );

            if (senhaValida) {

                const token = jsonwebtoken.sign(
                    {
                        id: autorizador.aut_id,
                        email: autorizador.aut_email,
                      
                        tipo: "AUTORIZADOR"
                    },
                    secret,
                    {
                        expiresIn: "7d"
                    }
                );

                registrarSucessoLogin(req);
                return res.status(200).json({
                    msg: "Autenticação realizada com sucesso",
                    token,

                    usuario: {
    aut_id: autorizador.aut_id,
    aut_nome: autorizador.aut_nome,
    aut_cpf: autorizador.aut_cpf,
    aut_email: autorizador.aut_email,
    aut_tel: autorizador.aut_tel,

    // informações necessárias para autorização
    

    tipo: "AUTORIZADOR"
}
                });
            }
        }

        // 2. TENTA LOGIN COMO PACIENTE
       

        if (paciente) {
            const senhaValida = await bcrypt.compare(
                senha,
                paciente.pac_senha
            );

            if (senhaValida) {

                const token = jsonwebtoken.sign(
                    {
                        id: paciente.pac_id,
                        email: paciente.pac_email,
                        tipo: "PACIENTE"
                    },
                    secret,
                    {
                        expiresIn: "7d"
                    }
                );

                registrarSucessoLogin(req);
                return res.status(200).json({
                    msg: "Autenticação realizada com sucesso",
                    token,

                    usuario: {
                pac_id: paciente.pac_id,
                pac_nome: paciente.pac_nome,
                pac_email: paciente.pac_email,
                pac_telefone: paciente.pac_telefone,
                pac_cpf: paciente.pac_cpf,
                pac_cep: paciente.pac_cep,
                pac_data_nasc: paciente.pac_data_nasc,
                pac_endereco: paciente.pac_endereco,
                pac_sexo: paciente.pac_sexo,
                pac_raca: paciente.pac_raca,
                tipo: "PACIENTE"
            },

                    tipo: "PACIENTE"
                });
            }
        }

       
        // NENHUM USUÁRIO ENCONTRADO
        

        const tentativasRestantes = registrarFalhaLogin(req);

        if (tentativasRestantes === 0) {
            return res.status(429).json({
                erro: "Muitas tentativas de login. Seu acesso foi bloqueado por 15 minutos.",
                tentar_novamente_em: 15 * 60
            });
        }

        return res.status(401).json({
            msg: "E-mail ou senha inválidos",
            tentativas_restantes: tentativasRestantes
        });

    } catch (error) {

        console.error("ERRO NO LOGIN:", error);

        return res.status(500).json({
            erro: "Erro interno ao fazer login. Tente novamente."
        });

      
      }}
};
