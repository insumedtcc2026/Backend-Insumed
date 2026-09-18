import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import routes from "./routes.js";
import path from "path";

console.log("SECRET EXISTE?", !!process.env.ACCESS_TOKEN_SECRET);
console.log(
    "SECRET LENGTH:",
    process.env.ACCESS_TOKEN_SECRET?.length
);

const app = express();

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

app.listen(3344, () => {
    console.log("Servidor ON na porta 3344");
});

export default app;