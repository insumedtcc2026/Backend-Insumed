require ('dotenv').config();
const config ={
    development:{
        client:'postgresql',
        connection:{
            host: process.env.PGHOST,
            database: process.env.PGDATABASE,
            user: process.env.PGUSER,
            password: process.env.PGPASSWORD,
            ssl: true,
        }
    }
}

module.exports = config;