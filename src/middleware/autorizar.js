import jsonwebtoken from "jsonwebtoken";

// Valida o token "Bearer" e coloca os dados do usuário em req.session.
// Não registra o token nem o conteúdo decodificado nos logs (dados pessoais).
export default (req, res, next) => {

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
