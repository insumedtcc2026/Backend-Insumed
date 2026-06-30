export default {
    async raiz(req, res){
        const html = `
                    <!DOCTYPE html>
                    <html lang="en">
                    <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>Servidor Backend - NodeJs</title>
                    </head>
                    <body>
                        <h2>Olá - este é o servidor do TCC INSUMED </h2>
                        <p> </p>
                        <h3>Rotas:</h3>
                        <h3>/ - Rota raiz</h3>
                        <h3>/pacientesall -  get / consulta de pacientes</h3>
                        <h3>/paciente - post / cadastro de pacientes</h3>
                    
                        <img src="https://img.icons8.com/?size=100&id=64097&format=png&color=000000" alt="">
                    </body>
                    </html>
                    
                `;

        return res.send(html);
    }
}

