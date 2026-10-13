import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import routes from "./routes.js";
import path from "path";


const app = express();

// Na Vercel a requisição passa por um proxy; isso faz req.ip ser o IP real do cliente
// (usado no limite de tentativas de login).
app.set("trust proxy", 1);

app.use(cors());

app.use(express.urlencoded({
    extended: true,
    limit: "10mb"
}));

app.use(express.json({
    limit: "10mb"
}));

app.use(
    express.static(
        path.join(import.meta.dirname, "..", "public")
    )
);

app.use(routes);

// Erros que acontecem antes dos controllers (JSON malformado, corpo grande
// demais) voltariam como página HTML do Express; aqui viram JSON em português.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    if (err?.type === "entity.too.large") {
        return res.status(413).json({ error: "Arquivo ou dados muito grandes. O limite é de 5 MB por prescrição." });
    }

    if (err?.type === "entity.parse.failed") {
        return res.status(400).json({ error: "Dados enviados em formato inválido." });
    }

    console.error("Erro não tratado:", err);
    return res.status(500).json({ error: "Erro interno do servidor. Tente novamente." });
});

// Nos testes automatizados (npm test) o app é usado sem abrir a porta.
if (process.env.NODE_ENV !== "test") {
    app.listen(3344, () => {
        console.log("Servidor ON na porta 3344");
    });
}

export default app;