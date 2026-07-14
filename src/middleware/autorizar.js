import jsonwebtoken from "jsonwebtoken";

export default (req, res, next) => {

     try {
        console.log('Realizando Autentificação');
        const authHeader = req.headers.authorization;
        if(!authHeader) {
            return res.status(401).send({error: 'Token não fornecido'});
        }
        const partsToken = authHeader.split(' ');
        if (partsToken.length !=2){
            return res.status(401).send({error: 'Token inválido'});
        }

        const [scheme, token] = partsToken;
        if(!/^Bearer$/i.test(scheme)){
            return res.status(401).send({error: 'Token incoerente do padrão'});
        }
        const decode = jsonwebtoken.verify(token, process.env.ACCESS_TOKEN_SECRET);
        console.log('Token decodificado:');
        req.session = decode;
        return next();

    } catch (error) {
        if (error instanceof JsonWebTokenError) {
            return res.status(401).send({error: 'Token inválido'});
        }
        return res.status(500).send({error: 'Erro interno do servidor'});
    } 
   }
