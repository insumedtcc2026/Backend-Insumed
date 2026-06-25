import express from "express";
import cors from "cors";
import routes from "./routes.js"; // 1. Adicionada a extensão .js

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.json());
app.use(routes);

app.listen(3344, () => console.log(
    'Servidor ON na porta 3344'
));

export default app; // 2. Corrigido de 'server' para 'app'