import 'dotenv/config';

const config = {
  development: {
    client: 'postgresql',
    connection: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    },
  }
};

export default config;