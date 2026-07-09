import knex from '../database/index.js';
import bcrypt from 'bcrypt'

export default  {
//busca todos os dados da tabela pacientes
  async pacientesall(req, res) {
    console.log("DADOS PARA INSERT:", dadoscreate);

try {
  await knex("pacientes").insert(dadoscreate);
  console.log("INSERT REALIZADO COM SUCESSO");
} catch (e) {
  console.error("ERRO NO INSERT:", e);
  throw e;
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
      senha
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
      pac_raca: raca || null
    };

    console.log("DADOS PARA INSERT:", dadoscreate);

    
    await knex('pacientes').insert(dadoscreate);

    console.log("SEXO ORIGINAL:", sexo);
console.log("SEXO FORMATADO:", sexoFormatado);

    res.status(201).json({ msg: "OK" });

  } catch (erro) {
    console.error(" ERRO NO BACKEND:", erro);
    res.status(500).json({ erro: erro.message });
  }
},
   

async login(req, res) {
  try {
    const { email, senha } = req.body;

    const usuario = await knex("pacientes")
      .where("pac_email", email)
      .first();

      console.log('usuarios nao encontrado:', usuario)

    if (!usuario) {
      return res.status(401).json({
        msg: "Email ou senha inválidos"
      });
    }
console.log(req.body);
    const senhaCorreta = await bcrypt.compare(
      senha,
      usuario.pac_senha

    );
    console.log("Senha correta:", senhaCorreta);

    if (!senhaCorreta) {
      return res.status(401).json({
        msg: "Email ou senha inválidos"
      });
    }

    return res.status(200).json({
      msg: "Login realizado com sucesso",
      usuario: {
        id: usuario.id,
        nome: usuario.pac_nome,
        email: usuario.pac_email
      }
      
    });
console.log("Senha válida:", senhaCorreta);
  } catch (erro) {
    return res.status(500).json({
      erro: erro.message
    });
  }
}

}