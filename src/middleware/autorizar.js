import jsonwebtoken from "jsonwebtoken";


export default (req, res, next) => {

     try {
        console.log('Realizando Autentificação');
        const authHeader = req.headers.authorization;
         console.log("Authorization recebido:", authHeader);

        if(!authHeader) {
            return res.status(401).send({error: 'Token não fornecido'});
        }
        const partsToken = authHeader.split(' ');
         console.log("Partes do token:", partsToken.length);
        if (partsToken.length !=2){
            return res.status(401).send({error: 'Token inválido'});
        }

        const [scheme, token] = partsToken;
        if(!/^Bearer$/i.test(scheme)){
            return res.status(401).send({error: 'Token incoerente do padrão'});
        }
        const decode = jsonwebtoken.verify(token, process.env.ACCESS_TOKEN_SECRET);
        console.log('Token decodificado:');
        console.log("Token decodificado:", decode);
        req.session = decode;
        return next();

    } catch (error) {
        console.log("Erro JWT:", error);

        if (
            error.name === "JsonWebTokenError" ||
            error.name === "TokenExpiredError"
        ) {
            return res.status(401).send({
                error: "Token inválido ou expirado"
            });
        }

        return res.status(500).send({
            error: "Erro interno do servidor"
        });
    }
};
console.log("VERSAO NOVA DO MIDDLEWARE");