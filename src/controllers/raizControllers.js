module.exports = {
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
                        <h2>Olá - este é o servidor do 2 Info</h2>
                        <p> ana liviaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</p>
                        <h3>Rotas:</h3>
                        <h3>/ - Rota raiz</h3>
                        <h3>/fornecedorcod -  get / consulta de fornecedores ordenado por código</h3>
                        <h3>/fornecedornome - get / consulta de fornecedores ordenado por nome</h3>
                        <h3>/fornecedor - post / cadastro de fornecedores </h3>
                        <h3>/fornecedor/:codfor - put / alteração de fornecedores </h3>
                        <h3>/fornecedor/:codfor - delete / exclusão de fornecedores </h3>
                        <img src="https://img.icons8.com/?size=100&id=64097&format=png&color=000000" alt="">
                    </body>
                    </html>
                    
                `;

        return res.send(html);
    }
}

