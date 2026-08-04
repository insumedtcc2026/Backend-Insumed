import knex from '../database/index.js';
import bcrypt from 'bcrypt'
import jsonwebtoken from 'jsonwebtoken';

export default  {
//busca todos os dados da tabela pacientes
  async pacientesall(req, res) {
    try {
      const nome = await knex('pacientes');
      console.log(nome);
      return res.status(200).send(nome);
    } catch (error) {
      res.status(500).send({ message: 'Erro ao buscar pacientes', error: error.message });
    }
  },


//cria um novo paciente
  async createpaciente(req, res) {
  try {
    

    console.log("BODY:", req.body);

    const {
      nome,
      email,
      telefone,
      cpf,
      data_nasc,
      sexo,
      endereco,
      raca,
      senha,
      cep
    } = req.body;
    const sexoLimpo = sexo?.trim().toLowerCase();

let sexoFormatado = null;
if (sexo?.toLowerCase() === "masculino") sexoFormatado = "M";
else if (sexo?.toLowerCase() === "feminino") sexoFormatado = "F";
else if (sexo?.toLowerCase() === "outro") sexoFormatado = "O";

    console.log("NOME:", nome);
    console.log("EMAIL:", email);
    console.log("SENHA:", senha);

    if (!senha) {
      throw new Error("Senha está undefined");
    }
//conecta com o frontend
    const hashSenha = await bcrypt.hash(senha, 10);

    const dadoscreate = {
      pac_nome: nome,
      pac_email: email,
      pac_telefone: telefone,
      pac_senha: hashSenha,
      pac_cpf: cpf,
      pac_data_nasc: data_nasc || null,
      pac_sexo: sexoFormatado || null,
      pac_endereco: endereco,
      pac_raca: raca || null,
      pac_cep: cep 
    };

    console.log("DADOS PARA INSERT:", dadoscreate);

    
    await knex('pacientes').insert(dadoscreate);

    console.log("SEXO ORIGINAL:", sexo);
console.log("SEXO FORMATADO:", sexoFormatado);

    res.status(201).json({ msg: "Usuasrio cadastrado com exito" });

  } catch (erro) {
    console.error(" ERRO NO BACKEND:", erro);
    res.status(500).json({ erro: erro.message });
  }
},
   

async login(req, res) {
  try {
    const { email, senha } = req.body;

    const usuario = await knex("pacientes")
      .where("pac_email", email).first();

    if (!usuario) {
      return res.status(401).json({
        msg: "Email ou senha inválidos"
      });
    }/*else{
      res.status(200).json({
        msg: "Usuario encontrado",
        usuario: usuario
      });
    } */
console.log(req.body);

    if(usuario != undefined){
      bcrypt.compare(senha, usuario.pac_senha, (err, respok) => {
        if (err) {
          return res.status(403).json({erro: "Erro ao comparar senhas"});
        }
        
        if (respok) {
          const token = jsonwebtoken.sign(
            { id: usuario.id, email: usuario.pac_email },
            process.env.ACCESS_TOKEN_SECRET,
            { expiresIn: '7d' }
          );
          return res.status(200).json({
            msg: "Autenticação realizada com sucesso",
            token: token,
            usuario: usuario
          });

          return res.status(401).send({
           alert: "Email ou senha inválidos!!!"
          });
        }
      })
    }
  } catch (erro) {
    return res.status(500).json({
      erro: erro.message
    });
  }
}

}