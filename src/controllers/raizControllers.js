import { error } from "console";
import path, { dirname } from "path";

export default {
    raiz(req,res) {
        const filePath = path.join(import.meta.dirname, '..','..','documents', 'api_documentacao.html');
        
        return res.sendFile(filePath, (err) => {
            if (err) {
                console.error('Erro ao enviar arquivo' , err);
                res.status(err.status || 500).send ({
                    msg: ' Erro ao carregar a pagina de documentação',
                    error: err.message

                });
            }
        });
    }
};