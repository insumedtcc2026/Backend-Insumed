import jsonwebtoken from "jsonwebtoken";
import knex from "../database/index.js";

// Conta de admin ou autorizador marcada como inativa (adm_ativo / aut_ativo).
// Tokens antigos de admin não têm id: nesse caso a conta é achada pelo e-mail.
async function contaDesativada(sessao) {
    if (sessao?.tipo === "ADMIN") {
        const q = knex("administrador");
        if (sessao.id) q.where("adm_id", sessao.id);
        else q.whereRaw("LOWER(adm_email) = ?", [String(sessao.email ?? "").toLowerCase()]);
        return (await q.first("adm_ativo"))?.adm_ativo === false;
    }
    if (sessao?.tipo === "AUTORIZADOR") {
        const aut = await knex("autorizador").where("aut_id", sessao.id ?? null).first("aut_ativo");
        return aut?.aut_ativo === false;
    }
    return false;
}

// Valida o token "Bearer" e coloca os dados do usuário em req.session.
// Não registra o token nem o conteúdo decodificado nos logs (dados pessoais).
export default async (req, res, next) => {

    try {
        const authHeader = req.headers.authorization;

        if (!authHeader) {
            return res.status(401).send({ error: 'Token não fornecido' });
        }

        const partsToken = authHeader.split(' ');
        if (partsToken.length != 2) {
            return res.status(401).send({ error: 'Token inválido' });
        }

        const [scheme, token] = partsToken;
        if (!/^Bearer$/i.test(scheme)) {
            return res.status(401).send({ error: 'Token incoerente do padrão' });
        }

        const decode = jsonwebtoken.verify(token, process.env.ACCESS_TOKEN_SECRET, {
            algorithms: ["HS256"]
        });
        req.session = decode;

        // funcionário desativado pelo admin universal perde o acesso na hora,
        // mesmo com um token ainda dentro da validade
        if (await contaDesativada(decode)) {
            return res.status(401).send({ error: "Conta desativada. Procure a administração da rede de saúde." });
        }

        return next();

    } catch (error) {
        if (
            error.name === "JsonWebTokenError" ||
            error.name === "TokenExpiredError"
        ) {
            return res.status(401).send({
                error: "Token inválido ou expirado"
            });
        }

        console.error("Erro ao validar token:", error.name);

        return res.status(500).send({
            error: "Erro interno do servidor"
        });
    }
};
