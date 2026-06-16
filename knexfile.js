require ('dotenv').config();
const config ={
    development:{
        client:'postgresql',
        connection: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        },
        
    }
}

module.exports = config;